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
  const { bill, payment } = await tx(async () => {
    const b = await lockBill(billId);
    if (!b || b.payer_id !== payer.id) throw notFound();
    if (!['awaiting_payer', 'payment_failed'].includes(b.status)) throw new HttpError(409, 'not_payable');
    const p = await insertPayment(b.id, 'collection', b.total_usd + b.fee_usd, partner.name, (await attempts(b.id, 'collection')) + 1);
    await run('UPDATE payments SET method = $1, wallet_phone = $2 WHERE id = $3', how.method, how.walletPhone, p.id);
    p.method = how.method; p.wallet_phone = how.walletPhone;
    await setStatus(b.id, 'payment_pending');
    await event(b.id, payer.id, 'payment_started', `${round2(b.total_usd + b.fee_usd)} USD · ${how.method}`);
    return { bill: b, payment: p };
  });
  try {
    const r = await partner.createCollection({ payment, payer, bill });
    await run('UPDATE payments SET partner_ref = $1, checkout_url = $2, updated_at = now() WHERE id = $3', r.partnerRef, r.checkoutUrl || null, payment.id);
    if (r.status !== 'pending') await applyPaymentUpdate({ paymentId: payment.id, status: r.status });
    return { paymentId: payment.id, checkoutUrl: r.checkoutUrl || null, method: how.method };
  } catch (e) {
    await applyPaymentUpdate({ paymentId: payment.id, status: 'failed', reason: (e as Error).message });
    Sentry.captureException(e, { tags: { area: 'payments', step: 'collection', partner: partner.name } });
    throw new HttpError(502, 'payment_partner_error', (e as Error).message);
  }
}

export async function startPayout(billId: string, actorId: string | null = null): Promise<void> {
  const partner = getPartner();
  const { bill, clinic, payment } = await tx(async () => {
    const b = (await lockBill(billId))!;
    const c = (await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', b.clinic_id))!;
    const p = await insertPayment(b.id, 'payout', b.total_usd, partner.name, (await attempts(b.id, 'payout')) + 1);
    await setStatus(b.id, 'paying_out');
    await event(b.id, actorId, 'payout_started', c.payout_account);
    return { bill: b, clinic: c, payment: p };
  });
  try {
    const r = await partner.createPayout({ payment, clinic, bill });
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
