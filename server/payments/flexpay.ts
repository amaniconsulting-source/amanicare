// FlexPay adapter (pilot / proof of concept while the bank partnership is set up).
// FlexPay is a Congolese payment aggregator (INFOSET SARL, authorized by the Banque Centrale du Congo):
// one API for M-Pesa, Orange Money, Airtel Money, Afrimoney and Visa/Mastercard.
//
// Two ways money can flow, chosen per hospital:
//  1. Direct (preferred): the hospital has its own FlexPay merchant code (clinics.flexpay_merchant).
//     The payer's money is collected straight into the hospital's FlexPay account, which the hospital
//     withdraws to its bank or wallet whenever it wants. AmaniCare never holds the money, so the
//     payout step completes at once. AmaniCare's fee: FlexPay's commission split (to confirm with FlexPay).
//  2. Through AmaniCare: no merchant code yet. The money is collected into AmaniCare's merchant account
//     (FLEXPAY_MERCHANT) and paid out to the hospital's mobile-money number (clinics.payout_phone).
//     Bank payouts are not offered by the API: those fail with a clear reason for an operator.
//
// Request and response fields follow FlexPay's published client libraries. Confirm them against the
// documentation FlexPay sends with your merchant credentials, and adjust here if they differ.
// FlexPay callbacks are not signed, so every callback is re-checked with FlexPay's status API (confirm).
import { config } from '../config.js';
import type { PaymentPartner, PartnerResult, PaymentUpdate } from './partners.js';
import type { ClinicRow, PaymentRow, PaymentStatus } from '../types.js';

// Production endpoints as published in FlexPay's client libraries. FlexPay's test (sandbox) addresses come
// with your test credentials: set them with the FLEXPAY_*_URL variables.
const DEFAULT_URLS = {
  payment: 'https://corporateapi.flexpay.cd/api/rest/v1/paymentService',
  card: 'https://cardpayment.flexpay.cd/api/rest/v1/vpos/ask',
  check: 'https://apicheck.flexpaie.com/api/rest/v1/check',
  payout: 'https://backend.flexpay.cd/api/rest/v1/merchantPayOutService',
};

function urls() {
  const f = config.flexpay;
  return { payment: f.paymentUrl || DEFAULT_URLS.payment, card: f.cardUrl || DEFAULT_URLS.card,
    check: f.checkUrl || DEFAULT_URLS.check, payout: f.payoutUrl || DEFAULT_URLS.payout };
}

function assertConfigured(): void {
  if (!config.flexpay.token || !config.flexpay.merchant) {
    throw new Error('FlexPay not configured: set FLEXPAY_TOKEN and FLEXPAY_MERCHANT');
  }
}

/** FlexPay expects phone numbers as digits without '+', e.g. 243812345678. */
export const flexpayPhone = (p: string): string => p.replace(/\D/g, '');

/** FlexPay status codes: "0" success, "1" failed, anything else still pending. */
export function flexpayStatus(code: unknown): PaymentStatus {
  const c = String(code ?? '');
  return c === '0' ? 'succeeded' : c === '1' ? 'failed' : 'pending';
}

const merchantFor = (clinic: ClinicRow): { code: string; direct: boolean } =>
  clinic.flexpay_merchant ? { code: clinic.flexpay_merchant, direct: true } : { code: config.flexpay.merchant, direct: false };

const callbackUrl = () => `${config.baseUrl}/api/webhooks/payments/flexpay`;

async function post(url: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.flexpay.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`FlexPay ${res.status}: ${data?.message || 'error'}`);
  return data;
}

/** Ask FlexPay for the real state of a transaction (used to confirm callbacks). */
export async function flexpayCheck(orderNumber: string): Promise<{ status: PaymentStatus; reference: string }> {
  const res = await fetch(`${urls().check}/${encodeURIComponent(orderNumber)}`, {
    headers: { authorization: `Bearer ${config.flexpay.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || String(data?.code) !== '0' || !data?.transaction) return { status: 'pending', reference: '' };
  return { status: flexpayStatus(data.transaction.status), reference: String(data.transaction.reference ?? '') };
}

export const flexpayPartner: PaymentPartner = {
  name: 'flexpay',

  async createCollection({ payment, clinic }): Promise<PartnerResult> {
    assertConfigured();
    const { code } = merchantFor(clinic);
    const amount = payment.amount_usd.toFixed(2);
    if (payment.method && payment.method !== 'card') {
      // Mobile money: FlexPay pushes a request to the payer's wallet; they approve with their PIN.
      // TODO(flexpay): add AmaniCare's commission here once FlexPay confirms how the split is passed.
      const r = await post(urls().payment, {
        merchant: code, type: '1', phone: flexpayPhone(payment.wallet_phone || ''),
        reference: payment.id, amount, currency: 'USD', callbackUrl: callbackUrl(),
      });
      if (String(r?.code) !== '0' || !r?.orderNumber) throw new Error(`FlexPay refused the request: ${r?.message || 'unknown error'}`);
      return { partnerRef: String(r.orderNumber), status: 'pending' };
    }
    // Card: FlexPay's hosted card page (AmaniCare never sees card details).
    const back = `${config.baseUrl}/`;
    const r = await post(urls().card, {
      authorization: `Bearer ${config.flexpay.token}`, merchant: code, reference: payment.id, amount, currency: 'USD',
      description: 'AmaniCare hospital bill', callback_url: callbackUrl(),
      approve_url: back, cancel_url: back, decline_url: back, home_url: back,
    });
    if (String(r?.code) !== '0' || !r?.url) throw new Error(`FlexPay refused the card payment: ${r?.message || 'unknown error'}`);
    return { partnerRef: String(r.orderNumber || ''), status: 'pending', checkoutUrl: String(r.url) };
  },

  async createPayout({ payment, clinic, collection }): Promise<PartnerResult> {
    // Direct: the money was collected into the hospital's own FlexPay account. Nothing to send.
    if (collection?.partner === 'flexpay' && clinic.flexpay_merchant) {
      return { partnerRef: `direct:${collection.partner_ref || collection.id}`, status: 'succeeded' };
    }
    assertConfigured();
    if (clinic.payout_method === 'bank' || !clinic.payout_phone) {
      throw new Error(`${clinic.name} has no FlexPay merchant code and no mobile-money payout number: pay it by hand from the FlexPay dashboard, or add one in Admin → Hospitals`);
    }
    const r = await post(urls().payout, {
      merchant: config.flexpay.merchant, type: '1', phone: flexpayPhone(clinic.payout_phone),
      reference: payment.id, amount: payment.amount_usd.toFixed(2), currency: 'USD', callbackUrl: callbackUrl(),
    });
    if (String(r?.code) !== '0' || !r?.orderNumber) throw new Error(`FlexPay refused the payout: ${r?.message || 'unknown error'}`);
    return { partnerRef: String(r.orderNumber), status: 'pending' };
  },

  // FlexPay callbacks carry no signature: accept the request, then trust only FlexPay's status API (confirm).
  verifyWebhook: () => true,

  parseWebhook(b: any): PaymentUpdate {
    return {
      paymentId: typeof b?.reference === 'string' ? b.reference : undefined,
      partnerRef: b?.orderNumber ? String(b.orderNumber) : undefined,
      status: flexpayStatus(b?.code),
      reason: b?.message ? String(b.message) : undefined,
    };
  },

  // Never trust the callback's own fields: check the order number WE stored for this payment, and that
  // FlexPay's answer names this payment, so a forged callback can't point at someone else's transaction.
  async confirm(payment: PaymentRow, update: PaymentUpdate): Promise<PaymentUpdate> {
    const pending: PaymentUpdate = { paymentId: payment.id, status: 'pending' };
    if (!payment.partner_ref || payment.partner_ref.startsWith('direct:')) return pending;
    const r = await flexpayCheck(payment.partner_ref);
    if (r.reference && r.reference !== payment.id) return pending;
    return { paymentId: payment.id, status: r.status, reason: r.status === 'failed' ? update.reason || 'Refused (FlexPay)' : undefined };
  },
};

