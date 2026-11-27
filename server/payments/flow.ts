// Payment flow: collect from the payer (through the partner) → pay out to the clinic.
// Idempotent: every partner call carries a unique key, and webhook updates on a final
// payment are ignored, so retries and duplicate webhooks can't pay twice.
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { one, run, tx, audit } from '../db.js';
import { getPartner, type PaymentUpdate } from './partners.js';
import { getBill, setStatus, event, notifyFamily } from '../bills.js';
import { notify } from '../messaging/index.js';
import { HttpError, notFound } from '../http.js';
import { round2 } from '../screening.js';
import type { BillRow, ClinicRow, PaymentKind, PaymentRow, PayMethod, UserRow } from '../types.js';

export const sandboxPayoutDelayMs = { value: Number(process.env.SANDBOX_PAYOUT_DELAY_MS ?? 1500) };

async function insertPayment(billId: string, kind: PaymentKind, amount: number, partner: string, attempt: number): Promise<PaymentRow> {
  const id = randomUUID();
  await run('INSERT INTO payments(id, bill_id, kind, amount_usd, partner, status, idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)',
    id, billId, kind, round2(amount), partner, 'pending', `${kind}:${billId}:${attempt}`);
  return (await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', id))!;
}
const attempts = async (billId: string, kind: PaymentKind): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) n FROM payments WHERE bill_id = $1 AND kind = $2', billId, kind))!.n;

const lockBill = (billId: string) => one<BillRow>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', billId);

export interface PayChoice { method: PayMethod; walletPhone: string | null }

export async function startPayment(billId: string, payer: UserRow, how: PayChoice = { method: 'card', walletPhone: null }): Promise<{ paymentId: string; checkoutUrl: string | null; method: PayMethod }> {
  const partner = getPartner();
  // The bill row is locked while the payment is created, so a double tap can't start two collections.
  const { bill, payment, clinic } = await tx(async () => {
    const b = await lockBill(billId);
    if (!b || b.payer_id !== payer.id) throw notFound();
    if (!['awaiting_payer', 'payment_failed'].includes(b.status)) throw new HttpError(409, 'not_payable');
    const p = await insertPayment(b.id, 'collection', b.total_usd + b.fee_usd, partner.name, (await attempts(b.id, 'collection')) + 1);
    await run('UPDATE payments SET method = $1, wallet_phone = $2 WHERE id = $3', how.method, how.walletPhone, p.id);
    p.method = how.method; p.wallet_phone = how.walletPhone;
    await setStatus(b.id, 'payment_pending');
    await event(b.id, payer.id, 'payment_started', `${round2(b.total_usd + b.fee_usd)} USD · ${how.method}`);
    const c = (await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', b.clinic_id))!;
    return { bill: b, payment: p, clinic: c };
  });
  try {
    const r = await partner.createCollection({ payment, payer, bill, clinic });
    await run('UPDATE payments SET partner_ref = $1, checkout_url = $2, updated_at = now() WHERE id = $3', r.partnerRef, r.checkoutUrl || null, payment.id);
    if (r.status !== 'pending') await applyPaymentUpdate({ paymentId: payment.id, status: r.status });
    return { paymentId: payment.id, checkoutUrl: r.checkoutUrl || null, method: how.method };
  } catch (e) {
    await applyPaymentUpdate({ paymentId: payment.id, status: 'failed', reason: (e as Error).message });
    Sentry.captureException(e, { tags: { area: 'payments', step: 'collection', partner: partner.name } });
    console.warn(`[payments] ${partner.name} refused the collection for ${bill.ref}: ${(e as Error).message}`);
    // 424, not 502: Cloudflare replaces an origin's 502 with its own "Bad gateway" page, hiding our answer.
    throw new HttpError(424, 'payment_partner_error', (e as Error).message);
  }
}

export async function startPayout(billId: string, actorId: string | null = null): Promise<void> {
  const partner = getPartner();
  const { bill, clinic, payment, collection } = await tx(async () => {
    const b = (await lockBill(billId))!;
    const c = (await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', b.clinic_id))!;
    const p = await insertPayment(b.id, 'payout', b.total_usd, partner.name, (await attempts(b.id, 'payout')) + 1);
    // The successful collection: some partners (FlexPay, direct mode) already paid the hospital with it.
    const col = await one<PaymentRow>("SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", b.id);
    await setStatus(b.id, 'paying_out');
    await event(b.id, actorId, 'payout_started', c.payout_account);
    return { bill: b, clinic: c, payment: p, collection: col || null };
  });
  try {
    const r = await partner.createPayout({ payment, clinic, bill, collection });
    await run('UPDATE payments SET partner_ref = $1, updated_at = now() WHERE id = $2', r.partnerRef, payment.id);
    if (r.status !== 'pending') await applyPaymentUpdate({ paymentId: payment.id, status: r.status });
    else if (r.autoComplete) {
      setTimeout(() => {
        applyPaymentUpdate({ paymentId: payment.id, status: 'succeeded' }).catch((e) => {
          console.error('[payout]', e);
          Sentry.captureException(e, { tags: { area: 'payments', step: 'sandbox_payout' } });
        });
      }, sandboxPayoutDelayMs.value);
    }
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'payments', step: 'payout', partner: partner.name } });
    await applyPaymentUpdate({ paymentId: payment.id, status: 'failed', reason: (e as Error).message });
  }
}

/** Called by partner webhooks (and the sandbox). Safe to call more than once. */
export async function applyPaymentUpdate({ paymentId, partnerRef, status, reason }: PaymentUpdate): Promise<PaymentRow> {
  const payment = paymentId
    ? await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', paymentId)
    : await one<PaymentRow>('SELECT * FROM payments WHERE partner_ref = $1', partnerRef);
  if (!payment) throw notFound();
  // A card payment marked failed (the payer came back through "cancel") that FlexPaie later confirms as paid:
  // the money is real, so it counts. If the bill was paid another way meanwhile, an admin refunds one of them.
  if (payment.kind === 'collection' && payment.status === 'failed' && status === 'succeeded') return lateSuccess(payment);
  if (payment.status !== 'pending' || status === 'pending') return payment; // already final, or no change
  const res = await run("UPDATE payments SET status = $1, failure_reason = $2, updated_at = now() WHERE id = $3 AND status = 'pending'",
    status, reason || null, payment.id);
  if (res.changes === 0) return payment; // another update won the race
  const bill = (await getBill(payment.bill_id))!;

  if (payment.kind === 'collection') {
    if (status === 'succeeded') {
      await event(bill.id, null, 'payment_received', payment.partner_ref || '');
      await startPayout(bill.id);
    } else {
      await setStatus(bill.id, 'payment_failed');
      await event(bill.id, null, 'payment_failed', reason || '');
    }
  } else if (payment.kind === 'payout') {
    if (status === 'succeeded') {
      await setStatus(bill.id, 'paid');
      await event(bill.id, null, 'paid_to_clinic', payment.partner_ref || '');
      const clinic = (await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', bill.clinic_id))!;
      if (clinic.whatsapp_phone) {
        await notify('clinicPaid', { to: clinic.whatsapp_phone, kind: 'clinic_paid', lang: 'fr', params: {
          amount: `$${round2(bill.total_usd).toFixed(2)}`, account: clinic.payout_account, ref: payment.partner_ref, patient: bill.patient_name } });
      }
      await notifyFamily(bill, 'paid');
    } else {
      // Money was collected but not delivered: needs an operator. Never silently retry a payout.
      await setStatus(bill.id, 'payout_failed');
      await event(bill.id, null, 'payout_failed', reason || '');
      await audit(null, 'payout_failed', `${bill.ref}: ${reason || ''}`);
      Sentry.captureMessage(`Payout failed for ${bill.ref}`, { level: 'error', tags: { area: 'payments', step: 'payout' } });
    }
  }
  return (await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', payment.id))!;
}

export async function retryPayout(billId: string, admin: UserRow): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill) throw notFound();
  if (bill.status !== 'payout_failed') throw new HttpError(409, 'not_payout_failed');
  await audit(admin.id, 'payout_retry', bill.ref);
  await startPayout(bill.id, admin.id);
  return (await getBill(bill.id))!;
}

async function lateSuccess(payment: PaymentRow): Promise<PaymentRow> {
  const res = await run("UPDATE payments SET status = 'succeeded', failure_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'failed'", payment.id);
  if (res.changes === 0) return payment;
  const bill = (await getBill(payment.bill_id))!;
  const other = await one("SELECT 1 FROM payments WHERE bill_id = $1 AND kind = 'collection' AND id <> $2 AND status IN ('pending','succeeded')", bill.id, payment.id);
  if (bill.status === 'payment_failed' && !other) {
    await event(bill.id, null, 'payment_received', payment.partner_ref || '');
    await startPayout(bill.id);
  } else {
    await audit(null, 'late_payment_refund', `${bill.ref}: ${payment.partner_ref} confirmed after the bill moved on (${bill.status}); refund one payment`);
    Sentry.captureMessage(`Late payment on ${bill.ref}: refund needed`, { level: 'error', tags: { area: 'payments' } });
  }
  return (await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', payment.id))!;
}

/**
 * The payer is back from the partner's page (or the app checks a payment still pending): ask the partner
 * for the real state. Back through "cancel" or "declined" on the card page while the partner still says
 * pending: nothing was charged, so the attempt ends and the payer can try again (a late confirmation
 * would still count, see lateSuccess).
 */
/** A pending payment can be given up by the payer after this long, and ends by itself after ABANDON_MIN. */
export const RETRY_AFTER_MIN = 2;
export const ABANDON_MIN = 15;
export async function refreshPayment(billId: string, payer: UserRow, result: unknown): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill || bill.payer_id !== payer.id) throw notFound();
  const p = await one<PaymentRow>("SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'pending' ORDER BY created_at DESC LIMIT 1", bill.id);
  const partner = getPartner();
  if (!p || p.partner !== partner.name || !partner.confirm) return bill;
  // The partner's status service can be slow or unreachable: then we simply don't know yet (pending).
  let update: PaymentUpdate = { paymentId: p.id, status: 'pending' };
  try { update = await partner.confirm(p, update); } catch (e) { console.warn(`[payments] status check for ${bill.ref} failed: ${(e as Error).message}`); }
  console.log(`[payments] ${bill.ref}: payer back (${String(result || 'check')}), ${partner.name} says ${update.status}`);
  if (update.status !== 'pending') await applyPaymentUpdate({ ...update, paymentId: p.id });
  else {
    const ageMin = Number((await one<{ m: number }>('SELECT EXTRACT(EPOCH FROM now() - created_at) / 60 m FROM payments WHERE id = $1', p.id))!.m);
    // The payer left the card page through Cancel / Declined, or says it didn't go through ("retry", offered
    // after RETRY_AFTER_MIN), or nobody finished it in ABANDON_MIN: nothing was charged, the payer can pay again.
    // A confirmation that still arrives later counts (lateSuccess).
    const reason = p.method === 'card' && result === 'cancel' ? 'Card payment cancelled on the payment page'
      : p.method === 'card' && result === 'decline' ? 'Card declined on the payment page'
      : result === 'retry' && ageMin >= RETRY_AFTER_MIN ? 'Not completed (the payer chose to try again)'
      : ageMin >= ABANDON_MIN ? `Not completed within ${ABANDON_MIN} minutes`
      : null;
    if (reason) await applyPaymentUpdate({ paymentId: p.id, status: 'failed', reason });
  }
  return (await getBill(bill.id))!;
}
