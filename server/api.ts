import { limit, clientIp } from './limits.js';
import { canonicalCommune, KINSHASA_COMMUNES } from './communes.js';
// REST API routes.
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { one, all, run, tx, audit, setSetting } from './db.js';
import { Router, HttpError, bad, notFound, forbidden, str, num, oneOf, phone, pageOf, type AuthCtx, type Body, type Ctx } from './http.js';
import { requestOtp, verifyOtp, createSession, sessionCookie, destroySession, findOrCreateUser, requireRole } from './auth.js';
import { createDraft, createBill, clinicDecision, reviewDecision, payerDecline, resendToClinic, hospitalReason, listBillsFor, listAllBills, view, canView, getBill, settings, prices, STATUSES, attachWaitingBills, notifyPayerOf } from './bills.js';
import { startPayment, applyPaymentUpdate, retryPayout } from './payments/flow.js';
import { getPartner, hasPartner } from './payments/partners.js';
import { DEFAULT_SETTINGS } from './screening.js';
import { notify, send, updateDelivery } from './messaging/index.js';
import { CATEGORIES, PAY_METHODS, type Category, type ClinicRow, type InviteRow, type Lang, type PaymentRow, type UserRow } from './types.js';

export const router = new Router();
// Launch languages: French, English, Lingala (Swahili kept on file, not offered).
const LANGS: Lang[] = ['fr', 'en', 'ln'];
const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);
const userView = (u: UserRow | null | undefined) =>
  u && ({ id: u.id, phone: u.phone, name: u.name, role: u.role, lang: u.lang, clinicId: u.clinic_id });
const getUser = (id: string) => one<UserRow>('SELECT * FROM users WHERE id = $1', id);
const getClinic = (id: string) => one<ClinicRow>('SELECT * FROM clinics WHERE id = $1', id);
/** Opening this link signs the other side up (as=family or as=payer) and accepts the invitation automatically. */
const inviteLink = (code: string, inviterRole: 'payer' | 'family' | string = 'payer') =>
  `${config.baseUrl.replace(/\/$/, '')}/?invite=${code}&as=${inviterRole === 'payer' ? 'family' : 'payer'}`;

// ---------- Auth ----------
router.post('/api/auth/request-otp', async ({ body, req }: Ctx) => {
  const lang = isLang(body.lang) ? body.lang : 'fr';
  const p = phone(body.phone);
  // Besides 5 codes per number per hour: per address, and overall, so nobody can make us send
  // codes to thousands of numbers (each WhatsApp/SMS code costs money).
  if (config.production) { limit('otp-ip:' + clientIp(req), 15, 3600_000); limit('otp-all', 500, 3600_000); }
  if (await one('SELECT 1 FROM users WHERE phone = $1 AND active = 0', p)) throw new HttpError(403, 'account_disabled');
  return requestOtp(p, lang);
});

router.post('/api/auth/verify', async ({ body, res }: Ctx) => {
  const p = phone(body.phone);
  const code = str(body.code, { min: 6, max: 6, name: 'code' });
  const existing = await one<UserRow>('SELECT * FROM users WHERE phone = $1', p);
  if (!existing && !body.role && !(config.adminPhone && p === config.adminPhone)) {
    // New number: check the code without using it up, then the app asks for name and role
    // and calls again with the same code.
    await verifyOtp(p, code, { consume: false });
    return { needsProfile: true };
  }
  if (existing && !existing.active) throw new HttpError(403, 'account_disabled');
  await verifyOtp(p, code);
  const { user } = await findOrCreateUser(p, {
    name: str(body.name || existing?.name || 'Admin', { min: 1, max: 80, name: 'name' }),
    role: body.role,
    lang: isLang(body.lang) ? body.lang : 'fr',
  });
  res.setHeader('set-cookie', sessionCookie(await createSession(user.id)));
  return { user: userView(user) };
});

router.post('/api/auth/logout', async ({ req, res }: Ctx) => {
  await destroySession(req);
  res.setHeader('set-cookie', sessionCookie('', 0));
  return { ok: true };
});

router.get('/api/me', async ({ user }: Ctx) => ({ user: userView(user) }));

router.patch('/api/me', requireRole(), async ({ user, body }: AuthCtx) => {
  if (body.name !== undefined) await run('UPDATE users SET name = $1 WHERE id = $2', str(body.name, { min: 1, max: 80, name: 'name' }), user.id);
  if (body.lang !== undefined) await run('UPDATE users SET lang = $1 WHERE id = $2', oneOf(body.lang, LANGS, 'lang'), user.id);
  return { user: userView(await getUser(user.id)) };
});

// ---------- Family links (either side invites the other with a short code or link) ----------
// A payer abroad invites a relative in the DRC, or a relative in the DRC invites someone abroad.
// With the invitee's phone number, only that number can use the code, and (once WhatsApp is live)
// AmaniCare sends the invite itself. Invitations last 7 days and can be sent again ("renewed").
const INVITE_DAYS = 7;
const newInviteCode = () => randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const inviterId = (i: InviteRow) => (i.inviter_role === 'payer' ? i.payer_id : i.family_id)!;

async function sendInviteMessage(inviter: UserRow, code: string, to: string | null): Promise<boolean> {
  if (!to || config.messaging !== 'whatsapp') return false;
  // Note: WhatsApp only delivers this outside a 24 h conversation window with an approved template.
  const key = inviter.role === 'payer' ? 'invite' : 'inviteAbroad';
  return (await notify(key, { to, kind: 'invite', lang: inviter.lang, params: { name: inviter.name, link: inviteLink(code, inviter.role) } })) === 'sent';
}

function inviteView(i: InviteRow, inviter: UserRow) {
  return {
    code: i.code, link: inviteLink(i.code, inviter.role), relation: i.relation, phone: i.phone,
    expiresAt: i.expires_at, expired: i.expires_at < Date.now(), expiresInDays: INVITE_DAYS,
  };
}

router.post('/api/invites', requireRole('payer', 'family'), async ({ user, body }: AuthCtx) => {
  const code = newInviteCode();
  const relation = str(body.relation, { max: 40, name: 'relation' });
  const to = body.phone ? phone(body.phone) : null;
  if (to && to === user.phone) throw bad('invite_own_phone');
  await run(`INSERT INTO invites(code, payer_id, family_id, inviter_role, relation, expires_at, phone) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    code, user.role === 'payer' ? user.id : null, user.role === 'family' ? user.id : null, user.role, relation,
    Date.now() + INVITE_DAYS * 864e5, to);
  const sent = await sendInviteMessage(user, code, to);
  return { ...inviteView((await one<InviteRow>('SELECT * FROM invites WHERE code = $1', code))!, user), sent };
});

/** Invitations I sent that nobody has used yet (waiting or expired). */
router.get('/api/invites', requireRole('payer', 'family'), async ({ user }: AuthCtx) => {
  // Not shown: invitations to someone who has joined since (same number, or an expired invitation
  // without a number under the same name as someone already linked, e.g. a second invitation was used).
  const rows = await all<InviteRow>(`SELECT i.* FROM invites i WHERE i.used_by IS NULL AND i.inviter_role = $2
     AND (i.payer_id = $1 OR i.family_id = $1)
     AND NOT EXISTS (SELECT 1 FROM links l JOIN users u ON u.id = CASE WHEN $2 = 'payer' THEN l.family_id ELSE l.payer_id END
       WHERE (CASE WHEN $2 = 'payer' THEN l.payer_id ELSE l.family_id END) = $1
         AND (u.phone = i.phone OR (i.phone IS NULL AND i.expires_at < $3 AND i.relation <> '' AND lower(i.relation) IN (lower(l.relation), lower(u.name)))))
     ORDER BY i.created_at DESC LIMIT 20`, user.id, user.role, Date.now());
  return { invites: rows.map((i) => inviteView(i, user)) };
});

/** Sends an invitation again: a new code valid 7 more days; the old code stops working. */
router.post('/api/invites/:code/renew', requireRole('payer', 'family'), async ({ user, params }: AuthCtx) => {
  const old = await one<InviteRow>('SELECT * FROM invites WHERE code = $1', params.code.toUpperCase());
  if (!old || inviterId(old) !== user.id) throw notFound();
  if (old.used_by) throw bad('invite_already_used');
  const code = newInviteCode();
  await run('UPDATE invites SET code = $1, expires_at = $2, created_at = now() WHERE code = $3', code, Date.now() + INVITE_DAYS * 864e5, old.code);
  const sent = await sendInviteMessage(user, code, old.phone);
  return { ...inviteView((await one<InviteRow>('SELECT * FROM invites WHERE code = $1', code))!, user), sent };
});

router.post('/api/invites/accept', requireRole('payer', 'family'), async ({ user, body }: AuthCtx) => {
  // Invitation codes are short (typed by hand): limit tries so they can't be guessed.
  limit('invite-try:' + user.id, 10, 15 * 60_000);
  const code = str(body.code, { min: 6, max: 6, name: 'code' }).toUpperCase();
  const inv = await tx(async () => {
    // Lock the invite so it can only be used once, even with two taps at the same moment.
    const i = await one<InviteRow>('SELECT * FROM invites WHERE code = $1 FOR UPDATE', code);
    if (!i || i.used_by) throw bad('invalid_invite');
    const inviter = (await getUser(inviterId(i)))!;
    // The message names the inviter, so the person knows who to ask for a new invitation.
    if (i.expires_at < Date.now()) throw new HttpError(410, 'invite_expired', inviter.name);
    if (i.phone && i.phone !== user.phone) throw bad('invite_other_phone');
    // An invitation from abroad is for a relative in the DRC, and the other way round.
    if (i.inviter_role === user.role) throw bad(i.inviter_role === 'payer' ? 'invite_for_family' : 'invite_for_payer');
    const payerId = i.inviter_role === 'payer' ? i.payer_id! : user.id;
    const familyId = i.inviter_role === 'family' ? i.family_id! : user.id;
    await run('INSERT INTO links(payer_id, family_id, relation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', payerId, familyId, i.relation);
    // Other open invitations from the same person to this relative (same number, or no number and
    // the same name) are done too: they no longer show as waiting.
    const others = await all<{ code: string }>(`SELECT code FROM invites WHERE used_by IS NULL AND code <> $1 AND inviter_role = $2
      AND (payer_id = $3 OR family_id = $3) AND (phone = $4 OR (phone IS NULL AND relation <> '' AND lower(relation) = lower($5)))`,
      code, i.inviter_role, inviterId(i), user.phone, i.relation);
    await run('UPDATE invites SET used_by = $1 WHERE code = ANY($2)', user.id, [code, ...others.map((o) => o.code)]);
    // Bills the family sent while waiting for this relative (under any of those invitations) now go to them.
    const toPay = [];
    if (i.inviter_role === 'family') for (const c of [code, ...others.map((o) => o.code)]) toPay.push(...(await attachWaitingBills(c, payerId)));
    return { inviter, toPay };
  });
  for (const b of inv.toPay) await notifyPayerOf(b);
  const linkedWith = { id: inv.inviter.id, name: inv.inviter.name };
  // "payer" kept for relatives in the DRC (earlier app versions read it).
  return user.role === 'family' ? { payer: linkedWith, linkedWith } : { family: linkedWith, linkedWith };
});

router.get('/api/family', requireRole('payer'), async ({ user }: AuthCtx) => ({
  members: await all(`SELECT u.id, u.name, u.phone, l.relation FROM links l JOIN users u ON u.id = l.family_id WHERE l.payer_id = $1 ORDER BY l.created_at`, user.id),
}));

router.get('/api/payers', requireRole('family'), async ({ user }: AuthCtx) => ({
  payers: await all(`SELECT u.id, u.name, l.relation FROM links l JOIN users u ON u.id = l.payer_id WHERE l.family_id = $1 ORDER BY l.created_at`, user.id),
}));

// The partner network, for anyone (welcome page, help, customer service): names, types and communes only.
router.get('/api/network', async () => ({
  facilities: (await all<{ name: string; commune: string; city: string; category: string }>("SELECT name, commune, city, category FROM clinics WHERE active = 1 ORDER BY city, commune, name"))
    .map((f) => ({ ...f, commune: canonicalCommune(f.commune) })),
  communes: KINSHASA_COMMUNES,
}));

router.get('/api/clinics', requireRole(), async () => ({
  clinics: (await all<{ commune: string }>('SELECT id, name, commune, city, category FROM clinics WHERE active = 1 ORDER BY city, commune, name'))
    .map((c) => ({ ...c, commune: canonicalCommune(c.commune) })),
}));

// ---------- Bills ----------
router.post('/api/bills/extract', requireRole('family'), async ({ user, body }: AuthCtx) => {
  return createDraft(user, str(body.image, { min: 100, max: 9_000_000, name: 'image' }), String(body.mediaType || 'image/jpeg'));
});

router.post('/api/bills', requireRole('family'), async ({ user, body }: AuthCtx) => ({ bill: await view(await createBill(user, body), user) }));

router.get('/api/bills', requireRole(), async ({ user, url }: AuthCtx) => {
  if (user.role !== 'admin') return { bills: await listBillsFor(user) };
  // Admins: page by page, newest first, with a search (reference, patient, bill number) and a status filter.
  const { limit, offset } = pageOf(url);
  return listAllBills(user, { q: (url.searchParams.get('q') || '').trim().slice(0, 60), status: url.searchParams.get('status') || '', limit, offset });
});

router.get('/api/bills/:id', requireRole(), async ({ user, params }: AuthCtx) => {
  const b = await getBill(params.id);
  if (!canView(user, b)) throw notFound();
  return { bill: await view(b, user) };
});

router.get('/api/bills/:id/photo', requireRole(), async ({ user, params, res }: AuthCtx) => {
  const b = await getBill(params.id);
  if (!canView(user, b) || !b.photo_path) throw notFound();
  let data: Buffer; let type: string;
  if (b.photo_path.startsWith('db:')) {
    const p = await one<{ data: Buffer; media_type: string }>('SELECT data, media_type FROM photos WHERE id = $1', b.photo_path.slice(3));
    if (!p) throw notFound();
    data = p.data; type = p.media_type;
  } else {
    // Photos saved on disk by earlier versions.
    data = await readFile(b.photo_path).catch(() => { throw notFound(); });
    const ext = b.photo_path.split('.').pop();
    type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  }
  // Never run as a page, whatever is inside the file.
  res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' });
  res.end(data);
  return undefined;
});

router.post('/api/bills/:id/confirm', requireRole('clinic', 'admin'), async ({ user, params }: AuthCtx) =>
  ({ bill: await view(await clinicDecision(params.id, 'confirm', user), user) }));
router.post('/api/bills/:id/reject', requireRole('clinic', 'admin'), async ({ user, params, body }: AuthCtx) =>
  ({ bill: await view(await clinicDecision(params.id, 'reject', user, body), user) }));
router.post('/api/bills/:id/review', requireRole('admin'), async ({ user, params, body }: AuthCtx) =>
  ({ bill: await view(await reviewDecision(params.id, body.approve === true, user, body), user) }));
router.post('/api/bills/:id/resend-clinic', requireRole('family', 'payer', 'admin'), async ({ user, params }: AuthCtx) =>
  resendToClinic(params.id, user));
router.post('/api/bills/:id/pay', requireRole('payer'), async ({ user, params, body }: AuthCtx) => {
  // Bank card (default) or mobile money: M-Pesa, Orange Money or Airtel Money, from a wallet number.
  const method = oneOf(body.method ?? 'card', PAY_METHODS, 'pay_method');
  const walletPhone = method === 'card' ? null : phone(body.walletPhone ?? user.phone);
  return startPayment(params.id, user, { method, walletPhone });
});
router.post('/api/bills/:id/decline', requireRole('payer'), async ({ user, params }: AuthCtx) =>
  ({ bill: await view(await payerDecline(params.id, user), user) }));
router.post('/api/bills/:id/retry-payout', requireRole('admin'), async ({ user, params }: AuthCtx) =>
  ({ bill: await view(await retryPayout(params.id, user), user) }));

// ---------- Admin ----------
router.get('/api/admin/overview', requireRole('admin'), async () => {
  const rows = await all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM bills GROUP BY status');
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
  const t = (await one<{ paid_usd: number; fees_usd: number; stopped_usd: number; avg_risk: number; users: number }>(`
    SELECT COALESCE(SUM(total_usd) FILTER (WHERE status = 'paid'), 0) paid_usd,
           COALESCE(SUM(fee_usd) FILTER (WHERE status = 'paid'), 0) fees_usd,
           COALESCE(SUM(total_usd) FILTER (WHERE status IN ('rejected','review')), 0) stopped_usd,
           COALESCE(AVG(risk_score), 0) avg_risk,
           (SELECT COUNT(*) FROM users) users
    FROM bills`))!;
  return { counts, paidUsd: t.paid_usd, feesUsd: t.fees_usd, stoppedUsd: t.stopped_usd, avgRisk: Math.round(t.avg_risk), users: t.users };
});

router.get('/api/admin/clinics', requireRole('admin'), async () => ({ clinics: await all('SELECT * FROM clinics ORDER BY name') }));

const clinicFields = (b: Body) => ({
  name: str(b.name, { min: 2, max: 100, name: 'name' }),
  commune: canonicalCommune(str(b.commune, { max: 60, name: 'commune' })), // "Bandal" → Bandalungwa
  city: str(b.city || 'Kinshasa', { max: 60, name: 'city' }),
  whatsapp_phone: b.whatsappPhone ? phone(b.whatsappPhone) : '',
  payout_method: oneOf(b.payoutMethod || 'bank', ['bank', 'mpesa', 'orange', 'airtel'], 'payout_method'),
  payout_account: str(b.payoutAccount, { min: 3, max: 60, name: 'payout_account' }),
  category: oneOf(b.category || 'clinic', CATEGORIES, 'category'),
  flexpay_merchant: str(b.flexpayMerchant ?? '', { max: 40, name: 'flexpay_merchant' }).trim(),
  payout_phone: b.payoutPhone ? phone(b.payoutPhone) : '',
});

router.post('/api/admin/clinics', requireRole('admin'), async ({ user, body }: AuthCtx) => {
  const f = clinicFields(body); const id = randomUUID();
  await run('INSERT INTO clinics(id, name, commune, city, whatsapp_phone, payout_method, payout_account, category, flexpay_merchant, payout_phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    id, f.name, f.commune, f.city, f.whatsapp_phone, f.payout_method, f.payout_account, f.category, f.flexpay_merchant, f.payout_phone);
  await audit(user.id, 'clinic_create', f.name);
  return { clinic: await getClinic(id) };
});

router.patch('/api/admin/clinics/:id', requireRole('admin'), async ({ user, params, body }: AuthCtx) => {
  const c = await getClinic(params.id);
  if (!c) throw notFound();
  if (body.active !== undefined) await run('UPDATE clinics SET active = $1 WHERE id = $2', body.active ? 1 : 0, c.id);
  if (body.name !== undefined) {
    const f = clinicFields({ ...body });
    await run('UPDATE clinics SET name=$1, commune=$2, city=$3, whatsapp_phone=$4, payout_method=$5, payout_account=$6, category=$7, flexpay_merchant=$8, payout_phone=$9 WHERE id=$10',
      f.name, f.commune, f.city, f.whatsapp_phone, f.payout_method, f.payout_account, f.category, f.flexpay_merchant, f.payout_phone, c.id);
  } else if (body.flexpayMerchant !== undefined || body.payoutPhone !== undefined) {
    // Just the FlexPay merchant code and/or mobile-money payout number.
    if (body.flexpayMerchant !== undefined) await run('UPDATE clinics SET flexpay_merchant = $1 WHERE id = $2', str(body.flexpayMerchant, { max: 40, name: 'flexpay_merchant' }).trim(), c.id);
    if (body.payoutPhone !== undefined) await run('UPDATE clinics SET payout_phone = $1 WHERE id = $2', body.payoutPhone ? phone(body.payoutPhone) : '', c.id);
    await audit(user.id, 'clinic_payment_setup', c.name);
  } else if (body.category !== undefined) {
    await run('UPDATE clinics SET category = $1 WHERE id = $2', oneOf(body.category, CATEGORIES, 'category'), c.id);
  }
  await audit(user.id, 'clinic_update', c.name);
  return { clinic: await getClinic(c.id) };
});

// Delete a hospital. Only one that never received a bill: bills must keep their hospital for the
// history and the accounts. A hospital with bills is deactivated instead (it then gets no new bills).
// Its staff accounts and its own price list go with it.
router.delete('/api/admin/clinics/:id', requireRole('admin'), async ({ user, params }: AuthCtx) => {
  const c = await getClinic(params.id);
  if (!c) throw notFound();
  if (await one('SELECT 1 FROM bills WHERE clinic_id = $1 LIMIT 1', c.id)) throw new HttpError(409, 'clinic_has_bills');
  await tx(async () => {
    await run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE clinic_id = $1 AND role = 'clinic')", c.id);
    await run("DELETE FROM users WHERE clinic_id = $1 AND role = 'clinic'", c.id);
    await run('UPDATE users SET clinic_id = NULL WHERE clinic_id = $1', c.id);
    await run('DELETE FROM reference_prices WHERE clinic_id = $1', c.id);
    await run('DELETE FROM clinics WHERE id = $1', c.id);
  });
  await audit(user.id, 'clinic_delete', c.name);
  return { ok: true };
});

// Admin creates clinic staff (or other admins) by phone number.
router.post('/api/admin/users', requireRole('admin'), async ({ user, body }: AuthCtx) => {
  const role = oneOf(body.role, ['clinic', 'admin'] as const, 'role');
  const p = phone(body.phone);
  if (await one('SELECT 1 FROM users WHERE phone = $1', p)) throw bad('phone_in_use');
  const clinicId = role === 'clinic' ? str(body.clinicId, { min: 1, name: 'clinic' }) : null;
  if (clinicId && !(await one('SELECT 1 FROM clinics WHERE id = $1', clinicId))) throw bad('clinic_not_found');
  const id = randomUUID();
  await run('INSERT INTO users(id, phone, name, role, lang, clinic_id) VALUES($1,$2,$3,$4,$5,$6)',
    id, p, str(body.name, { min: 1, max: 80, name: 'name' }), role, 'fr', clinicId);
  await audit(user.id, 'user_create', `${role} ${p}`);
  return { user: userView(await getUser(id)) };
});

// Admins and hospital staff (families and payers sign themselves up and are not listed here).
router.get('/api/admin/users', requireRole('admin'), async () => ({
  users: await all(`SELECT u.id, u.phone, u.name, u.role, u.active, u.clinic_id, c.name clinic, u.created_at FROM users u
    LEFT JOIN clinics c ON c.id = u.clinic_id WHERE u.role IN ('admin', 'clinic') ORDER BY u.role, u.name`),
  owner: config.adminPhone || null,
}));

// Delete an account. Only one that has no bills: bills are payment records and must keep who sent and
// paid them. For someone with bills, remove their access instead (history is kept).
router.delete('/api/admin/users/:id', requireRole('admin'), async ({ user, params }: AuthCtx) => {
  const u = await one<UserRow>('SELECT * FROM users WHERE id = $1', params.id);
  if (!u) throw notFound();
  if (u.id === user.id) throw bad('cannot_delete_self');
  if (config.adminPhone && u.phone === config.adminPhone) throw bad('cannot_delete_owner');
  if (u.role === 'admin') {
    const others = await one<{ n: number }>("SELECT COUNT(*)::int n FROM users WHERE role = 'admin' AND active = 1 AND id <> $1", u.id);
    if (!others || others.n < 1) throw bad('last_admin');
  }
  if (await one('SELECT 1 FROM bills WHERE payer_id = $1 OR family_id = $1 LIMIT 1', u.id)) throw new HttpError(409, 'user_has_bills');
  await tx(async () => {
    await run('DELETE FROM sessions WHERE user_id = $1', u.id);
    await run('DELETE FROM otps WHERE phone = $1', u.phone);
    await run("DELETE FROM photos WHERE id IN (SELECT substr(photo_path, 4) FROM bill_drafts WHERE family_id = $1 AND photo_path LIKE 'db:%')", u.id);
    await run('DELETE FROM bill_drafts WHERE family_id = $1', u.id);
    await run('DELETE FROM links WHERE payer_id = $1 OR family_id = $1', u.id);
    await run('UPDATE invites SET used_by = NULL WHERE used_by = $1', u.id);
    await run('DELETE FROM invites WHERE payer_id = $1 OR family_id = $1', u.id);
    await run('DELETE FROM users WHERE id = $1', u.id);
  });
  await audit(user.id, 'user_delete', `${u.role} ${u.name} ${u.phone}`);
  return { ok: true };
});

// Payers abroad and families in the DRC, for support and fraud checks: who they are linked to,
// how many bills they have and how much was paid to hospitals. Searchable by name or phone.
router.get('/api/admin/customers', requireRole('admin'), async ({ url }: AuthCtx) => {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const kind = url.searchParams.get('kind');
  const roles = kind === 'payer' || kind === 'family' ? [kind] : ['payer', 'family'];
  const like = '%' + q.replace(/[%_\\]/g, '') + '%';
  const { limit, offset } = pageOf(url);
  const where = `u.role = ANY($1) AND ($2 = '' OR u.name ILIKE $3 OR u.phone LIKE $3)`;
  const customers = await all(`SELECT u.id, u.name, u.phone, u.role, u.active, u.lang, u.created_at,
      (SELECT MAX(a.at) FROM audit a WHERE a.actor_id = u.id AND a.action = 'login') last_login,
      (SELECT string_agg(o.name || CASE WHEN l.relation <> '' THEN ' (' || l.relation || ')' ELSE '' END, ', ' ORDER BY l.created_at)
         FROM links l JOIN users o ON o.id = CASE WHEN u.role = 'payer' THEN l.family_id ELSE l.payer_id END
        WHERE (u.role = 'payer' AND l.payer_id = u.id) OR (u.role = 'family' AND l.family_id = u.id)) linked,
      (SELECT COUNT(*)::int FROM bills b WHERE b.payer_id = u.id OR b.family_id = u.id) bills,
      (SELECT COALESCE(SUM(b.total_usd), 0) FROM bills b WHERE (b.payer_id = u.id OR b.family_id = u.id) AND b.status = 'paid') paid_usd
    FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT $4 OFFSET $5`, roles, q, like, limit, offset);
  const found = await one<{ n: number }>(`SELECT COUNT(*)::int n FROM users u WHERE ${where}`, roles, q, like);
  const counts = await one<{ payers: number; families: number }>(`SELECT COUNT(*) FILTER (WHERE role = 'payer')::int payers,
    COUNT(*) FILTER (WHERE role = 'family')::int families FROM users`);
  const total = found?.n ?? 0;
  return { customers, counts, total, hasMore: offset + customers.length < total };
});

// Remove or restore anyone's access (admin, staff, payer or family). History stays; open sessions end at once.
router.patch('/api/admin/users/:id', requireRole('admin'), async ({ user, body, params }: AuthCtx) => {
  const u = await one<UserRow>('SELECT * FROM users WHERE id = $1', params.id);
  if (!u) throw notFound();
  if (body.name !== undefined) await run('UPDATE users SET name = $1 WHERE id = $2', str(body.name, { min: 1, max: 80, name: 'name' }), u.id);
  if (body.phone !== undefined) {
    const p = phone(body.phone);
    if (p !== u.phone) {
      if (config.adminPhone && u.phone === config.adminPhone) throw bad('cannot_change_owner_phone');
      if (await one('SELECT 1 FROM users WHERE phone = $1', p)) throw bad('phone_in_use');
      await run('UPDATE users SET phone = $1 WHERE id = $2', p, u.id);
      await run('DELETE FROM otps WHERE phone = $1', u.phone); // a code sent to the old number no longer works
      await audit(user.id, 'user_phone_change', `${u.role} ${u.phone} → ${p}`);
    }
  }
  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
    if (!active) {
      if (u.id === user.id) throw bad('cannot_disable_self');
      if (config.adminPhone && u.phone === config.adminPhone) throw bad('cannot_disable_owner');
      if (u.role === 'admin') {
        const others = await one<{ n: number }>("SELECT COUNT(*)::int n FROM users WHERE role = 'admin' AND active = 1 AND id <> $1", u.id);
        if (!others || others.n < 1) throw bad('last_admin');
      }
      await run('DELETE FROM sessions WHERE user_id = $1', u.id);
    }
    await run('UPDATE users SET active = $1 WHERE id = $2', active, u.id);
    await audit(user.id, active ? 'user_enable' : 'user_disable', `${u.role} ${u.phone}`);
  }
  return { ok: true };
});

router.get('/api/admin/prices', requireRole('admin'), async () => ({ prices: await prices() }));
// Saves the price list of one scope: general (no scope), one facility type ({ category }) or one
// facility ({ clinicId }). Only that scope's prices are replaced; the others are untouched.
router.put('/api/admin/prices', requireRole('admin'), async ({ user, body }: AuthCtx) => {
  const scope = (body.scope && typeof body.scope === 'object' ? body.scope : {}) as Record<string, unknown>;
  const category: Category | null = scope.category ? oneOf(scope.category, CATEGORIES, 'category') : null;
  const clinicId = scope.clinicId ? str(scope.clinicId, { min: 1, name: 'clinic' }) : null;
  if (category && clinicId) throw bad('invalid_scope');
  if (clinicId && !(await getClinic(clinicId))) throw bad('clinic_not_found');
  const list = (Array.isArray(body.prices) ? body.prices : []).slice(0, 300).map((p: any) => ({
    id: String(p?.id || randomUUID()),
    name: str(p?.name, { min: 1, max: 80, name: 'name' }),
    keywords: (Array.isArray(p?.keywords) ? p.keywords : String(p?.keywords || '').split(','))
      .map((k: unknown) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 20) as string[],
    usd: num(p?.usd, { min: 0.01, max: 100000, name: 'usd' }),
  }));
  await tx(async () => {
    await run('DELETE FROM reference_prices WHERE clinic_id IS NOT DISTINCT FROM $1 AND category IS NOT DISTINCT FROM $2', clinicId, category);
    for (const p of list) {
      // This scope's rows were just deleted, so an id that still exists belongs to another scope
      // (e.g. a row copied from the general list): give the copy a new id.
      await run(`INSERT INTO reference_prices(id, name, keywords, usd, category, clinic_id)
        VALUES(CASE WHEN EXISTS (SELECT 1 FROM reference_prices WHERE id = $1) THEN gen_random_uuid()::text ELSE $1 END, $2, $3, $4, $5, $6)`,
      p.id, p.name, JSON.stringify(p.keywords), p.usd, category, clinicId);
    }
  });
  await audit(user.id, 'prices_update', `${list.length} prices (${clinicId ? 'clinic ' + clinicId : category || 'general'})`);
  return { prices: await prices() };
});

router.get('/api/admin/settings', requireRole('admin'), async () => ({
  settings: await settings(), defaults: DEFAULT_SETTINGS, partner: config.paymentPartner, messaging: config.messaging, ai: Boolean(config.anthropicKey),
}));
router.put('/api/admin/settings', requireRole('admin'), async ({ user, body }: AuthCtx) => {
  const s = {
    cdfPerUsd: num(body.cdfPerUsd, { min: 1, max: 1e6, name: 'rate' }),
    priceFlagRatio: num(body.priceFlagRatio, { min: 1, max: 10, name: 'ratio' }),
    feePct: num(body.feePct, { min: 0, max: 0.2, name: 'fee' }),
    feeMinUsd: num(body.feeMinUsd, { min: 0, max: 50, name: 'fee_min' }),
    reviewAboveUsd: num(body.reviewAboveUsd, { min: 1, max: 1e6, name: 'review_above' }),
  };
  await setSetting('screening', s);
  await audit(user.id, 'settings_update', s);
  return { settings: await settings() };
});

router.get('/api/admin/messages', requireRole('admin'), async ({ url }: AuthCtx) => {
  const { limit, offset } = pageOf(url);
  const messages = await all('SELECT * FROM messages ORDER BY id DESC LIMIT $1 OFFSET $2', limit + 1, offset);
  return { messages: messages.slice(0, limit), hasMore: messages.length > limit };
});
router.get('/api/admin/payments', requireRole('admin'), async ({ url }: AuthCtx) => {
  const { limit, offset } = pageOf(url);
  const payments = await all('SELECT p.*, b.ref bill_ref FROM payments p JOIN bills b ON b.id = p.bill_id ORDER BY p.created_at DESC, p.id LIMIT $1 OFFSET $2', limit + 1, offset);
  return { payments: payments.slice(0, limit), hasMore: payments.length > limit };
});

router.get('/api/admin/audit', requireRole('admin'), async ({ url }: AuthCtx) => {
  const { limit, offset } = pageOf(url, 100);
  const audit = await all('SELECT * FROM audit ORDER BY id DESC LIMIT $1 OFFSET $2', limit + 1, offset);
  return { audit: audit.slice(0, limit), hasMore: audit.length > limit };
});

// ---------- Payment partner webhooks ----------
router.post('/api/webhooks/payments/:partner', async ({ params, raw, req }: Ctx) => {
  // Only the partner in use can report payments (not the sandbox while FlexPay is live, etc.).
  if (!hasPartner(params.partner) || params.partner !== config.paymentPartner) throw notFound();
  const partner = getPartner(params.partner);
  if (!partner.verifyWebhook(raw, req.headers)) throw new HttpError(401, 'bad_signature');
  let update = partner.parseWebhook(JSON.parse(raw.toString('utf8') || '{}'));
  // A partner can only report on its own payments.
  const p = update.paymentId ? await one<PaymentRow>('SELECT * FROM payments WHERE id = $1', update.paymentId)
    : update.partnerRef ? await one<PaymentRow>('SELECT * FROM payments WHERE partner_ref = $1', update.partnerRef) : undefined;
  if (!p || p.partner !== partner.name) return { ok: true };
  // Unsigned callbacks (FlexPay): only the partner's status API decides.
  if (partner.confirm) update = await partner.confirm(p, update);
  await applyPaymentUpdate({ ...update, paymentId: p.id, partnerRef: undefined });
  return { ok: true };
});

// ---------- Sandbox checkout (only when the sandbox partner is active) ----------
const sandboxOnly = () => { if (config.paymentPartner !== 'sandbox') throw notFound(); };
router.get('/api/sandbox/payments/:id', sandboxOnly, requireRole('payer'), async ({ user, params }: AuthCtx) => {
  // Only the payer of this bill sees its checkout (patient, hospital, amount, wallet).
  const p = await one(`SELECT p.id, p.amount_usd, p.status, p.method, p.wallet_phone, b.ref, b.patient_name, c.name clinic FROM payments p
    JOIN bills b ON b.id = p.bill_id JOIN clinics c ON c.id = b.clinic_id WHERE p.id = $1 AND p.kind = 'collection' AND b.payer_id = $2`, params.id, user.id);
  if (!p) throw notFound();
  return { payment: p };
});
router.post('/api/sandbox/payments/:id/complete', sandboxOnly, requireRole('payer'), async ({ user, params, body }: AuthCtx) => {
  const p = await one<PaymentRow & { payer_id: string }>(
    "SELECT p.*, b.payer_id FROM payments p JOIN bills b ON b.id = p.bill_id WHERE p.id = $1 AND p.kind = 'collection'", params.id);
  if (!p || p.payer_id !== user.id) throw notFound();
  await applyPaymentUpdate({ paymentId: p.id, status: body.outcome === 'fail' ? 'failed' : 'succeeded', reason: body.outcome === 'fail' ? (p.method && p.method !== 'card' ? 'Mobile money payment refused (sandbox)' : 'Card declined (sandbox)') : undefined });
  return { ok: true };
});

// ---------- WhatsApp Cloud API webhook (clinic taps Confirm / Reject) ----------
router.get('/api/webhooks/whatsapp', async ({ url, res }: Ctx) => {
  const q = url.searchParams;
  if (q.get('hub.mode') === 'subscribe' && config.whatsapp.verifyToken && q.get('hub.verify_token') === config.whatsapp.verifyToken) {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(q.get('hub.challenge') || '');
    return undefined;
  }
  throw forbidden();
});

router.post('/api/webhooks/whatsapp', async ({ raw, req }: Ctx) => {
  const secret = config.whatsapp.appSecret;
  if (!secret) throw forbidden();
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    console.warn('[whatsapp] webhook refused: bad signature (is WHATSAPP_APP_SECRET the App secret of this Meta app?)');
    throw new HttpError(401, 'bad_signature');
  }
  const payload = JSON.parse(raw.toString('utf8') || '{}');
  // Logs say what arrived and why a tap was ignored, without message contents (last 4 digits only).
  const tail = (n: unknown) => '…' + String(n ?? '').slice(-4);
  let receipts = 0, inbound = 0;
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    receipts += (ch.value?.statuses || []).length;
    inbound += (ch.value?.messages || []).length;
  }
  console.log(`[whatsapp] webhook: ${receipts} receipt(s), ${inbound} incoming message(s)`);
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    // Delivery receipts for messages we sent.
    for (const st of ch.value?.statuses || []) {
      if (st?.id && ['sent', 'delivered', 'read', 'failed'].includes(st.status)) {
        const err = st.errors?.[0];
        await updateDelivery(String(st.id), st.status, err ? `${err.code ?? ''} ${err.title ?? ''} ${err.error_data?.details ?? ''}`.trim().slice(0, 300) : undefined);
      }
    }
    for (const m of ch.value?.messages || []) {
    // A written message (not a button tap) goes to customer service: the assistant or a person answers.
    if (m.type === 'text' && m.text?.body) {
      const { onWhatsAppText } = await import('./support.js');
      try { await onWhatsAppText(String(m.from), String(m.text.body)); console.log(`[whatsapp] message from ${tail(m.from)} sent to customer service`); }
      catch (e) { console.warn(`[whatsapp] customer service message from ${tail(m.from)}: ${(e as Error).message}`); }
      continue;
    }
    // Buttons on a template arrive as type "button" (payload); on a free-form message as "interactive".
    const id: string = m.button?.payload || m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
    const [decision, billId, reason] = id.split(':');
    if (decision === 'why' && billId && reason) {
      // The hospital's answer to "why was it rejected?" (list sent after a Rejeter tap).
      const b = await getBill(billId);
      const c = b && (await getClinic(b.clinic_id));
      if (b && c && c.whatsapp_phone.replace(/\D/g, '') === String(m.from)) {
        const done = await hospitalReason(billId, reason);
        console.log(`[whatsapp] ${b.ref} reject reason ${done ? reason : 'ignored (already set)'}`);
        if (done) await send({ to: c.whatsapp_phone, kind: 'clinic_reason', text: 'Merci. La famille est informée.' });
      }
      continue;
    }
    if ((decision !== 'confirm' && decision !== 'reject') || !billId) {
      console.log(`[whatsapp] message from ${tail(m.from)} (type ${m.type}) is not a Confirm/Reject tap: ignored`);
      continue;
    }
    const bill = await getBill(billId);
    const clinic = bill && (await getClinic(bill.clinic_id));
    if (!bill || !clinic) { console.warn(`[whatsapp] ${decision} tap for an unknown bill: ignored`); continue; }
    // Only the clinic's registered WhatsApp number may answer for its bills.
    if (clinic.whatsapp_phone.replace(/\D/g, '') !== String(m.from)) {
      console.warn(`[whatsapp] ${decision} tap on ${bill.ref} from ${tail(m.from)}, but ${clinic.name}'s number ends ${tail(clinic.whatsapp_phone)}: ignored`);
      continue;
    }
    try {
      await clinicDecision(billId, decision, null);
      console.log(`[whatsapp] ${bill.ref} ${decision === 'confirm' ? 'confirmed' : 'rejected'} by ${clinic.name}`);
    } catch (e) { console.warn(`[whatsapp] ${decision} tap on ${bill.ref}: ${(e as Error).message}`); }
    }
  }
  return { ok: true };
});
