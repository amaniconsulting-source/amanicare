// Deterministic bill screening. Pure functions: easy to test and to explain to partners.
// The AI only reads the photo; every decision here is a rule with a fixed number of points.
import type { AiBill, BillItem, ClinicRow, Currency, Price, RiskLevel } from './types.js';

export interface ScreeningSettings {
  cdfPerUsd: number;
  priceFlagRatio: number;
  feePct: number;
  feeMinUsd: number;
  reviewAboveUsd: number;
}

export const DEFAULT_SETTINGS: ScreeningSettings = {
  cdfPerUsd: 2850,        // demo exchange rate, editable by admins
  priceFlagRatio: 1.8,    // item price above this multiple of the reference → flag
  feePct: 0.03,           // service fee (3 %)
  feeMinUsd: 2,
  reviewAboveUsd: 500,
};

export const LEVELS: Record<RiskLevel, [number, number]> = { low: [0, 29], med: [30, 59], high: [60, 100] };

export const normalize = (s: unknown): string =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

type PriceRef = Pick<Price, 'name' | 'keywords' | 'usd' | 'scope'>;

// Bills use no common item codes, so items are recognised from their description only.
// `prices` must be ordered from most to least specific (facility, facility type, general):
// the first match wins, so a facility's own price overrides the general one.
export function findReference<P extends PriceRef>(description: string, prices: P[]): P | null {
  // Keywords match at the start of a word: "consult" matches "Consultation", "nfs" matches "NFS".
  const d = ' ' + normalize(description).replace(/[^a-z0-9]+/g, ' ');
  return prices.find((r) => r.keywords.some((k) => {
    const nk = normalize(k).replace(/[^a-z0-9]+/g, ' ').trim();
    return nk && d.includes(' ' + nk);
  })) || null;
}

export const toUsd = (amount: number, currency: Currency, s: Pick<ScreeningSettings, 'cdfPerUsd'>): number =>
  (currency === 'CDF' ? amount / s.cdfPerUsd : amount);
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const feeFor = (usd: number, s: Pick<ScreeningSettings, 'feeMinUsd' | 'feePct'>): number =>
  round2(Math.max(s.feeMinUsd, usd * s.feePct));

export interface ScreenInput {
  clinicId?: string;
  billNumber: string;
  patientName?: string;
  currency: Currency;
  items: BillItem[];
  total: number;
  edited: boolean;
  ai: Partial<Pick<AiBill, 'clinic_name' | 'tamper_flags' | 'tamper_flags_fr'>> | null;
}
export interface ScreenContext {
  clinic: Pick<ClinicRow, 'name' | 'active'> | null | undefined;
  prices?: PriceRef[];
  settings?: Partial<ScreeningSettings>;
  duplicates: number;
  recentForPatient: number;
  /** Earlier bills with exactly the same photo. */
  duplicatePhotos?: number;
  /** Earlier bills at the same clinic for the same patient and the same total (last 30 days). */
  similarRecent?: number;
}
export interface Reason { code: string; points: number; params: Record<string, unknown> }
export interface ScreenResult { score: number; level: RiskLevel; reasons: Reason[]; expectedUsd: number; totalUsd: number }

export function screenBill(bill: ScreenInput, ctx: ScreenContext): ScreenResult {
  const s: ScreeningSettings = { ...DEFAULT_SETTINGS, ...(ctx.settings || {}) };
  const reasons: Reason[] = [];
  const add = (code: string, points: number, params: Record<string, unknown> = {}) => reasons.push({ code, points, params });

  if (!ctx.clinic || !ctx.clinic.active) add('clinic_not_registered', 40);
  if (ctx.duplicates > 0) add('duplicate_bill_number', 50, { billNumber: bill.billNumber });
  if ((ctx.duplicatePhotos || 0) > 0) add('duplicate_photo', 50);
  // Same clinic, patient and amount: likely the same bill with a different (or no) number.
  else if (!ctx.duplicates && (ctx.similarRecent || 0) > 0) add('similar_recent_bill', 30);

  let expected = 0;
  let unknown = 0;
  for (const it of bill.items) {
    const unit = toUsd(it.p, bill.currency, s);
    const ref = findReference(it.d, ctx.prices || []);
    if (!ref) { unknown++; expected += unit * it.q; continue; }
    expected += ref.usd * it.q;
    const ratio = unit / ref.usd;
    const params = { item: it.d, unitUsd: round2(unit), refUsd: ref.usd, ratio: round2(ratio), refName: ref.name, refScope: ref.scope || 'general' };
    if (ratio > 3) add('price_far_above_reference', 25, params);
    else if (ratio > s.priceFlagRatio) add('price_above_reference', 12, params);
  }

  const sum = bill.items.reduce((a, i) => a + i.q * i.p, 0);
  if (bill.total > 0 && Math.abs(sum - bill.total) / bill.total > 0.02) {
    add('total_mismatch', 20, { itemsSum: round2(sum), total: round2(bill.total), currency: bill.currency });
  }

  const aiClinic = bill.ai?.clinic_name;
  if (aiClinic && ctx.clinic && !clinicNamesMatch(aiClinic, ctx.clinic.name)) {
    add('clinic_name_mismatch', 15, { onPhoto: aiClinic, selected: ctx.clinic.name });
  }
  if (bill.edited) add('edited_after_ai', 10);
  // The AI's observations add up to 20 points at most: they prompt a check, they don't decide alone.
  (bill.ai?.tamper_flags || []).forEach((flag, i) => add('ai_tamper_flag', i < 2 ? 10 : 0, bill.ai?.tamper_flags_fr?.[i] ? { flag, flag_fr: bill.ai.tamper_flags_fr[i] } : { flag }));
  if (ctx.recentForPatient >= 2) add('frequent_patient', 15, { count: ctx.recentForPatient + 1 });

  const totalUsd = toUsd(bill.total || sum, bill.currency, s);
  if (totalUsd > s.reviewAboveUsd) add('high_amount', 10, { limitUsd: s.reviewAboveUsd });
  if (unknown) add('unknown_items', 0, { count: unknown });

  const score = Math.min(100, reasons.reduce((a, r) => a + r.points, 0));
  const level: RiskLevel = score >= LEVELS.high[0] ? 'high' : score >= LEVELS.med[0] ? 'med' : 'low';
  return { score, level, reasons, expectedUsd: round2(expected), totalUsd: round2(totalUsd) };
}

// Names match if they share a distinctive word (ignoring generic words like "clinique", "centre").
const GENERIC = new Set(['centre', 'center', 'clinique', 'clinic', 'hopital', 'hospital', 'medical', 'de', 'du', 'la', 'le', 'des', 'sante', 'polyclinique', 'cabinet', 'general', 'et']);
// A possible duplicate is never sent straight to the clinic: a person checks it first.
export const DUPLICATE_CODES = ['duplicate_bill_number', 'duplicate_photo', 'similar_recent_bill'];
export const mustReview = (r: Pick<ScreenResult, 'level' | 'reasons'>): boolean =>
  r.level === 'high' || r.reasons.some((x) => DUPLICATE_CODES.includes(x.code));

export function clinicNamesMatch(a: string, b: string): boolean {
  const words = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  const wa = new Set(words(a));
  const wb = words(b);
  if (!wa.size || !wb.length) return true; // nothing distinctive to compare: don't penalize
  return wb.some((w) => wa.has(w));
}

// Detects whether the family changed what the AI read (compared item by item and on the total).
export function wasEdited(
  aiSnapshot: Pick<AiBill, 'items' | 'total'> | null | undefined,
  submitted: { items: BillItem[]; total: number },
): boolean {
  if (!aiSnapshot) return false;
  const key = (items: { d: string; q: number; p: number }[]) =>
    JSON.stringify(items.map((i) => [normalize(i.d), Number(i.q), round2(Number(i.p))]));
  const aiItems = (aiSnapshot.items || []).map((i) => ({ d: i.description, q: i.qty, p: i.unit_price }));
  if (key(aiItems) !== key(submitted.items)) return true;
  return Math.abs(round2(Number(aiSnapshot.total || 0)) - round2(submitted.total)) > 0.009;
}
