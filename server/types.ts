// Row shapes as returned by node-postgres (see the type parsers in db.ts:
// BIGINT and NUMERIC come back as numbers, TIMESTAMPTZ as 'YYYY-MM-DD HH:MM:SS' UTC strings).

export type Role = 'payer' | 'family' | 'clinic' | 'admin';
export type Lang = 'fr' | 'en' | 'ln' | 'sw';
export type Currency = 'USD' | 'CDF';
export type RiskLevel = 'low' | 'med' | 'high';
export type BillStatus =
  | 'review' | 'awaiting_clinic' | 'awaiting_payer' | 'payment_pending' | 'paying_out'
  | 'paid' | 'payment_failed' | 'payout_failed' | 'rejected' | 'declined';
export const CATEGORIES = ['health_centre', 'clinic', 'hospital', 'diagnostic', 'pharmacy'] as const;
export type Category = (typeof CATEGORIES)[number];
export type PriceScope = 'clinic' | 'category' | 'general';
export type PaymentKind = 'collection' | 'payout';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface UserRow {
  id: string; phone: string; name: string; role: Role; lang: Lang; clinic_id: string | null; created_at: string;
}
export interface OtpRow {
  phone: string; code_hash: string; expires_at: number; attempts: number; sent_count: number; window_start: number;
}
export interface SessionRow { token_hash: string; user_id: string; expires_at: number }
export interface ClinicRow {
  id: string; name: string; commune: string; city: string; whatsapp_phone: string; payout_method: string;
  payout_account: string; trust: number; active: number; category: Category; created_at: string;
}
export interface InviteRow { code: string; payer_id: string; relation: string; expires_at: number; used_by: string | null; phone: string | null }
export interface PriceRow { id: string; name: string; keywords: string; usd: number; category: Category | null; clinic_id: string | null }
export interface Price { id?: string; name: string; keywords: string[]; usd: number; scope?: PriceScope }
export interface DraftRow { id: string; family_id: string; photo_path: string; ai: string | null; photo_sha256: string | null; created_at: string }

export interface BillItem { d: string; q: number; p: number }

export interface BillRow {
  id: string; ref: string; family_id: string; payer_id: string; clinic_id: string; patient_name: string;
  bill_number: string; bill_date: string; currency: Currency; items: string; total: number; total_usd: number;
  fee_usd: number; expected_usd: number; ai: string | null; edited: number; risk_score: number; risk_level: RiskLevel;
  risk_reasons: string; status: BillStatus; photo_path: string | null; photo_sha256: string | null; created_at: string; updated_at: string;
}

export interface PaymentRow {
  id: string; bill_id: string; kind: PaymentKind; amount_usd: number; partner: string; partner_ref: string | null;
  status: PaymentStatus; checkout_url: string | null; idempotency_key: string; failure_reason: string | null;
  created_at: string; updated_at: string;
}

/** What the AI read from a bill photo (after sanitizing). */
export interface AiBill {
  clinic_name: string; bill_number: string; date: string; patient_name: string; currency: Currency;
  items: { description: string; qty: number; unit_price: number }[];
  total: number; tamper_flags: string[]; confidence: number;
}
