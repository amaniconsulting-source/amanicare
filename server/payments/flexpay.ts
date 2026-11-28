// FlexPaie adapter (pilot / proof of concept while the bank partnership is set up).
// FlexPaie (formerly FlexPay) is a Congolese payment aggregator (INFOSET SARL, authorized by the Banque
// Centrale du Congo): one API for M-Pesa, Orange Money, Airtel Money, Afrimoney and Visa/Mastercard.
//
// Follows FlexPaie's "API de Paiement Corporate" v2.0 and "API de Vérification de Transaction" v2.0
// (23 May 2026). Those documents are confidential: keep them out of the repository.
//  - Mobile money and card both POST to <base>/api/rest/v1/paymentService (type "1" mobile, "2" card).
//  - The answer carries FlexPaie's orderNumber (and, for cards, the hosted card page `url`).
//  - FlexPaie POSTs the result to callback_url. Callbacks are not signed, so the app only trusts
//    GET <checkBase>/api/rest/v1/check/{orderNumber}, for the order number it stored itself.
//
// Two ways money can flow, chosen per hospital:
//  1. Direct (preferred): the hospital has its own FlexPaie merchant code (clinics.flexpay_merchant).
//     The payer's money is collected straight into the hospital's FlexPaie account. AmaniCare never
//     holds the money, so the payout step completes at once.
//  2. Through AmaniCare: no merchant code yet. The money is collected into AmaniCare's merchant account
//     (FLEXPAY_MERCHANT), then paid out to the hospital's mobile-money number. That payout API is not in
//     the v2.0 documents: until FlexPaie sends it (FLEXPAY_PAYOUT_URL), the payout fails with a clear
//     reason and an admin pays the hospital from the FlexPaie dashboard.
import { config } from '../config.js';
import { audit } from '../db.js';
import type { PaymentPartner, PartnerResult, PaymentUpdate } from './partners.js';
import type { ClinicRow, PaymentRow, PaymentStatus } from '../types.js';

const paymentUrl = () => `${config.flexpay.baseUrl}/api/rest/v1/paymentService`;
const checkUrl = (orderNumber: string) => `${config.flexpay.checkBaseUrl}/api/rest/v1/check/${encodeURIComponent(orderNumber)}`;

function assertConfigured(): void {
  const f = config.flexpay;
  if (!f.token || !f.merchant || !f.baseUrl) {
    throw new Error('FlexPaie not configured: set FLEXPAY_TOKEN, FLEXPAY_MERCHANT and FLEXPAY_BASE_URL');
  }
}

/** FlexPaie expects phone numbers as digits without '+', e.g. 243812345678. */
export const flexpayPhone = (p: string): string => p.replace(/\D/g, '');

/**
 * Transaction status from FlexPaie's check API:
 * 0 succeeded · 1 failed · 2 pending · 3 to be refunded · 4 refunded · 5 cancelled by the merchant.
 */
export function flexpayStatus(code: unknown): PaymentStatus {
  const c = String(code ?? '').trim();
  if (c === '0') return 'succeeded';
  if (c === '2' || c === '') return 'pending';
  return 'failed';
}

const STATUS_REASON: Record<string, string> = {
  '1': 'Payment did not go through (FlexPaie)',
  '3': 'Payment is being refunded to the payer (FlexPaie)',
  '4': 'Payment was refunded to the payer (FlexPaie)',
  '5': 'Payment was cancelled (FlexPaie)',
};

const merchantFor = (clinic: ClinicRow): { code: string; direct: boolean } =>
  clinic.flexpay_merchant ? { code: clinic.flexpay_merchant, direct: true } : { code: config.flexpay.merchant, direct: false };

const callbackUrl = () => `${config.baseUrl}/api/webhooks/payments/flexpay`;

/** FlexPaie's own words when it refuses, or (no message) what it actually answered, for the logs. */
const why = (r: any): string => r?.message || r?.Message || r?.error || `unexpected answer ${JSON.stringify(r ?? null).slice(0, 300)}`;

async function post(url: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.flexpay.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual', // a redirect would turn the POST into an empty GET: report it instead
  });
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) throw new Error(`FlexPaie ${res.status}: redirected to ${res.headers.get('location') || '?'} (check FLEXPAY_BASE_URL)`);
  if (!text.trim()) throw new Error(`FlexPaie answered ${res.status} with an empty body (content-type ${res.headers.get('content-type') || 'none'}): check the token, the merchant code and that the account is active for this service`);
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`FlexPaie ${res.status}: ${data?.message || text.slice(0, 300) || 'error'}`);
  return data;
}

export interface FlexpayCheck { status: PaymentStatus; code: string; reference: string; amount: number; currency: string; channel: string }

/** Ask FlexPaie for the real state of a transaction (used to confirm callbacks). */
export async function flexpayCheck(orderNumber: string): Promise<FlexpayCheck> {
  const unknown: FlexpayCheck = { status: 'pending', code: '', reference: '', amount: NaN, currency: '', channel: '' };
  const res = await fetch(checkUrl(orderNumber), {
    headers: { authorization: `Bearer ${config.flexpay.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* not JSON: logged below */ }
  const t = data?.transaction;
  // Pilot: every status answer is logged (short), to see exactly what FlexPaie says.
  console.log(`[flexpay] check ${orderNumber}: HTTP ${res.status} ${text.slice(0, 400) || '(empty)'}`);
  if (!res.ok || String(data?.code) !== '0' || !t) {
    console.warn(`[flexpay] check ${orderNumber}: HTTP ${res.status} ${text.slice(0, 300) || '(empty)'}`);
    return unknown;
  }
  return {
    status: flexpayStatus(t.status), code: String(t.status ?? ''), reference: String(t.reference ?? ''),
    amount: Number(t.amount), currency: String(t.currency ?? '').toUpperCase(), channel: String(t.channel ?? ''),
  };
}

export const flexpayPartner: PaymentPartner = {
  name: 'flexpay',

  async createCollection({ payment, clinic }): Promise<PartnerResult> {
    assertConfigured();
    const { code } = merchantFor(clinic);
    const common = { merchant: code, reference: payment.id, amount: payment.amount_usd.toFixed(2), currency: 'USD', callback_url: callbackUrl() };
    if (payment.method && payment.method !== 'card') {
      // Mobile money: FlexPaie pushes a request to the payer's wallet; they approve with their PIN.
      // TODO(flexpay): AmaniCare's commission when paying a hospital's own merchant account (to agree with FlexPaie).
      const r = await post(paymentUrl(), { ...common, type: '1', phone: flexpayPhone(payment.wallet_phone || '') });
      if (String(r?.code) !== '0' || !r?.orderNumber) throw new Error(`FlexPaie refused the request: ${why(r)}`);
      return { partnerRef: String(r.orderNumber), status: 'pending' };
    }
    // Card: FlexPaie's hosted card page (AmaniCare never sees card details). The payer comes back to the app.
    // The payer comes back to the app, which then asks FlexPaie for the real state (see refreshPayment).
    const back = (result: string) => `${config.baseUrl}/?bill=${encodeURIComponent(payment.bill_id)}&pay=${result}`;
    const r = await post(paymentUrl(), { ...common, type: '2', approve_url: back('approve'), cancel_url: back('cancel'), decline_url: back('decline') });
    if (String(r?.code) !== '0' || !r?.url || !r?.orderNumber) throw new Error(`FlexPaie refused the card payment: ${why(r)}`);
    return { partnerRef: String(r.orderNumber), status: 'pending', checkoutUrl: String(r.url) };
  },

  async createPayout({ payment, clinic, collection }): Promise<PartnerResult> {
    // Direct: the money was collected into the hospital's own FlexPaie account. Nothing to send.
    if (collection?.partner === 'flexpay' && clinic.flexpay_merchant) {
      return { partnerRef: `direct:${collection.partner_ref || collection.id}`, status: 'succeeded' };
    }
    assertConfigured();
    if (!config.flexpay.payoutUrl) {
      throw new Error(`${clinic.name} has no FlexPaie merchant code: pay it by hand from the FlexPaie dashboard, or add its merchant code in Admin → Hospitals`);
    }
    if (clinic.payout_method === 'bank' || !clinic.payout_phone) {
      throw new Error(`${clinic.name} has no FlexPaie merchant code and no mobile-money payout number: pay it by hand from the FlexPaie dashboard, or add one in Admin → Hospitals`);
    }
    const r = await post(config.flexpay.payoutUrl, {
      merchant: config.flexpay.merchant, type: '1', phone: flexpayPhone(clinic.payout_phone),
      reference: payment.id, amount: payment.amount_usd.toFixed(2), currency: 'USD', callback_url: callbackUrl(),
    });
    if (String(r?.code) !== '0' || !r?.orderNumber) throw new Error(`FlexPaie refused the payout: ${why(r)}`);
    return { partnerRef: String(r.orderNumber), status: 'pending' };
  },

  // FlexPaie callbacks carry no signature: accept the request, then trust only the check API.
  verifyWebhook: () => true,

  parseWebhook(b: any): PaymentUpdate {
    return {
      paymentId: typeof b?.reference === 'string' ? b.reference : undefined,
      partnerRef: b?.orderNumber ? String(b.orderNumber) : undefined,
      status: String(b?.code ?? '') === '0' ? 'succeeded' : b?.code === undefined ? 'pending' : 'failed',
      reason: b?.message ? String(b.message) : undefined,
    };
  },

  // Never trust the callback's own fields: check the order number WE stored for this payment, and that
  // FlexPaie's answer names this payment, for the amount and currency we asked. A forged callback can't
  // point at someone else's transaction, and a smaller payment can't settle a bigger bill (it stays pending
  // and is written to the audit log for an admin).
  async confirm(payment: PaymentRow, update: PaymentUpdate): Promise<PaymentUpdate> {
    const pending: PaymentUpdate = { paymentId: payment.id, status: 'pending' };
    if (!payment.partner_ref || payment.partner_ref.startsWith('direct:')) return pending;
    // Cards: the payment service answers with one order number, but FlexPaie's card gateway (gwvisa) runs the
    // payment under its own (the hex id in the card page address, also in its return links). Ask with both.
    const gw = payment.checkout_url?.match(/\/([0-9a-f]{24,})(?:[/?#]|$)/i)?.[1];
    let r = await flexpayCheck(payment.partner_ref);
    if (r.status === 'pending' && gw && gw !== payment.partner_ref) {
      const g = await flexpayCheck(gw);
      if (g.code || g.reference) r = g;
    }
    // FlexPaie's check answers with its own order number as "reference" (not ours, unlike its documentation).
    // Either is fine: we asked about the order number WE stored for this payment.
    const ref = r.reference.trim().toLowerCase();
    const ours = [payment.id, payment.partner_ref, gw].filter(Boolean).map((x) => String(x).toLowerCase());
    if (ref && !ours.includes(ref)) {
      console.warn(`[flexpay] ${payment.partner_ref} names reference ${r.reference}, expected ${payment.id} or ${payment.partner_ref}: ignored`);
      return pending;
    }
    if (r.status === 'succeeded') {
      const sameAmount = Number.isFinite(r.amount) && Math.abs(r.amount - payment.amount_usd) < 0.005;
      if (!sameAmount || (r.currency && r.currency !== 'USD')) {
        // Money may have moved, so don't call it failed (the payer could pay twice): keep it pending for an admin.
        await audit(null, 'flexpay_amount_mismatch', { paymentId: payment.id, orderNumber: payment.partner_ref, reported: `${r.amount} ${r.currency}`, expected: `${payment.amount_usd.toFixed(2)} USD` });
        return pending;
      }
      return { paymentId: payment.id, status: 'succeeded' };
    }
    if (r.status === 'failed') return { paymentId: payment.id, status: 'failed', reason: STATUS_REASON[r.code] || update.reason || 'Refused (FlexPaie)' };
    return pending;
  },
};
