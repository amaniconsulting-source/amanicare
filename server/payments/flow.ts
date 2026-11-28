// Payment flow: collect from the payer (through the partner) → pay out to the clinic.
// Idempotent: every partner call carries a unique key, and webhook updates on a final
// payment are ignored, so retries and duplicate webhooks can't pay twice.
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { one, all, run, tx, audit } from '../db.js';
import { getPartner, type PaymentUpdate } from './partners.js';
import { getBill, setStatus, event, notifyFamily } from '../bills.js';
import { notify, send } from '../messaging/index.js';
import { HttpError, notFound } from '../http.js';
import { round2 } from '../screening.js';
import { isTransferApp, type BillRow, type ClinicRow, type PaymentKind, type PaymentRow, type PayMethod, type UserRow } from '../types.js';

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
  if (isTransferApp(how.method)) return startTransfer(billId, payer, how.method);
  const partner = getPartner();
  await noSecondCharge(billId, payer);
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
    // The successful collection: some partners (FlexPay, direct mode) already paid the hospital with it.
    const col = await one<PaymentRow>("SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", b.id);
    const p = await insertPayment(b.id, 'payout', b.total_usd, col?.partner === 'transfer' ? 'transfer' : partner.name, (await attempts(b.id, 'payout')) + 1);
    await setStatus(b.id, 'paying_out');
    await event(b.id, actorId, 'payout_started', c.payout_account);
    return { bill: b, clinic: c, payment: p, collection: col || null };
  });
  // Paid with a transfer app: the money went straight to the hospital, which confirmed it. Nothing to send.
  if (collection?.partner === 'transfer') {
    await run('UPDATE payments SET partner_ref = $1, updated_at = now() WHERE id = $2', `direct:transfer:${collection.id}`, payment.id);
    await applyPaymentUpdate({ paymentId: payment.id, status: 'succeeded' });
    return;
  }
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
    await event(bill.id, null, 'double_payment', `${round2(payment.amount_usd).toFixed(2)} USD · ${payment.partner_ref || ''}`);
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
export const RETRY_AFTER_MIN = 5;
export const ABANDON_MIN = 15;
export async function refreshPayment(billId: string, payer: UserRow, result: unknown): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill || bill.payer_id !== payer.id) throw notFound();
  const partner = getPartner();
  const p = await one<PaymentRow>("SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'pending' ORDER BY created_at DESC LIMIT 1", bill.id);
  if (!p) {
    // Nothing pending: an attempt the app gave up on in the last 24 hours may still have gone through
    // (e.g. approved, but the return link was misread). Ask once more; a success counts (lateSuccess).
    await recheckGivenUp(bill.id, partner);
    return (await getBill(bill.id))!;
  }
  if (p.partner !== partner.name || !partner.confirm) return bill;
  // The partner's status service can be slow or unreachable: then we simply don't know yet (pending).
  let update: PaymentUpdate = { paymentId: p.id, status: 'pending' };
  try { update = await partner.confirm(p, update); } catch (e) { console.warn(`[payments] status check for ${bill.ref} failed: ${(e as Error).message}`); }
  if (result || update.status !== 'pending') console.log(`[payments] ${bill.ref}: payer back (${String(result || 'check')}), ${partner.name} says ${update.status}`);
  if (result === 'approve') await run('UPDATE payments SET returned_approved = 1 WHERE id = $1', p.id);
  if (update.status !== 'pending') await applyPaymentUpdate({ ...update, paymentId: p.id });
  else if (p.returned_approved || result === 'approve') {
    // Accepted on the card page: never given up. Past a day without the partner's answer, an admin checks.
    const ageH = Number((await one<{ h: number }>('SELECT EXTRACT(EPOCH FROM now() - created_at) / 3600 h FROM payments WHERE id = $1', p.id))!.h);
    if (ageH >= 24 && !(await one("SELECT 1 FROM audit WHERE action = 'payment_unconfirmed' AND detail LIKE $1", `${bill.ref}:%`))) {
      await audit(null, 'payment_unconfirmed', `${bill.ref}: card approved on ${partner.name}'s page ${Math.floor(ageH)} h ago, still no confirmation: check the partner's dashboard`);
      Sentry.captureMessage(`Approved card payment unconfirmed for ${bill.ref}`, { level: 'warning', tags: { area: 'payments' } });
    }
  } else {
    const ageMin = Number((await one<{ m: number }>('SELECT EXTRACT(EPOCH FROM now() - created_at) / 60 m FROM payments WHERE id = $1', p.id))!.m);
    // The payer left the card page through Cancel / Declined / the browser's Back button, or says it didn't go through ("retry", offered
    // after RETRY_AFTER_MIN), or nobody finished it in ABANDON_MIN: nothing was charged, the payer can pay again.
    // A confirmation that still arrives later counts (lateSuccess).
    // Back through "approve": the payment page says it went through. Never end it: wait for the partner.
    const reason = result === 'approve' ? null
      : p.method === 'card' && result === 'cancel' ? 'Card payment cancelled on the payment page'
      : p.method === 'card' && result === 'back' ? 'Card payment page left with the Back button'
      : p.method === 'card' && result === 'decline' ? 'Card declined on the payment page'
      : result === 'retry' && ageMin >= RETRY_AFTER_MIN ? 'Not completed (the payer chose to try again)'
      : ageMin >= ABANDON_MIN ? `Not completed within ${ABANDON_MIN} minutes`
      : null;
    if (reason) {
      await applyPaymentUpdate({ paymentId: p.id, status: 'failed', reason });
      await run('UPDATE payments SET ended_by_app = 1 WHERE id = $1', p.id);
    }
  }
  return (await getBill(bill.id))!;
}

/**
 * Never charge twice. Before a new attempt, every earlier attempt the app gave up on itself (not one the partner
 * refused) is asked about once more: if one went through after all, it counts, the bill goes on to the hospital,
 * and the new attempt is refused. Attempts the partner still calls "pending" stay given up: card pages and
 * mobile-money prompts expire, and a confirmation that arrives later is handled by lateSuccess.
 */
async function noSecondCharge(billId: string, payer: UserRow): Promise<void> {
  const partner = getPartner();
  const bill = await getBill(billId);
  if (!bill || bill.payer_id !== payer.id || !partner.confirm) return;
  const earlier = await all<PaymentRow>(`SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'failed'
    AND ended_by_app = 1 AND partner = $2 AND partner_ref IS NOT NULL ORDER BY created_at DESC LIMIT 5`, bill.id, partner.name);
  for (const p of earlier) {
    let r: PaymentUpdate = { paymentId: p.id, status: 'pending' };
    try { r = await partner.confirm({ ...p, status: 'pending' }, r); } catch (e) { console.warn(`[payments] re-check of ${p.id} failed: ${(e as Error).message}`); }
    if (r.status === 'succeeded') {
      await applyPaymentUpdate({ paymentId: p.id, status: 'succeeded' });
      throw new HttpError(409, 'already_paid');
    }
  }
}

async function recheckGivenUp(billId: string, partner: ReturnType<typeof getPartner>): Promise<void> {
  if (!partner.confirm) return;
  const recent = await all<PaymentRow>(`SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND status = 'failed' AND ended_by_app = 1
    AND partner = $2 AND partner_ref IS NOT NULL AND created_at >= now() - interval '24 hours' ORDER BY created_at DESC LIMIT 3`, billId, partner.name);
  for (const p of recent) {
    let r: PaymentUpdate = { paymentId: p.id, status: 'pending' };
    try { r = await partner.confirm({ ...p, status: 'pending' }, r); } catch (e) { console.warn(`[payments] re-check of ${p.id} failed: ${(e as Error).message}`); }
    console.log(`[payments] re-check of given-up ${p.id} (${p.partner_ref}): ${r.status}`);
    if (r.status === 'succeeded') { await applyPaymentUpdate({ paymentId: p.id, status: 'succeeded' }); return; }
  }
}

/**
 * Every few minutes, without waiting for anyone to open a page: ask the partner about payments still pending,
 * and about attempts the app gave up on in the last 24 hours (one may have gone through after all).
 * Callbacks that never arrive, and return links that were misread, are caught this way.
 */
export async function sweepPayments(): Promise<void> {
  const partner = getPartner();
  if (!partner.confirm) return;
  const bills = await all<{ bill_id: string; payer_id: string }>(`SELECT DISTINCT p.bill_id, b.payer_id FROM payments p JOIN bills b ON b.id = p.bill_id
    WHERE p.kind = 'collection' AND p.partner = $1 AND p.partner_ref IS NOT NULL AND p.created_at >= now() - interval '24 hours'
      AND (p.status = 'pending' OR (p.status = 'failed' AND p.ended_by_app = 1)) LIMIT 50`, partner.name);
  if (bills.length) console.log(`[payments] sweep: ${bills.length} bill(s) to check`);
  for (const { bill_id, payer_id } of bills) {
    try { await refreshPayment(bill_id, { id: payer_id } as UserRow, undefined); }
    catch (e) { console.warn(`[payments] sweep of ${bill_id}: ${(e as Error).message}`); }
  }
}

/**
 * Admin: ask the partner about one collection, whatever the app thinks of it, and apply the answer.
 * A success counts even if the app had marked the attempt failed (lateSuccess).
 */
export async function adminCheckPayment(paymentId: string, admin: UserRow): Promise<{ status: string; partnerSays: string }> {
  const p = await one<PaymentRow>("SELECT * FROM payments WHERE id = $1 AND kind = 'collection'", paymentId);
  if (!p) throw notFound();
  const partner = getPartner();
  if (p.partner !== partner.name || !partner.confirm || !p.partner_ref) return { status: p.status, partnerSays: 'no partner reference to check' };
  const r = await partner.confirm({ ...p, status: 'pending' }, { paymentId: p.id, status: 'pending' });
  await audit(admin.id, 'payment_check', `${p.id}: ${partner.name} says ${r.status}`);
  if (r.status === 'succeeded' && p.status !== 'succeeded') await applyPaymentUpdate({ paymentId: p.id, status: 'succeeded' });
  else if (r.status === 'failed' && p.status === 'pending') await applyPaymentUpdate({ paymentId: p.id, status: 'failed', reason: r.reason });
  const now = (await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', p.id))!;
  return { status: now.status, partnerSays: r.status };
}

/**
 * Admin: the partner's dashboard shows this payment as received but its status service doesn't say so.
 * After checking the dashboard, an admin records it as received (audited, with a note); the bill goes on.
 */
export async function adminMarkReceived(paymentId: string, admin: UserRow, note: unknown): Promise<string> {
  const p = await one<PaymentRow>("SELECT * FROM payments WHERE id = $1 AND kind = 'collection'", paymentId);
  if (!p) throw notFound();
  if (p.status === 'succeeded') return p.status;
  const why = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (why.length < 3) throw new HttpError(400, 'note_required');
  const other = await one("SELECT 1 FROM payments WHERE bill_id = $1 AND kind = 'collection' AND id <> $2 AND status = 'succeeded'", p.bill_id, p.id);
  if (other) throw new HttpError(409, 'already_paid');
  await audit(admin.id, 'payment_mark_received', `${p.id} (${p.partner_ref || '-'}): ${why}`);
  await applyPaymentUpdate({ paymentId: p.id, status: 'succeeded' });
  return (await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', p.id))!.status;
}

// ---------- Pilot: pay with a transfer app (Taptap Send, Sendwave, WorldRemit) ----------
// The payer sends the bill amount from their usual app straight to the hospital's mobile-money wallet; AmaniCare
// never touches the money. The hospital's "received" completes the payment; the payer's "I sent it" is optional.
// No AmaniCare fee on this route during the pilot (decided 27 Nov 2026): the payer pays the bill and the app's own fee.

export interface TransferDestination { name: string; number: string; operator: string }

/** Where a transfer app should send: the hospital's mobile-money wallet, in the name registered on it. */
export function transferDestination(c: Pick<ClinicRow, 'name' | 'payout_method' | 'payout_account' | 'payout_phone' | 'transfer_name'>): TransferDestination | null {
  const wallet = ['mpesa', 'orange', 'airtel'].includes(c.payout_method) && c.payout_account ? { number: c.payout_account, operator: c.payout_method }
    : c.payout_phone ? { number: c.payout_phone, operator: '' } : null;
  return wallet ? { name: c.transfer_name || c.name, ...wallet } : null;
}

const APP_NAMES: Record<string, string> = { taptap: 'Taptap Send', sendwave: 'Sendwave', worldremit: 'WorldRemit' };

async function tellClinic(bill: BillRow, text: string, kind: string): Promise<void> {
  const c = await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', bill.clinic_id);
  if (c?.whatsapp_phone) await send({ to: c.whatsapp_phone, kind, text }).catch((e) => console.warn(`[transfer] ${kind}: ${(e as Error).message}`));
}

async function startTransfer(billId: string, payer: UserRow, app: PayMethod): Promise<{ paymentId: string; checkoutUrl: null; method: PayMethod }> {
  const { bill, payment } = await tx(async () => {
    const b = await lockBill(billId);
    if (!b || b.payer_id !== payer.id) throw notFound();
    if (!['awaiting_payer', 'payment_failed'].includes(b.status)) throw new HttpError(409, 'not_payable');
    const c = (await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', b.clinic_id))!;
    if (!transferDestination(c)) throw new HttpError(409, 'no_transfer_destination');
    const p = await insertPayment(b.id, 'collection', b.total_usd, 'transfer', (await attempts(b.id, 'collection')) + 1);
    await run('UPDATE payments SET method = $1 WHERE id = $2', app, p.id);
    await setStatus(b.id, 'payment_pending');
    await event(b.id, payer.id, 'transfer_expected', `${round2(b.total_usd)} USD · ${APP_NAMES[app] || app}`);
    return { bill: b, payment: p };
  });
  await tellClinic(bill, `AmaniCare · Paiement attendu : $${round2(bill.total_usd).toFixed(2)} de ${payer.name} par ${APP_NAMES[app] || app}, facture ${bill.bill_number || bill.ref} (${bill.patient_name}), référence ${bill.ref}. Dès que l'argent arrive sur votre compte mobile money, confirmez-le dans AmaniCare (Paiements attendus).`, 'clinic_transfer_expected');
  return { paymentId: payment.id, checkoutUrl: null, method: app };
}

const pendingTransfer = (billId: string) =>
  one<PaymentRow>("SELECT * FROM payments WHERE bill_id = $1 AND kind = 'collection' AND partner = 'transfer' AND status = 'pending' ORDER BY created_at DESC LIMIT 1", billId);

/** The payer says the transfer is sent (optional), with the app's transfer number if they have it. */
export async function transferSent(billId: string, payer: UserRow, note: unknown): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill || bill.payer_id !== payer.id) throw notFound();
  const p = await pendingTransfer(bill.id);
  if (!p) throw new HttpError(409, 'no_pending_transfer');
  const n = typeof note === 'string' ? note.trim().slice(0, 120) : '';
  await run('UPDATE payments SET transfer_sent_at = now(), transfer_note = $2, updated_at = now() WHERE id = $1', p.id, n);
  await event(bill.id, payer.id, 'transfer_sent', n);
  await tellClinic(bill, `AmaniCare · ${payer.name} indique avoir envoyé $${round2(p.amount_usd).toFixed(2)} pour la facture ${bill.bill_number || bill.ref} (${bill.patient_name})${n ? `, transfert n° ${n}` : ''}. Vérifiez votre compte mobile money et confirmez dans AmaniCare.`, 'clinic_transfer_sent');
  return (await getBill(bill.id))!;
}

/** The payer changes their mind (e.g. to pay by card) while the hospital hasn't confirmed. */
export async function transferCancel(billId: string, payer: UserRow): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill || bill.payer_id !== payer.id) throw notFound();
  const p = await pendingTransfer(bill.id);
  if (!p) throw new HttpError(409, 'no_pending_transfer');
  await applyPaymentUpdate({ paymentId: p.id, status: 'failed', reason: 'Transfer cancelled by the payer' });
  await tellClinic(bill, `AmaniCare · Le paiement par transfert pour la facture ${bill.bill_number || bill.ref} (${bill.patient_name}) n'est plus attendu. Si de l'argent arrive quand même, signalez-le à AmaniCare.`, 'clinic_transfer_cancelled');
  return (await getBill(bill.id))!;
}

/** The hospital confirms the money arrived on its wallet (received) or says it didn't (not received). */
export async function transferAnswer(billId: string, clinicUser: UserRow, received: boolean): Promise<BillRow> {
  const bill = await getBill(billId);
  if (!bill || !clinicUser.clinic_id || bill.clinic_id !== clinicUser.clinic_id) throw notFound();
  const p = await pendingTransfer(bill.id);
  if (!p) throw new HttpError(409, 'no_pending_transfer');
  await event(bill.id, clinicUser.id, received ? 'transfer_received' : 'transfer_not_received');
  await audit(clinicUser.id, received ? 'transfer_received' : 'transfer_not_received', `${bill.ref}: ${p.amount_usd} USD`);
  await applyPaymentUpdate(received
    ? { paymentId: p.id, status: 'succeeded' }
    : { paymentId: p.id, status: 'failed', reason: 'The hospital has not received the transfer' });
  return (await getBill(bill.id))!;
}

/** A transfer nobody has confirmed after a day: the team follows up (once). */
export async function sweepTransfers(): Promise<void> {
  const late = await all<{ ref: string; id: string }>(`SELECT b.ref, p.id FROM payments p JOIN bills b ON b.id = p.bill_id
    WHERE p.partner = 'transfer' AND p.kind = 'collection' AND p.status = 'pending' AND p.created_at < now() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.action = 'transfer_unconfirmed' AND a.detail LIKE b.ref || ':%')`);
  for (const t of late) await audit(null, 'transfer_unconfirmed', `${t.ref}: transfer expected for over 24 h, not confirmed by the hospital: call the payer and the hospital`);
}
