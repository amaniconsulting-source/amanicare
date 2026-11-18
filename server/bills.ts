// Bill lifecycle: draft (photo + AI read) → screened bill → clinic confirmation → payer payment.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { one, all, run, tx, getSetting, audit } from './db.js';
import { screenBill, wasEdited, mustReview, DEFAULT_SETTINGS, feeFor, round2, type ScreeningSettings, type Reason } from './screening.js';
import { extractBill } from './ai.js';
import { notify, send } from './messaging/index.js';
import { bad, forbidden, notFound, HttpError, str, num, oneOf, type Body } from './http.js';
import type { AiBill, BillItem, BillRow, BillStatus, ClinicRow, DraftRow, Price, PriceRow, UserRow } from './types.js';

export const STATUSES: BillStatus[] = ['review', 'awaiting_clinic', 'awaiting_payer', 'payment_pending', 'paying_out',
  'paid', 'payment_failed', 'payout_failed', 'rejected', 'declined'];

export const settings = async (): Promise<ScreeningSettings> =>
  ({ ...DEFAULT_SETTINGS, ...(await getSetting<Partial<ScreeningSettings>>('screening', {})) });
export type PriceView = Omit<PriceRow, 'keywords'> & Price;
const parsePrice = (p: PriceRow): PriceView => ({
  ...p, keywords: JSON.parse(p.keywords) as string[], scope: p.clinic_id ? 'clinic' : p.category ? 'category' : 'general',
});
/** All reference prices (every scope). */
export const prices = async (): Promise<PriceView[]> =>
  (await all<PriceRow>('SELECT * FROM reference_prices ORDER BY name')).map(parsePrice);
/** The prices that apply to one facility, most specific first: its own, its type's, then general. */
export const pricesFor = async (clinic: Pick<ClinicRow, 'id' | 'category'>): Promise<PriceView[]> =>
  (await all<PriceRow>(`SELECT * FROM reference_prices
     WHERE clinic_id = $1 OR (clinic_id IS NULL AND category = $2) OR (clinic_id IS NULL AND category IS NULL)
     ORDER BY CASE WHEN clinic_id IS NOT NULL THEN 0 WHEN category IS NOT NULL THEN 1 ELSE 2 END, name`,
  clinic.id, clinic.category)).map(parsePrice);

export async function event(billId: string, actorId: string | null | undefined, type: string, note = ''): Promise<void> {
  await run('INSERT INTO bill_events(bill_id, actor_id, type, note) VALUES($1,$2,$3,$4)', billId, actorId ?? null, type, note);
}
export async function setStatus(billId: string, status: BillStatus): Promise<void> {
  await run('UPDATE bills SET status = $1, updated_at = now() WHERE id = $2', status, billId);
}
const fmtUsd = (n: number) => `$${round2(n).toFixed(2)}`;

// ---------- Drafts ----------
export async function createDraft(family: UserRow, imageBase64: string, mediaType: string) {
  if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) throw bad('unsupported_image');
  const buf = Buffer.from(imageBase64, 'base64');
  if (buf.length < 1000) throw bad('image_too_small');
  if (buf.length > 6 * 1024 * 1024) throw new HttpError(413, 'image_too_large');
  const id = randomUUID();
  // Stored in the database: hosting disks don't survive redeploys, and backups then include photos.
  await run('INSERT INTO photos(id, media_type, data) VALUES($1,$2,$3)', id, mediaType, buf);
  const path = `db:${id}`;
  const ai = await extractBill(imageBase64, mediaType);
  // Fingerprint of the exact photo, to catch the same image submitted again.
  // (The app re-compresses photos, so a new photo of the same paper won't match: other rules cover that.)
  const sha = createHash('sha256').update(buf).digest('hex');
  await run('INSERT INTO bill_drafts(id, family_id, photo_path, ai, photo_sha256) VALUES($1,$2,$3,$4,$5)',
    id, family.id, path, ai ? JSON.stringify(ai) : null, sha);
  return { draftId: id, ai, aiAvailable: Boolean(config.anthropicKey) };
}

// ---------- Create & screen ----------
export async function createBill(family: UserRow, input: Body): Promise<BillRow> {
  const s = await settings();
  const payerId = str(input.payerId, { min: 1, name: 'payer' });
  if (!(await one('SELECT 1 FROM links WHERE payer_id = $1 AND family_id = $2', payerId, family.id))) throw bad('payer_not_linked');
  const clinic = await one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', str(input.clinicId, { min: 1, name: 'clinic' }));
  if (!clinic || !clinic.active) throw bad('clinic_not_registered');

  const draft = input.draftId
    ? await one<DraftRow>('SELECT * FROM bill_drafts WHERE id = $1 AND family_id = $2', String(input.draftId), family.id)
    : undefined;
  if (input.draftId && !draft) throw bad('invalid_draft');
  if (draft && (await one('SELECT 1 FROM bills WHERE photo_path = $1', draft.photo_path))) throw bad('draft_already_used');
  const ai: AiBill | null = draft?.ai ? JSON.parse(draft.ai) : null;

  const items: BillItem[] = (Array.isArray(input.items) ? input.items : []).slice(0, 40).map((i: any) => ({
    d: str(i?.d, { min: 1, max: 120, name: 'item' }),
    q: Math.round(num(i?.q, { min: 1, max: 1000, name: 'qty' })),
    p: num(i?.p, { min: 0, max: 1e8, name: 'price' }),
  }));
  if (!items.length) throw bad('items_required');
  const currency = oneOf(input.currency, ['USD', 'CDF'] as const, 'currency');
  const total = input.total ? num(input.total, { min: 0.01, max: 1e9, name: 'total' }) : items.reduce((a, i) => a + i.q * i.p, 0);
  const billDate = typeof input.billDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.billDate) ? input.billDate : '';
  const bill = {
    clinicId: clinic.id,
    billNumber: str(input.billNumber, { max: 60, name: 'bill_number' }),
    patientName: str(input.patientName, { min: 1, max: 120, name: 'patient' }),
    billDate,
    currency, items, total, ai,
    edited: wasEdited(ai, { items, total }),
  };

  // Bills have no common format, so numbers and names are compared through tolerant keys
  // (see migrations/003): "N° 0457" = "FAC-0457" = "457"; "Débora BUDIAYI" = "Budiayi Debora".
  // The bill number is optional: many bills have none.
  const duplicates = (await one<{ n: number }>(`SELECT COUNT(*) n FROM bills WHERE clinic_id = $1 AND amc_bill_key($2) <> ''
      AND bill_number_key = amc_bill_key($2) AND status NOT IN ('rejected','declined')`, clinic.id, bill.billNumber))!.n;
  const recentForPatient = (await one<{ n: number }>("SELECT COUNT(*) n FROM bills WHERE patient_key = amc_name_key($1) AND created_at >= now() - interval '30 days'",
    bill.patientName))!.n;
  const duplicatePhotos = draft?.photo_sha256
    ? (await one<{ n: number }>("SELECT COUNT(*) n FROM bills WHERE photo_sha256 = $1 AND status NOT IN ('rejected','declined')", draft.photo_sha256))!.n
    : 0;
  // Same clinic, same patient, amount within 1 % (handwritten totals vary): probably the same bill.
  const similarRecent = (await one<{ n: number }>(`SELECT COUNT(*) n FROM bills WHERE clinic_id = $1 AND patient_key = amc_name_key($2)
      AND abs(total - $3) <= greatest(0.01, $3 * 0.01) AND currency = $4 AND status NOT IN ('rejected','declined')
      AND created_at >= now() - interval '30 days'`,
  clinic.id, bill.patientName, total, currency))!.n;
  const result = screenBill(bill, { clinic, prices: await pricesFor(clinic), settings: s, duplicates, recentForPatient, duplicatePhotos, similarRecent });

  const id = randomUUID();
  const ref = 'AMC-' + randomBytes(3).toString('hex').toUpperCase();
  const status: BillStatus = mustReview(result) ? 'review' : 'awaiting_clinic';
  await tx(async () => {
    await run(`INSERT INTO bills(id, ref, family_id, payer_id, clinic_id, patient_name, bill_number, bill_date, currency, items, total,
         total_usd, fee_usd, expected_usd, ai, edited, risk_score, risk_level, risk_reasons, status, photo_path, photo_sha256)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    id, ref, family.id, payerId, clinic.id, bill.patientName, bill.billNumber, bill.billDate, currency, JSON.stringify(items), total,
    result.totalUsd, feeFor(result.totalUsd, s), result.expectedUsd, ai ? JSON.stringify(ai) : null, bill.edited ? 1 : 0,
    result.score, result.level, JSON.stringify(result.reasons), status, draft?.photo_path || null, draft?.photo_sha256 || null);
    await event(id, family.id, 'submitted');
    await event(id, null, 'screened', `${result.level}:${result.score}`);
    await event(id, null, status === 'review' ? 'held_for_review' : 'sent_to_clinic');
  });
  if (status === 'awaiting_clinic') await notifyClinic((await getBill(id))!);
  return (await getBill(id))!;
}

export const getBill = (id: string) => one<BillRow>('SELECT * FROM bills WHERE id = $1', id);
const getClinic = (id: string) => one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', id);

// ---------- Notifications ----------
export async function notifyClinic(bill: BillRow): Promise<string> {
  const clinic = await getClinic(bill.clinic_id);
  if (!clinic?.whatsapp_phone) return 'no_whatsapp';
  return notify('clinicRequest', {
    to: clinic.whatsapp_phone, kind: 'clinic_request', lang: 'fr',
    params: {
      patient: bill.patient_name, billNumber: bill.bill_number || bill.ref, amount: fmtUsd(bill.total_usd),
      note: bill.risk_level === 'med' ? '⚠️ Merci de vérifier attentivement cette facture.' : "Payé par un membre de la famille à l'étranger.",
    },
    buttons: [{ id: `confirm:${bill.id}`, title: '✅ Confirmer' }, { id: `reject:${bill.id}`, title: '❌ Rejeter' }],
  });
}
const STATUS_WORDS: Record<string, Record<string, string>> = {
  paid: { fr: "payée à l'hôpital", en: 'paid to the hospital', ln: 'efuti na lopitalo', sw: 'imelipwa kwa hospitali' },
  rejected: { fr: 'rejetée', en: 'rejected', ln: 'eboyami', sw: 'imekataliwa' },
  declined: { fr: 'refusée par le payeur', en: 'declined by the payer', ln: 'mofuti aboyi', sw: 'imekataliwa na mlipaji' },
};
export async function notifyFamily(bill: BillRow, statusKey: string): Promise<void> {
  const fam = await one<UserRow>('SELECT * FROM users WHERE id = $1', bill.family_id);
  const words = STATUS_WORDS[statusKey];
  if (fam && words) await notify('familyUpdate', { to: fam.phone, kind: 'family_update', lang: fam.lang, params: { patient: bill.patient_name, status: words[fam.lang] || words.fr } });
}
async function notifyPayer(bill: BillRow): Promise<void> {
  const payer = await one<UserRow>('SELECT * FROM users WHERE id = $1', bill.payer_id);
  const clinic = await getClinic(bill.clinic_id);
  if (payer) await notify('payerApprove', { to: payer.phone, kind: 'payer_approve', lang: payer.lang, params: { clinic: clinic?.name, patient: bill.patient_name, amount: fmtUsd(bill.total_usd) } });
}

// ---------- Rejection reasons ----------
// The family and payer see why a bill was stopped and what to do. Texts are in the app's translations
// (reject.<code>); WhatsApp list titles below are for hospital staff, who use French.
export const HOSPITAL_REJECT_REASONS = ['patient_unknown', 'wrong_amount', 'already_paid', 'not_our_bill', 'other'] as const;
export const REVIEW_REJECT_REASONS = ['unverifiable', 'duplicate', 'unreadable_photo', 'not_in_network', 'other'] as const;
const WHY_TITLES: Record<(typeof HOSPITAL_REJECT_REASONS)[number], [string, string]> = {
  patient_unknown: ['Patient inconnu', "Ce patient n'est pas chez nous"],
  wrong_amount: ['Montant incorrect', 'Le montant ou les lignes ne correspondent pas'],
  already_paid: ['Déjà payée', 'Cette facture est déjà réglée'],
  not_our_bill: ['Pas notre facture', "La facture ne vient pas de notre établissement"],
  other: ['Autre raison', ''],
};
function checkReason(reason: unknown, allowed: readonly string[]): string {
  if (typeof reason !== 'string' || !allowed.includes(reason)) throw bad('reason_required');
  return reason;
}
const cleanNote = (note: unknown) => (typeof note === 'string' ? note.trim().slice(0, 300) : '');

/** After a hospital taps "Rejeter" on WhatsApp, ask why with a list (it's a reply, so no template needed). */
async function askHospitalWhy(bill: BillRow, to: string): Promise<void> {
  await send({
    to, kind: 'clinic_reason',
    text: `Facture ${bill.bill_number || bill.ref} (${bill.patient_name}) rejetée. Pourquoi ? La famille verra votre réponse.`,
    list: { button: 'Choisir la raison', choices: HOSPITAL_REJECT_REASONS.map((r) => ({ id: `why:${bill.id}:${r}`, title: WHY_TITLES[r][0], description: WHY_TITLES[r][1] || undefined })) },
  });
}

/** The hospital's answer to "why?". Only fills in a reason not given yet. */
export async function hospitalReason(billId: string, reason: string): Promise<BillRow | undefined> {
  if (!(HOSPITAL_REJECT_REASONS as readonly string[]).includes(reason)) return undefined;
  const b = await one<BillRow>(`UPDATE bills SET reject_reason = $2, updated_at = now()
    WHERE id = $1 AND status = 'rejected' AND rejected_by = 'hospital' AND reject_reason IS NULL RETURNING *`, billId, reason);
  if (b) await event(b.id, null, 'reject_reason', reason);
  return b;
}

/** Asks the hospital again (WhatsApp) to confirm a bill that's still waiting. At most every 5 minutes. */
export async function resendToClinic(billId: string, user: UserRow): Promise<{ status: string }> {
  const b = await getBill(billId);
  if (!canView(user, b)) throw notFound();
  if (b.status !== 'awaiting_clinic') throw new HttpError(409, 'not_awaiting_clinic');
  const clinic = await getClinic(b.clinic_id);
  if (!clinic?.whatsapp_phone) throw new HttpError(409, 'clinic_no_whatsapp');
  const recent = await one<{ n: number }>(`SELECT COUNT(*) n FROM bill_events WHERE bill_id = $1 AND type = 'clinic_reminded'
    AND at > now() - interval '5 minutes'`, b.id);
  if (user.role !== 'admin' && recent!.n > 0) throw new HttpError(429, 'resend_too_soon');
  const status = await notifyClinic(b);
  await event(b.id, user.id, 'clinic_reminded', status);
  return { status };
}

// ---------- Decisions ----------
// Each decision re-reads the bill with FOR UPDATE inside its transaction, so two concurrent
// requests (e.g. the app and a WhatsApp button) can't both move the same bill.
async function lockBill(billId: string): Promise<BillRow | undefined> {
  return one<BillRow>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', billId);
}

export async function clinicDecision(billId: string, decision: 'confirm' | 'reject', actor: UserRow | null,
  why: { reason?: unknown; note?: unknown } = {}): Promise<BillRow> {
  // In the app a reason is required; a WhatsApp tap has none yet (the hospital is asked right after).
  const reason = decision === 'reject' && actor ? checkReason(why.reason, HOSPITAL_REJECT_REASONS) : null;
  const bill = await tx(async () => {
    const b = await lockBill(billId);
    if (!b) throw notFound();
    if (actor?.role === 'clinic' && actor.clinic_id !== b.clinic_id) throw forbidden();
    if (b.status !== 'awaiting_clinic') throw new HttpError(409, 'not_awaiting_clinic');
    if (decision === 'confirm') {
      await setStatus(b.id, 'awaiting_payer');
      await run('UPDATE clinics SET trust = LEAST(100, trust + 1) WHERE id = $1', b.clinic_id);
      await event(b.id, actor?.id, 'clinic_confirmed', actor ? 'app' : 'whatsapp');
    } else {
      await setStatus(b.id, 'rejected');
      await run("UPDATE bills SET rejected_by = 'hospital', reject_reason = $2, reject_note = $3 WHERE id = $1", b.id, reason, cleanNote(why.note));
      await event(b.id, actor?.id, 'clinic_rejected', actor ? 'app' : 'whatsapp');
    }
    return b;
  });
  if (decision === 'confirm') await notifyPayer(bill);
  else {
    await notifyFamily(bill, 'rejected');
    if (!actor) { const c = await getClinic(bill.clinic_id); if (c?.whatsapp_phone) await askHospitalWhy(bill, c.whatsapp_phone); }
  }
  return (await getBill(bill.id))!;
}

export async function reviewDecision(billId: string, approve: boolean, admin: UserRow,
  why: { reason?: unknown; note?: unknown } = {}): Promise<BillRow> {
  const reason = approve ? null : checkReason(why.reason, REVIEW_REJECT_REASONS);
  const bill = await tx(async () => {
    const b = await lockBill(billId);
    if (!b) throw notFound();
    if (b.status !== 'review') throw new HttpError(409, 'not_in_review');
    if (approve) {
      await setStatus(b.id, 'awaiting_clinic');
      await event(b.id, admin.id, 'review_approved');
    } else {
      await setStatus(b.id, 'rejected');
      await run("UPDATE bills SET rejected_by = 'review', reject_reason = $2, reject_note = $3 WHERE id = $1", b.id, reason, cleanNote(why.note));
      await run('UPDATE clinics SET trust = GREATEST(0, trust - 3) WHERE id = $1', b.clinic_id);
      await event(b.id, admin.id, 'review_rejected');
    }
    return b;
  });
  if (approve) await notifyClinic((await getBill(bill.id))!);
  else await notifyFamily(bill, 'rejected');
  await audit(admin.id, approve ? 'review_approve' : 'review_reject', bill.ref);
  return (await getBill(bill.id))!;
}

export async function payerDecline(billId: string, payer: UserRow): Promise<BillRow> {
  const bill = await tx(async () => {
    const b = await lockBill(billId);
    if (!b || b.payer_id !== payer.id) throw notFound();
    if (!['awaiting_payer', 'payment_failed'].includes(b.status)) throw new HttpError(409, 'cannot_decline');
    await setStatus(b.id, 'declined');
    await event(b.id, payer.id, 'payer_declined');
    return b;
  });
  await notifyFamily(bill, 'declined');
  return (await getBill(bill.id))!;
}

// ---------- Access & views ----------
export function canView(user: UserRow | null, bill: BillRow | undefined): bill is BillRow {
  if (!user || !bill) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'payer') return bill.payer_id === user.id;
  if (user.role === 'family') return bill.family_id === user.id;
  if (user.role === 'clinic') return bill.clinic_id === user.clinic_id && bill.status !== 'review';
  return false;
}

export async function listBillsFor(user: UserRow) {
  const q: Record<UserRow['role'], [string, ...unknown[]]> = {
    admin: ['SELECT * FROM bills ORDER BY created_at DESC LIMIT 500'],
    payer: ['SELECT * FROM bills WHERE payer_id = $1 ORDER BY created_at DESC', user.id],
    family: ['SELECT * FROM bills WHERE family_id = $1 ORDER BY created_at DESC', user.id],
    clinic: ["SELECT * FROM bills WHERE clinic_id = $1 AND status != 'review' ORDER BY created_at DESC", user.clinic_id],
  };
  const [sql, ...params] = q[user.role];
  const bills = await all<BillRow>(sql, ...params);
  return Promise.all(bills.map((b) => view(b, user)));
}

export interface BillView {
  id: string; ref: string; status: BillStatus; patientName: string; billNumber: string; billDate: string;
  currency: string; items: BillItem[]; total: number; totalUsd: number; feeUsd: number; expectedUsd?: number;
  createdAt: string; hasPhoto: boolean;
  clinic: { id: string; name: string; commune: string } | null;
  payer?: { id: string; name: string } | null;
  family: { id: string; name: string } | null;
  risk: { score?: number; level: string; reasons?: Reason[] };
  aiUsed: boolean; edited: boolean;
  events: { at: string; type: string; note: string }[];
  payout?: { ref: string | null; status: string; account?: string };
  rejection?: { by: 'hospital' | 'review'; reason: string | null; note: string };
}

export async function view(b: BillRow, user: UserRow): Promise<BillView> {
  const [clinic, payer, family, events, payout] = await Promise.all([
    one<Pick<ClinicRow, 'id' | 'name' | 'commune' | 'payout_method' | 'payout_account'>>(
      'SELECT id, name, commune, payout_method, payout_account FROM clinics WHERE id = $1', b.clinic_id),
    one<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', b.payer_id),
    one<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', b.family_id),
    all<{ at: string; type: string; note: string }>('SELECT at, type, note FROM bill_events WHERE bill_id = $1 ORDER BY id', b.id),
    one<{ partner_ref: string | null; status: string }>(
      "SELECT partner_ref, status FROM payments WHERE bill_id = $1 AND kind = 'payout' ORDER BY created_at DESC LIMIT 1", b.id),
  ]);
  const out: BillView = {
    id: b.id, ref: b.ref, status: b.status, patientName: b.patient_name, billNumber: b.bill_number, billDate: b.bill_date,
    currency: b.currency, items: JSON.parse(b.items), total: b.total, totalUsd: b.total_usd, feeUsd: b.fee_usd,
    expectedUsd: b.expected_usd, createdAt: b.created_at, hasPhoto: Boolean(b.photo_path),
    clinic: clinic ? { id: clinic.id, name: clinic.name, commune: clinic.commune } : null,
    payer: payer ? { id: payer.id, name: payer.name } : null,
    family: family ? { id: family.id, name: family.name } : null,
    risk: { score: b.risk_score, level: b.risk_level, reasons: JSON.parse(b.risk_reasons) },
    aiUsed: Boolean(b.ai), edited: Boolean(b.edited),
    events,
  };
  if (payout) out.payout = { ref: payout.partner_ref, status: payout.status, account: clinic?.payout_account };
  if (b.status === 'rejected' && b.rejected_by) out.rejection = { by: b.rejected_by, reason: b.reject_reason, note: b.reject_note };
  // Clinics see what they need to confirm; risk details stay with payer/admin.
  if (user.role === 'clinic') { out.risk = { level: b.risk_level }; delete out.expectedUsd; delete out.payer; }
  if (user.role === 'family') { out.risk = { level: b.risk_level }; }
  return out;
}
