// Payment partner adapters. AmaniCare never holds customer money: a licensed partner
// (the bank, acting as gateway) collects from the payer, by bank card or by mobile money
// (payment.method, from payment.wallet_phone), and pays out to the facility's bank account
// or mobile wallet (clinic.payout_method: bank, mpesa, orange, airtel). Every partner implements PaymentPartner.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { config } from '../config.js';
import type { BillRow, ClinicRow, PaymentRow, PaymentStatus, UserRow } from '../types.js';
import { flexpayPartner } from './flexpay.js';

export interface PartnerResult { partnerRef: string; status: PaymentStatus; checkoutUrl?: string; autoComplete?: boolean }
export interface PaymentUpdate { paymentId?: string; partnerRef?: string; status: PaymentStatus; reason?: string }

export interface PaymentPartner {
  name: string;
  createCollection(args: { payment: PaymentRow; payer: UserRow; bill: BillRow; clinic: ClinicRow }): Promise<PartnerResult>;
  createPayout(args: { payment: PaymentRow; clinic: ClinicRow; bill: BillRow; collection: PaymentRow | null }): Promise<PartnerResult>;
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  parseWebhook(json: any): PaymentUpdate;
  /** Optional: re-check an update with the partner's own status API before trusting it (for unsigned callbacks). */
  confirm?(payment: PaymentRow, update: PaymentUpdate): Promise<PaymentUpdate>;
}

export function hmacHex(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function verifyHmac(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const sig = String(headers['x-signature'] || '');
  const expected = hmacHex(config.paymentWebhookSecret, rawBody);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const genericParse = (b: any): PaymentUpdate => ({
  paymentId: b?.payment_id, partnerRef: b?.partner_ref,
  status: ['succeeded', 'failed', 'pending'].includes(b?.status) ? b.status : 'pending',
  reason: b?.reason,
});

// --- Sandbox: simulates a licensed partner. Collections go through a fake checkout page;
// payouts complete on their own after a short delay. Safe for demos and the pilot pitch.
export const sandboxPartner: PaymentPartner = {
  name: 'sandbox',
  async createCollection({ payment }) {
    // Card: the partner's hosted card page. Mobile money: the partner pushes a payment request to the
    // wallet phone, which the payer approves with their PIN; the sandbox page simulates that phone.
    return {
      partnerRef: `SBX-C-${payment.id.slice(-8).toUpperCase()}`,
      status: 'pending',
      checkoutUrl: `/sandbox-checkout.html?p=${encodeURIComponent(payment.id)}`,
    };
  },
  async createPayout({ payment }) {
    return { partnerRef: `SBX-P-${payment.id.slice(-8).toUpperCase()}`, status: 'pending', autoComplete: true };
  },
  verifyWebhook: verifyHmac,
  parseWebhook: genericParse,
};

// --- Equity BCDC (placeholder). Fill in once the partnership provides API documentation and
// sandbox credentials. Equity Group's developer platform (Jenga API, by Finserve) is one possible
// route; confirm which collection/payout APIs cover the DRC. Until then this adapter refuses to run.
function assertEquityConfigured(): void {
  const e = config.equity;
  if (!e.apiBase || !e.clientId || !e.clientSecret) {
    throw new Error('Equity partner not configured: set EQUITY_API_BASE, EQUITY_CLIENT_ID, EQUITY_CLIENT_SECRET');
  }
}

export const equityPartner: PaymentPartner = {
  name: 'equity',
  async createCollection(/* { payment, payer, bill } */) {
    assertEquityConfigured();
    // TODO(partner): collect payment.amount_usd with payment.id as the merchant reference.
    //  - payment.method 'card': create a hosted card checkout; return { partnerRef, status:'pending', checkoutUrl }.
    //  - 'mpesa' | 'orange' | 'airtel': push a payment request to payment.wallet_phone on that network
    //    (the payer approves with their PIN); return { partnerRef, status:'pending' } with no checkoutUrl.
    //    The result arrives by webhook.
    throw new Error('Equity collection API not implemented yet');
  },
  async createPayout(/* { payment, clinic, bill } */) {
    assertEquityConfigured();
    // TODO(partner): pay payment.amount_usd to clinic.payout_account (bank account or mobile-money
    // merchant wallet), reference payment.id, and return { partnerRef, status:'pending' }.
    throw new Error('Equity payout API not implemented yet');
  },
  verifyWebhook: verifyHmac, // TODO(partner): replace with the partner's real signature scheme
  parseWebhook: genericParse, // TODO(partner): map the partner's payload fields
};

const PARTNERS: Record<string, PaymentPartner> = { sandbox: sandboxPartner, equity: equityPartner, flexpay: flexpayPartner };

export const hasPartner = (name: string): boolean => Object.hasOwn(PARTNERS, name);

export function getPartner(name: string = config.paymentPartner): PaymentPartner {
  const p = Object.hasOwn(PARTNERS, name) ? PARTNERS[name] : undefined;
  if (!p) throw new Error(`Unknown payment partner: ${name}`);
  return p;
}
