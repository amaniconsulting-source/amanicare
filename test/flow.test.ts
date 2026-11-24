// End-to-end: payer invites family → family submits a bill → clinic confirms → payer pays (sandbox) → clinic paid.
// Runs against PostgreSQL (TEST_DATABASE_URL, or DATABASE_URL) in a throwaway schema that is dropped afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';

process.env.UPLOAD_DIR = 'data/test-uploads';
process.env.OTP_DEV = '1';
process.env.ADMIN_PHONE = '+15550000001';
process.env.SANDBOX_PAYOUT_DELAY_MS = '0';
process.env.PAYMENT_PARTNER = 'sandbox';
process.env.MESSAGING = 'sandbox';
process.env.ANTHROPIC_API_KEY = '';

const { config } = await import('../server/config.js');
const { openDb, closeDb, one } = await import('../server/db.js');
const { migrate } = await import('../server/migrate.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { createApp } = await import('../server/index.js');

const databaseUrl = process.env.TEST_DATABASE_URL || config.databaseUrl;
const schema = `test_${process.pid}_${Date.now().toString(36)}`;

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

let server: Server, base: string;
before(async () => {
  await admin(`CREATE SCHEMA ${schema}`);
  openDb({ connectionString: databaseUrl, schema });
  await migrate({ log: false });
  await seedIfEmpty({ demo: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
  await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

type Api = ((method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>) & { raw: (path: string) => Promise<Response> };
function client(): Api {
  let cookie = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  };
  return Object.assign(api, { raw: (path: string) => fetch(base + path, { headers: { cookie } }) });
}
/** A photo of the bill (required): a unique fake image per call, read into a draft. */
let photoN = 0;
const photo = async (api: Api): Promise<string> => (await api('POST', '/api/bills/extract', { image: Buffer.alloc(2600, 150 + (photoN++ % 100)).toString('base64'), mediaType: 'image/jpeg' })).data.draftId;

async function login(api: Api, phone: string, profile: Record<string, string> = {}) {
  const { data } = await api('POST', '/api/auth/request-otp', { phone });
  const r = await api('POST', '/api/auth/verify', { phone, code: data.devCode, ...profile });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const tinyJpeg = Buffer.alloc(2048, 1).toString('base64');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The sandbox payout completes on a timer; wait until it lands (instead of a fixed sleep).
async function waitForStatus(billId: string, status: string, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await one<{ status: string }>('SELECT status FROM bills WHERE id = $1', billId))?.status === status) return;
    await wait(10);
  }
}

test('full payment flow', async () => {
  const payer = client(), family = client(), clinic = client(), admin = client();

  // New numbers must give a profile first
  const first = await (async () => { const { data } = await payer('POST', '/api/auth/request-otp', { phone: '+12145550100' }); return payer('POST', '/api/auth/verify', { phone: '+12145550100', code: data.devCode }); })();
  assert.equal(first.data.needsProfile, true);
  await login(payer, '+12145550100', { name: 'Alain', role: 'payer', lang: 'en' });
  await login(family, '+243810000099', { name: 'Josephine', role: 'family', lang: 'fr' });

  // Nobody can self-register as admin or clinic
  const sneaky = client();
  const { data: otp } = await sneaky('POST', '/api/auth/request-otp', { phone: '+243810000555' });
  const r = await sneaky('POST', '/api/auth/verify', { phone: '+243810000555', code: otp.devCode, name: 'X', role: 'admin' });
  assert.equal(r.status, 400);

  const inv = await payer('POST', '/api/invites', { relation: 'Mother' });
  const acc = await family('POST', '/api/invites/accept', { code: inv.data.code });
  assert.equal(acc.status, 200);

  const { data: { clinics } } = await family('GET', '/api/clinics');
  const espoir = clinics.find((c: { name: string }) => c.name === 'Centre Médical Espoir');
  const draft = await family('POST', '/api/bills/extract', { image: tinyJpeg, mediaType: 'image/jpeg' });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.ai, null); // no API key in tests → manual entry

  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const created = await family('POST', '/api/bills', {
    draftId: draft.data.draftId, payerId, clinicId: espoir.id, patientName: 'Josephine K.', billNumber: 'CME-0457', currency: 'USD',
    items: [{ d: 'Consultation', q: 1, p: 10 }, { d: 'TDR paludisme', q: 1, p: 5 }, { d: 'Coartem', q: 1, p: 8 }], total: 23,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const bill = created.data.bill;
  assert.equal(bill.status, 'awaiting_clinic');
  // The photo is stored in the database and served back to people who can see the bill.
  const photo = await family.raw(`/api/bills/${bill.id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(tinyJpeg, 'base64'));
  assert.equal((await client().raw(`/api/bills/${bill.id}/photo`)).status, 401); // not logged in
  assert.equal(bill.risk.level, 'low');

  // The clinic got a WhatsApp-style request in the outbox
  assert.ok(await one("SELECT 1 FROM messages WHERE to_phone = '+243810000001' AND body LIKE '%Josephine K.%'"));

  // Payer can't pay before the clinic confirms
  assert.equal((await payer('POST', `/api/bills/${bill.id}/pay`, {})).status, 409);

  // Clinic staff log in with the clinic's number and confirm
  await login(clinic, '+243810000001');
  assert.equal((await clinic('POST', `/api/bills/${bill.id}/confirm`, {})).data.bill.status, 'awaiting_payer');

  // Payer pays through the sandbox checkout
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, {});
  assert.equal(pay.status, 200);
  assert.match(pay.data.checkoutUrl, /sandbox-checkout/);
  assert.equal((await payer('POST', `/api/sandbox/payments/${pay.data.paymentId}/complete`, { outcome: 'succeed' })).status, 200);
  await waitForStatus(bill.id, 'paid');

  const after = (await payer('GET', `/api/bills/${bill.id}`)).data.bill;
  assert.equal(after.status, 'paid');
  assert.ok(after.payout.ref.startsWith('SBX-P-'));
  // Duplicate webhook/complete is ignored (no double payout)
  await payer('POST', `/api/sandbox/payments/${pay.data.paymentId}/complete`, { outcome: 'succeed' });
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE bill_id = $1 AND kind = 'payout'", bill.id))!.n, 1);
  assert.equal((await one<{ amount_usd: number }>('SELECT amount_usd FROM payments WHERE id = $1', pay.data.paymentId))!.amount_usd, 25); // $23 + $2 minimum fee

  // Re-submitting the same bill number is caught and held for review
  const draft2 = await family('POST', '/api/bills/extract', { image: tinyJpeg, mediaType: 'image/jpeg' });
  const dup = await family('POST', '/api/bills', {
    draftId: draft2.data.draftId, payerId, clinicId: espoir.id, patientName: 'Josephine K.', billNumber: 'CME-0457', currency: 'USD',
    items: [{ d: 'Consultation', q: 1, p: 35 }, { d: 'Échographie', q: 1, p: 30 }], total: 148,
  });
  assert.equal(dup.data.bill.status, 'review');

  // Clinics never see bills in review; other clinics see nothing
  assert.equal((await clinic('GET', '/api/bills')).data.bills.some((b: { id: string }) => b.id === dup.data.bill.id), false);

  // Admin rejects it
  await login(admin, '+15550000001');
  // A reason is required, and the family sees it.
  assert.equal((await admin('POST', `/api/bills/${dup.data.bill.id}/review`, { approve: false })).data.error, 'reason_required');
  const rev = await admin('POST', `/api/bills/${dup.data.bill.id}/review`, { approve: false, reason: 'duplicate', note: 'Same bill as last week' });
  assert.equal(rev.data.bill.status, 'rejected');
  assert.deepEqual((await family('GET', `/api/bills/${dup.data.bill.id}`)).data.bill.rejection, { by: 'review', reason: 'duplicate', note: 'Same bill as last week' });
  const ov = await admin('GET', '/api/admin/overview');
  assert.equal(ov.data.counts.paid, 1);

  // Family can't see admin data; payer can't see another payer's bills
  assert.equal((await family('GET', '/api/admin/overview')).status, 403);
  const other = client(); await login(other, '+12145550199', { name: 'Other', role: 'payer' });
  assert.equal((await other('GET', `/api/bills/${bill.id}`)).status, 404);
});

test('failed card payment can be retried', async () => {
  const payer = client(), family = client(), clinic = client();
  await login(payer, '+12145550300', { name: 'P2', role: 'payer' });
  await login(family, '+243810000300', { name: 'F2', role: 'family' });
  const inv = await payer('POST', '/api/invites', { relation: 'Brother' });
  await family('POST', '/api/invites/accept', { code: inv.data.code });
  const { data: { clinics } } = await family('GET', '/api/clinics');
  const c = clinics.find((x: { name: string }) => x.name === 'Clinique Bonne Santé');
  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const { data: { bill } } = await family('POST', '/api/bills', { draftId: await photo(family), payerId, clinicId: c.id, patientName: 'Patrick M.', billNumber: 'CBS-77', currency: 'CDF', items: [{ d: 'Consultation', q: 1, p: 28500 }], total: 28500 });
  assert.equal(bill.totalUsd, 10);
  await login(clinic, '+243810000002');
  await clinic('POST', `/api/bills/${bill.id}/confirm`, {});
  // The payer chooses how to pay: an unknown method or a bad wallet number is refused.
  assert.equal((await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'paypal' })).data.error, 'invalid_pay_method');
  assert.equal((await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '0812' })).data.error, 'phone_country_code'); // too short to be a Congolese number
  // First try: M-Pesa from a wallet number, refused on the phone.
  const p1 = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243 81 555 0199' });
  assert.equal(p1.data.method, 'mpesa');
  const sbx = (await payer('GET', `/api/sandbox/payments/${p1.data.paymentId}`)).data.payment;
  assert.equal(sbx.method, 'mpesa');
  assert.equal(sbx.wallet_phone, '+243815550199');
  await payer('POST', `/api/sandbox/payments/${p1.data.paymentId}/complete`, { outcome: 'fail' });
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.status, 'payment_failed');
  assert.match((await one<{ failure_reason: string }>('SELECT failure_reason FROM payments WHERE id = $1', p1.data.paymentId))!.failure_reason, /Mobile money/);
  // Second try: bank card (the default).
  const p2 = await payer('POST', `/api/bills/${bill.id}/pay`, {});
  assert.equal(p2.data.method, 'card');
  assert.notEqual(p2.data.paymentId, p1.data.paymentId);
  await payer('POST', `/api/sandbox/payments/${p2.data.paymentId}/complete`, { outcome: 'succeed' });
  await waitForStatus(bill.id, 'paid');
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.status, 'paid');
});

test('invites can be locked to a phone number', async () => {
  const payer = client(), wrong = client(), right = client();
  await login(payer, '+12145550400', { name: 'P4', role: 'payer' });
  assert.equal((await payer('POST', '/api/invites', { relation: 'Sister', phone: '+12145550400' })).data.error, 'invite_own_phone');
  const inv = await payer('POST', '/api/invites', { relation: 'Sister', phone: '+243 81 000 0400' });
  assert.equal(inv.data.phone, '+243810000400');
  assert.equal(inv.data.sent, false); // sandbox messaging: the payer shares it with the WhatsApp button
  await login(wrong, '+243810000401', { name: 'Not her', role: 'family' });
  assert.equal((await wrong('POST', '/api/invites/accept', { code: inv.data.code })).data.error, 'invite_other_phone');
  await login(right, '+243810000400', { name: 'Sister', role: 'family' });
  assert.equal((await right('POST', '/api/invites/accept', { code: inv.data.code })).status, 200);
  // Invites without a number still work for anyone, once.
  const open = await payer('POST', '/api/invites', { relation: 'Cousin' });
  assert.equal(open.data.phone, null);
  assert.equal((await wrong('POST', '/api/invites/accept', { code: open.data.code })).status, 200);
});

test('app files are re-checked on every load so code and translations never mismatch', async () => {
  const first = await fetch(base + '/i18n/en.json');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag')!;
  assert.ok(etag);
  const again = await fetch(base + '/i18n/en.json', { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(base + '/icon-192.png')).headers.get('cache-control'), 'public, max-age=86400');
});

test('a relative in the DRC can invite someone abroad', async () => {
  const fam = client(), abroad = client(), otherFam = client();
  await login(fam, '+243810000500', { name: 'Maman Jeanne', role: 'family' });
  const inv = await fam('POST', '/api/invites', { relation: 'Son', phone: '+12145550500' });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.match(inv.data.link, /\?invite=[A-F0-9]{6}&as=payer$/);
  // Listed under "Invitations sent" until used.
  assert.equal((await fam('GET', '/api/invites')).data.invites.length, 1);
  // Another relative in the DRC can't use it: it's for someone abroad.
  await login(otherFam, '+243810000501', { name: 'Cousin', role: 'family' });
  assert.equal((await otherFam('POST', '/api/invites/accept', { code: inv.data.code })).data.error, 'invite_other_phone');
  const open = await fam('POST', '/api/invites', { relation: 'Niece' });
  assert.equal((await otherFam('POST', '/api/invites/accept', { code: open.data.code })).data.error, 'invite_for_payer');
  // The person abroad accepts: the link goes payer → family the right way round.
  await login(abroad, '+12145550500', { name: 'Patrick', role: 'payer' });
  const acc = await abroad('POST', '/api/invites/accept', { code: inv.data.code });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.linkedWith.name, 'Maman Jeanne');
  assert.deepEqual((await abroad('GET', '/api/family')).data.members.map((m: any) => m.name), ['Maman Jeanne']);
  assert.equal((await fam('GET', '/api/payers')).data.payers[0].name, 'Patrick');
  // Used invitations leave the list; a second use fails.
  assert.equal((await fam('GET', '/api/invites')).data.invites.length, 1); // only the open "Niece" one
  assert.equal((await abroad('POST', '/api/invites/accept', { code: inv.data.code })).data.error, 'invalid_invite');
});

test('an expired invitation names who sent it and can be sent again', async () => {
  const payer = client(), fam = client(), stranger = client();
  await login(payer, '+12145550600', { name: 'Grace', role: 'payer' });
  await login(fam, '+243810000600', { name: 'Papa', role: 'family' });
  await login(stranger, '+12145550601', { name: 'Stranger', role: 'payer' });
  const inv = await payer('POST', '/api/invites', { relation: 'Father' });
  await admin(`UPDATE ${schema}.invites SET expires_at = 1 WHERE code = '${inv.data.code}'`);
  const late = await fam('POST', '/api/invites/accept', { code: inv.data.code });
  assert.equal(late.status, 410);
  assert.equal(late.data.error, 'invite_expired');
  assert.equal(late.data.message, 'Grace');
  const listed = (await payer('GET', '/api/invites')).data.invites;
  assert.equal(listed[0].expired, true);
  // Only the sender can renew.
  assert.equal((await stranger('POST', `/api/invites/${inv.data.code}/renew`, {})).status, 404);
  const renewed = await payer('POST', `/api/invites/${inv.data.code}/renew`, {});
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.data.code, inv.data.code);
  assert.equal(renewed.data.expired, false);
  // The old code is gone; the new one links them.
  assert.equal((await fam('POST', '/api/invites/accept', { code: inv.data.code })).data.error, 'invalid_invite');
  assert.equal((await fam('POST', '/api/invites/accept', { code: renewed.data.code })).status, 200);
  assert.equal((await payer('POST', `/api/invites/${renewed.data.code}/renew`, {})).data.error, 'invite_already_used');
});

test('an invitation from abroad cannot be accepted by another payer', async () => {
  const p1 = client(), p2 = client();
  await login(p1, '+12145550700', { name: 'P7', role: 'payer' });
  await login(p2, '+12145550701', { name: 'P8', role: 'payer' });
  const inv = await p1('POST', '/api/invites', { relation: 'Brother' });
  assert.equal((await p2('POST', '/api/invites/accept', { code: inv.data.code })).data.error, 'invite_for_family');
});

test('the same bill sent twice is held for review', async () => {
  const payer = client(), family = client();
  await login(payer, '+12145550500', { name: 'P5', role: 'payer' });
  await login(family, '+243810000500', { name: 'F5', role: 'family' });
  await family('POST', '/api/invites/accept', { code: (await payer('POST', '/api/invites', { relation: 'Father' })).data.code });
  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const clinicId = (await family('GET', '/api/clinics')).data.clinics.find((c: { name: string }) => c.name === 'Centre de Santé Amani').id;
  const photo = Buffer.alloc(3000, 7).toString('base64');
  const submit = async (billNumber: string, image = photo) => {
    const d = await family('POST', '/api/bills/extract', { image, mediaType: 'image/jpeg' });
    return (await family('POST', '/api/bills', { draftId: d.data.draftId, payerId, clinicId, patientName: 'Marie T.', billNumber,
      currency: 'USD', items: [{ d: 'Consultation', q: 1, p: 10 }], total: 10 })).data.bill;
  };
  const first = await submit('CSA-1');
  assert.equal(first.status, 'awaiting_clinic');
  // Same photo again, different number typed: caught by the photo fingerprint.
  assert.equal((await submit('CSA-2')).status, 'review');
  // New photo, same number: caught by the bill number, even though prices are normal.
  assert.equal((await submit('CSA-1', Buffer.alloc(3000, 8).toString('base64'))).status, 'review');
  // New photo, no number, same patient/clinic/amount: caught as a similar recent bill.
  assert.equal((await submit('', Buffer.alloc(3000, 9).toString('base64'))).status, 'review');
});

test('duplicate checks tolerate how bills are written', async () => {
  const payer = client(), family = client();
  await login(payer, '+12145550600', { name: 'P6', role: 'payer' });
  await login(family, '+243810000600', { name: 'F6', role: 'family' });
  await family('POST', '/api/invites/accept', { code: (await payer('POST', '/api/invites', { relation: 'Aunt' })).data.code });
  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const clinicId = (await family('GET', '/api/clinics')).data.clinics.find((c: { name: string }) => c.name === 'Polyclinique La Grâce').id;
  let n = 20;
  const submit = async (patientName: string, billNumber: string, total: number) => {
    const d = await family('POST', '/api/bills/extract', { image: Buffer.alloc(3000, n++).toString('base64'), mediaType: 'image/jpeg' });
    return (await family('POST', '/api/bills', { draftId: d.data.draftId, payerId, clinicId, patientName, billNumber,
      currency: 'USD', items: [{ d: 'Consultation', q: 1, p: total }], total })).data.bill;
  };
  assert.equal((await submit('Débora BUDIAYI', 'N° 0457', 10)).status, 'awaiting_clinic');
  // Same number written differently, different amount: still the same bill number.
  const again = await submit('Someone Else', 'FAC-457', 12);
  assert.equal(again.status, 'review');
  // No number, name in another order and without accents, total off by a few cents.
  assert.equal((await submit('Budiayi Debora', '', 10.05)).status, 'review');
  // A title on the bill ("Mme") doesn't make it another person.
  assert.equal((await submit('Mme Débora Budiayi', '', 10)).status, 'review');
  // A genuinely different bill for the same patient (different amount, no number) is not held for being a duplicate.
  assert.equal((await submit('Budiayi Debora', '', 25)).status, 'awaiting_clinic');
});

test('reference prices can differ by facility type and facility', async () => {
  const admin = client(), payer = client(), family = client();
  await login(admin, '+15550000001');
  await login(payer, '+12145550700', { name: 'P7', role: 'payer' });
  await login(family, '+243810000700', { name: 'F7', role: 'family' });
  await family('POST', '/api/invites/accept', { code: (await payer('POST', '/api/invites', { relation: 'Son' })).data.code });
  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  // A private hospital that charges $40 for a consultation; the default price is $10.
  const hosp = (await admin('POST', '/api/admin/clinics', { name: 'Hôpital du Cinquantenaire', commune: 'Kasa-Vubu', payoutAccount: 'Bank 999', category: 'hospital' })).data.clinic;
  assert.equal(hosp.category, 'hospital');
  const saved = await admin('PUT', '/api/admin/prices', { scope: { category: 'hospital' }, prices: [{ name: 'Consultation (hospital)', keywords: 'consult', usd: 40 }] });
  assert.equal(saved.status, 200);
  // Saving one scope leaves the others alone.
  assert.ok(saved.data.prices.some((p: { category: string | null; name: string }) => !p.category && p.name === 'Consultation'));
  const clinics = (await family('GET', '/api/clinics')).data.clinics;
  // Price reasons as the payer sees them (the family only sees the risk level).
  const priceFlags = async (clinicId: string, n: number) => {
    const d = await family('POST', '/api/bills/extract', { image: Buffer.alloc(3000, 60 + n).toString('base64'), mediaType: 'image/jpeg' });
    const b = (await family('POST', '/api/bills', { draftId: d.data.draftId, payerId, clinicId, patientName: `Patient ${n}`, billNumber: '',
      currency: 'USD', items: [{ d: 'Consultation', q: 1, p: 40 }], total: 40 })).data.bill;
    const full = (await payer('GET', `/api/bills/${b.id}`)).data.bill;
    return full.risk.reasons.filter((r: { code: string }) => r.code.startsWith('price_')).map((r: { params: { refScope: string } }) => r.params.refScope);
  };
  // $40 is normal at the hospital, but four times the default price at an ordinary clinic.
  assert.deepEqual(await priceFlags(hosp.id, 1), []);
  const espoir = clinics.find((c: { name: string }) => c.name === 'Centre Médical Espoir');
  assert.deepEqual(await priceFlags(espoir.id, 2), ['general']);
  // A price set for one facility beats the default price.
  await admin('PUT', '/api/admin/prices', { scope: { clinicId: espoir.id }, prices: [{ name: 'Consultation (Espoir)', keywords: ['consult'], usd: 40 }] });
  assert.deepEqual(await priceFlags(espoir.id, 3), []);
});

test('SITE_PASSWORD protects the test site but not the privacy page or webhooks', async () => {
  config.sitePassword = 'test-site-pass';
  try {
    const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: 'manual' });
    const login = (password: string, next: string) => fetch(base + '/__site-login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password, next }).toString(),
    });
    // Pages show a password form (keeping the address to return to); the API answers 401.
    const page = await get('/?invite=ABC123');
    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /name="password"/);
    assert.match(html, /value="\/\?invite=ABC123"/);
    assert.equal(((await (await get('/api/me')).json()) as { error: string }).error, 'site_password_required');
    // Wrong password: the form again. Right password: a cookie, back to where they were going.
    assert.match(await (await login('wrong', '/')).text(), /Wrong password/);
    const ok = await login('test-site-pass', '/?invite=ABC123');
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/?invite=ABC123');
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await get('/', { cookie })).status, 200);
    assert.equal((await get('/api/me', { cookie })).status, 200);
    assert.equal((await get('/', { cookie: 'amc_site=forged' })).status, 401);
    // No redirects to other sites.
    assert.equal((await login('test-site-pass', '//evil.example')).headers.get('location'), '/');
    // The browser password box (Basic auth) still works for scripts.
    assert.equal((await get('/', { authorization: 'Basic ' + Buffer.from('x:test-site-pass').toString('base64') })).status, 200);
    // Public: privacy page, health check, webhooks (protected by their own signatures).
    assert.equal((await get('/privacy.html')).status, 200);
    assert.equal((await get('/healthz')).status, 200);
    const wh = await fetch(`${base}/api/webhooks/payments/sandbox`, { method: 'POST', body: '{}', headers: { 'x-signature': 'nope' } });
    assert.equal(((await wh.json()) as { error: string }).error, 'bad_signature');
  } finally { config.sitePassword = ''; }
});

test('payment webhooks require a valid signature', async () => {
  const api = client();
  const r = await fetch(`${base}/api/webhooks/payments/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'nope' }, body: '{"payment_id":"x","status":"succeeded"}' });
  assert.equal(r.status, 401);
  void api;
});

test('a relative in the DRC can send a bill before the invited relative abroad joins', async () => {
  const fam = client(), abroad = client(), clinic = client(), stranger = client();
  await login(fam, '+243810000900', { name: 'Alain Test', role: 'family' });
  const inv = await fam('POST', '/api/invites', { relation: 'Sister', phone: '+14690009001' });
  // The invitation is renewed before anything is sent: bills follow the new code.
  const renewed = await fam('POST', `/api/invites/${inv.data.code}/renew`, {});
  const code = renewed.data.code;
  const { data: { clinics } } = await fam('GET', '/api/clinics');
  const espoir = clinics.find((c: { name: string }) => c.name === 'Centre Médical Espoir');
  const draft = await fam('POST', '/api/bills/extract', { image: Buffer.alloc(2500, 90).toString('base64'), mediaType: 'image/jpeg' });
  const body = { draftId: draft.data.draftId, clinicId: espoir.id, patientName: 'Waiting Patient', billNumber: 'CME-9001', currency: 'USD',
    items: [{ d: 'Consultation', q: 1, p: 10 }], total: 10 };
  // Someone else's invitation code can't be used.
  await login(stranger, '+243810000901', { name: 'Stranger', role: 'family' });
  assert.equal((await stranger('POST', '/api/bills', { ...body, inviteCode: code })).data.error, 'payer_not_linked');
  const created = await fam('POST', '/api/bills', { ...body, inviteCode: code });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.bill.status, 'awaiting_clinic');
  assert.equal(created.data.bill.payer, null);
  assert.equal(created.data.bill.waitingFor.relation, 'Sister');
  // The hospital confirms while the relative abroad still hasn't joined.
  await login(clinic, '+243810000001');
  assert.equal((await clinic('POST', `/api/bills/${created.data.bill.id}/confirm`, {})).data.bill.status, 'awaiting_payer');
  // The relative abroad accepts: the bill is theirs, and they're told it's ready to pay.
  await login(abroad, '+14690009001', { name: 'Sister Abroad', role: 'payer' });
  assert.equal((await abroad('POST', '/api/invites/accept', { code })).status, 200);
  const theirs = (await abroad('GET', '/api/bills')).data.bills;
  assert.deepEqual(theirs.map((b: any) => b.patientName), ['Waiting Patient']);
  assert.equal(theirs[0].status, 'awaiting_payer');
  assert.ok(await one("SELECT 1 FROM messages WHERE to_phone = '+14690009001' AND body LIKE '%Waiting Patient%'"));
  const famView = (await fam('GET', `/api/bills/${created.data.bill.id}`)).data.bill;
  assert.equal(famView.payer.name, 'Sister Abroad');
  assert.equal(famView.waitingFor, undefined);
  assert.equal((await abroad('POST', `/api/bills/${created.data.bill.id}/pay`, {})).status, 200);
});

test('QA: a bill with a total of 0, or without a photo, is refused', async () => {
  const fam = client(), abroad = client();
  await login(fam, '+243810000950', { name: 'Zero Family', role: 'family' });
  await login(abroad, '+12145550950', { name: 'Zero Payer', role: 'payer' });
  const inv = await abroad('POST', '/api/invites', { relation: 'Cousin' });
  await fam('POST', '/api/invites/accept', { code: inv.data.code });
  const payerId = (await fam('GET', '/api/payers')).data.payers[0].id;
  const clinicId = (await fam('GET', '/api/clinics')).data.clinics[0].id;
  const base = { payerId, clinicId, patientName: 'Zero Patient', currency: 'USD' };
  assert.equal((await fam('POST', '/api/bills', { ...base, draftId: await photo(fam), items: [{ d: 'Consultation', q: 1, p: 0 }], total: 0 })).data.error, 'invalid_total');
  assert.equal((await fam('POST', '/api/bills', { ...base, draftId: await photo(fam), items: [{ d: 'Consultation', q: 1, p: 0 }] })).data.error, 'invalid_total');
  // QA BUG-001, decided 22 Nov 2026: the photo is required, so a bill typed without one is refused.
  assert.equal((await fam('POST', '/api/bills', { ...base, items: [{ d: 'Consultation', q: 1, p: 10 }], total: 10 })).data.error, 'photo_required');
});

test('admin can edit, deactivate, reactivate and delete a hospital', async () => {
  const adm = client(), fam = client(), abroad = client();
  await login(adm, '+15550000001');
  const created = await adm('POST', '/api/admin/clinics', { name: 'Clinique Temporaire', commune: 'Gombe', city: 'Kinshasa', payoutMethod: 'bank', payoutAccount: 'Rawbank 0001' });
  const id = created.data.clinic.id;
  // Edit every detail, FlexPay included.
  const edited = await adm('PATCH', `/api/admin/clinics/${id}`, { name: 'Clinique Temporaire II', category: 'hospital', commune: 'Lingwala', city: 'Kinshasa',
    whatsappPhone: '+243810000777', payoutMethod: 'mpesa', payoutAccount: 'M-Pesa ••0777', flexpayMerchant: 'CT002', payoutPhone: '+243810000777' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const c = (await adm('GET', '/api/admin/clinics')).data.clinics.find((x: { id: string }) => x.id === id);
  assert.deepEqual([c.name, c.category, c.commune, c.whatsapp_phone, c.payout_method, c.flexpay_merchant, c.payout_phone],
    ['Clinique Temporaire II', 'hospital', 'Lingwala', '+243810000777', 'mpesa', 'CT002', '+243810000777']);
  // Deactivated: families can't pick it; reactivated: they can again.
  await login(fam, '+243810000960', { name: 'Edit Family', role: 'family' });
  await adm('PATCH', `/api/admin/clinics/${id}`, { active: false });
  assert.ok(!(await fam('GET', '/api/clinics')).data.clinics.some((x: { id: string }) => x.id === id));
  await adm('PATCH', `/api/admin/clinics/${id}`, { active: true });
  assert.ok((await fam('GET', '/api/clinics')).data.clinics.some((x: { id: string }) => x.id === id));
  // A hospital with bills can't be deleted (only deactivated)...
  await login(abroad, '+12145550960', { name: 'Edit Payer', role: 'payer' });
  const inv = await abroad('POST', '/api/invites', { relation: 'Aunt' });
  await fam('POST', '/api/invites/accept', { code: inv.data.code });
  const payerId = (await fam('GET', '/api/payers')).data.payers[0].id;
  await fam('POST', '/api/bills', { draftId: await photo(fam), payerId, clinicId: id, patientName: 'Kept Patient', currency: 'USD', items: [{ d: 'Consultation', q: 1, p: 9 }], total: 9 });
  const refused = await adm('DELETE', `/api/admin/clinics/${id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'clinic_has_bills');
  // ...one without bills can, with its staff and its own prices.
  const empty = (await adm('POST', '/api/admin/clinics', { name: 'Clinique Vide', payoutMethod: 'bank', payoutAccount: 'TMB 0002' })).data.clinic.id;
  await adm('POST', '/api/admin/users', { name: 'Caissier', phone: '+243810000961', role: 'clinic', clinicId: empty });
  assert.equal((await adm('DELETE', `/api/admin/clinics/${empty}`)).status, 200);
  assert.ok(!(await adm('GET', '/api/admin/clinics')).data.clinics.some((x: { id: string }) => x.id === empty));
  assert.equal(await one("SELECT 1 FROM users WHERE phone = '+243810000961'"), undefined);
  // Only admins can do any of this.
  assert.equal((await fam('DELETE', `/api/admin/clinics/${id}`)).status, 403);
});

test('pages on the old onrender.com address move to the official domain; nothing else is redirected', async () => {
  // fetch() can't set the Host header, so plain http requests here.
  const { request } = await import('node:http');
  const get = (path: string, host: string) => new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const u = new URL(base + path);
    request({ hostname: u.hostname, port: u.port, path, headers: { host } }, (r) => { r.resume(); resolve({ status: r.statusCode!, location: r.headers.location }); }).on('error', reject).end();
  });
  const saved = { baseUrl: config.baseUrl, on: config.canonicalRedirect };
  config.baseUrl = 'https://myamanicare.com'; config.canonicalRedirect = true;
  try {
    const old = await get('/?invite=ABC123&as=payer', 'amanicare-t6sm.onrender.com');
    assert.equal(old.status, 301);
    assert.equal(old.location, 'https://myamanicare.com/?invite=ABC123&as=payer');
    assert.equal((await get('/api/clinics', 'amanicare-t6sm.onrender.com')).status, 401); // API and webhooks: never redirected
    assert.equal((await get('/healthz', 'amanicare-t6sm.onrender.com')).status, 200);
    // Any other address is served as is: no loop, whatever Host the proxies pass on.
    for (const host of ['myamanicare.com', 'www.myamanicare.com', 'myamanicare.com:443', 'internal-host:10000']) {
      assert.equal((await get('/privacy.html', host)).status, 200, host);
    }
  } finally { config.baseUrl = saved.baseUrl; config.canonicalRedirect = saved.on; }
});

test('phone numbers: a forgotten Congolese country code is added; other numbers need one', async () => {
  const { phone } = await import('../server/http.js');
  for (const raw of ['0812345678', '812345678', '243812345678', '00243812345678', '+243 0812 345 678', '+243 81 234 56 78', '081-234-5678'])
    assert.equal(phone(raw), '+243812345678', raw);
  assert.equal(phone('+1 (214) 555-0100'), '+12145550100');
  assert.equal(phone('0033612345678'), '+33612345678');
  assert.throws(() => phone('2145550100'), /phone_country_code|Add the country code/);
  assert.throws(() => phone('+24381234567'), /invalid_phone|9 digits/); // one digit short
  // The API applies the same rule: a family member can log in without typing +243.
  const fam = client();
  const { data } = await fam('POST', '/api/auth/request-otp', { phone: '0819990001' });
  assert.ok(data.devCode);
  assert.equal((await fam('POST', '/api/auth/request-otp', { phone: '2145550100' })).data.error, 'phone_country_code');
});

test('admins add other admins and remove or restore access', async () => {
  const owner = client(); await login(owner, '+15550000001');
  const add = await owner('POST', '/api/admin/users', { name: 'Grace', phone: '0815550002', role: 'admin' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.user.phone, '+243815550002');
  const grace = client(); await login(grace, '+243815550002');
  assert.equal((await grace('GET', '/api/admin/overview')).status, 200); // the new admin is an admin
  const list = (await grace('GET', '/api/admin/users')).data;
  assert.ok(list.users.some((u: { name: string; role: string }) => u.name === 'Grace' && u.role === 'admin'));
  const ownerId = list.users.find((u: { phone: string }) => u.phone === '+15550000001').id;
  const graceId = add.data.user.id;
  // Nobody can lock themselves out, and the owner (ADMIN_PHONE) can't be removed.
  assert.equal((await grace('PATCH', `/api/admin/users/${graceId}`, { active: false })).data.error, 'cannot_disable_self');
  assert.equal((await grace('PATCH', `/api/admin/users/${ownerId}`, { active: false })).data.error, 'cannot_disable_owner');
  // The owner removes Grace: her session ends at once and she can't get a new code.
  assert.equal((await owner('PATCH', `/api/admin/users/${graceId}`, { active: false })).status, 200);
  assert.equal((await grace('GET', '/api/admin/overview')).status, 401);
  assert.equal((await grace('POST', '/api/auth/request-otp', { phone: '+243815550002' })).data.error, 'account_disabled');
  // Restored: she can sign in again.
  assert.equal((await owner('PATCH', `/api/admin/users/${graceId}`, { active: true })).status, 200);
  await login(grace, '+243815550002');
  assert.equal((await grace('GET', '/api/admin/overview')).status, 200);
});

test('every answer says which version is running, so open pages can offer the update', async () => {
  const r = await fetch(base + '/healthz');
  const v = r.headers.get('x-app-version');
  assert.ok(v && v.length >= 6);
  assert.equal((await fetch(base + '/api/clinics')).headers.get('x-app-version'), v);
});

test('admins see payers and families, can search them, and can remove a fraudster\'s access', async () => {
  const owner = client(); await login(owner, '+15550000001');
  const all = (await owner('GET', '/api/admin/customers')).data;
  assert.ok(all.counts.payers >= 1 && all.counts.families >= 1);
  assert.ok(all.customers.every((c: { role: string }) => c.role === 'payer' || c.role === 'family'));
  const someone = all.customers[0];
  const found = (await owner('GET', '/api/admin/customers?q=' + encodeURIComponent(someone.phone.slice(-6)))).data.customers;
  assert.ok(found.some((c: { id: string }) => c.id === someone.id));
  assert.equal((await owner('PATCH', `/api/admin/users/${someone.id}`, { active: false })).status, 200);
  assert.equal((await client()('POST', '/api/auth/request-otp', { phone: someone.phone })).data.error, 'account_disabled');
  assert.equal((await owner('PATCH', `/api/admin/users/${someone.id}`, { active: true })).status, 200);
  // Families and payers can't see this list.
  const fam = client(); await login(fam, '+243819990002', { name: 'Test', role: 'family' });
  assert.equal((await fam('GET', '/api/admin/customers')).status, 403);
});

test('admins change a payer\'s or family member\'s number, and delete accounts that have no bills', async () => {
  const owner = client(); await login(owner, '+15550000001');
  const fam = client(); await login(fam, '+243819990010', { name: 'Ancien Numéro', role: 'family' });
  const id = (await fam('GET', '/api/me')).data.user.id;
  // New number, typed without +243: the person now signs in with it, and the old number is free.
  assert.equal((await owner('PATCH', `/api/admin/users/${id}`, { name: 'Nouveau Numéro', phone: '0819990011' })).status, 200);
  const again = client(); const me = await login(again, '+243819990011');
  assert.equal(me.user.id, id); assert.equal(me.user.name, 'Nouveau Numéro');
  assert.equal((await owner('PATCH', `/api/admin/users/${id}`, { phone: '+15550000001' })).data.error, 'phone_in_use');
  // Someone with bills can't be deleted; someone without can.
  const withBills = (await owner('GET', '/api/admin/customers')).data.customers.find((c: { bills: number }) => c.bills > 0);
  assert.equal((await owner('DELETE', `/api/admin/users/${withBills.id}`)).data.error, 'user_has_bills');
  assert.equal((await owner('DELETE', `/api/admin/users/${id}`)).status, 200);
  assert.equal(await one('SELECT 1 FROM users WHERE id = $1', id), undefined);
  assert.equal((await again('GET', '/api/me')).data.user, null); // signed out
});

test('files are downloaded again only after a new deploy; the page names its version', async () => {
  const r = await fetch(base + '/');
  const html = await r.text();
  const v = r.headers.get('x-app-version')!;
  assert.equal(r.headers.get('cache-control'), 'no-cache'); // re-checked on each load…
  const again = await fetch(base + '/', { headers: { 'if-none-match': r.headers.get('etag')! } });
  assert.equal(again.status, 304); // …but nothing is downloaded when no new version was deployed
  assert.ok(html.includes(`src="/app.js?v=${v}"`) && html.includes(`href="/styles.css?v=${v}"`));
  assert.ok(html.includes(`<meta name="app-version" content="${v}">`));
  const js = await fetch(base + `/app.js?v=${v}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control')!, /immutable/); // this deploy's code: kept, never re-downloaded
  assert.equal((await fetch(base + '/app.js?v=old')).headers.get('cache-control'), 'no-cache'); // an old page still gets checked
});

test('admin lists load page by page, with totals, filters and search', async () => {
  const owner = client(); await login(owner, '+15550000001');
  const { run } = await import('../server/db.js');
  for (let i = 0; i < 120; i++) {
    await run("INSERT INTO users(id, phone, name, role, lang) VALUES($1,$2,$3,'family','fr')", `bulk-${i}`, `+24382${String(i).padStart(7, '0')}`, `Bulk ${i}`);
  }
  const p1 = (await owner('GET', '/api/admin/customers?kind=family')).data;
  assert.equal(p1.customers.length, 50);
  assert.ok(p1.total >= 120 && p1.hasMore);
  const p2 = (await owner('GET', '/api/admin/customers?kind=family&offset=50')).data;
  assert.equal(p2.customers.length, 50);
  assert.equal(new Set([...p1.customers, ...p2.customers].map((c: { id: string }) => c.id)).size, 100); // no repeats between pages
  assert.ok(p1.customers.every((c: { role: string }) => c.role === 'family'));
  const one = (await owner('GET', '/api/admin/customers?q=Bulk%20117')).data;
  assert.equal(one.total, 1); assert.equal(one.hasMore, false);
  // Bills: the review queue is fetched on its own, whatever the number of other bills.
  const r = (await owner('GET', '/api/bills?status=review&limit=100')).data;
  assert.ok(r.bills.every((b: { status: string }) => b.status === 'review'));
  const all = (await owner('GET', '/api/bills?limit=2')).data;
  assert.ok(all.bills.length <= 2 && typeof all.total === 'number');
  assert.ok((await owner('GET', '/api/admin/messages?limit=5')).data.messages.length <= 5);
});

test('customer service: a visitor gives a number with its country code; the team answers; nobody else sees it', async () => {
  const { resetLimitsForTests } = await import('../server/support.js');
  resetLimitsForTests();
  const guest = client();
  // A US number without +1 is refused: we would not know where to answer.
  assert.equal((await guest('POST', '/api/support/tickets', { text: 'Bonjour', phone: '2145550100' })).data.error, 'phone_country_code');
  const r = await guest('POST', '/api/support/tickets', { text: 'Combien coûte le service ?', phone: '+12145550100', name: 'Marie', lang: 'fr' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { ticket, token } = r.data;
  assert.ok(token);
  // No assistant configured in tests: it goes straight to a person, and the person is told so.
  assert.equal(ticket.status, 'open');
  assert.deepEqual(ticket.messages.map((m: { from: string }) => m.from), ['user', 'system']);
  // Without the token (or with another one) the conversation can't be read.
  assert.equal((await guest('GET', `/api/support/tickets/${ticket.id}`)).status, 404);
  const withToken = (tok: string) => fetch(`${base}/api/support/tickets/${ticket.id}`, { headers: { 'x-support-token': tok } });
  assert.equal((await withToken('nope')).status, 404);
  assert.equal((await withToken(token)).status, 200);
  // The team was alerted, and sees it in "to handle".
  assert.ok(await one("SELECT 1 FROM messages WHERE payload LIKE '%support_alert%'"));
  const owner = client(); await login(owner, '+15550000001');
  const list = (await owner('GET', '/api/admin/support?status=open')).data;
  const row = list.tickets.find((x: { id: string }) => x.id === ticket.id);
  assert.equal(row.phone, '+12145550100'); assert.equal(row.signedIn, false); assert.ok(list.counts.open >= 1);
  // The agent answers: shown in the chat, sent on WhatsApp, waiting for the person.
  assert.equal((await owner('POST', `/api/admin/support/${ticket.id}/messages`, { text: 'Rien pour la famille; le payeur paie de petits frais.' })).status, 200);
  assert.ok(await one("SELECT 1 FROM messages WHERE to_phone = '+12145550100' AND payload LIKE '%support_reply%'"));
  const seen = (await (await withToken(token)).json()) as any;
  assert.equal(seen.ticket.status, 'waiting'); assert.equal(seen.ticket.messages.at(-1).from, 'agent');
  // The person writes again: back to the team (the assistant stays out once a person is on it).
  const again = await fetch(`${base}/api/support/tickets/${ticket.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-support-token': token }, body: JSON.stringify({ text: 'Merci !' }) });
  const after = ((await again.json()) as any).ticket;
  assert.equal(after.status, 'open'); assert.equal(after.messages.at(-1).from, 'user');
  assert.equal((await owner('PATCH', `/api/admin/support/${ticket.id}`, { status: 'resolved' })).status, 200);
  // Families and payers can't see the team's inbox.
  const fam = client(); await login(fam, '+243819990020', { name: 'Fam Support', role: 'family' });
  assert.equal((await fam('GET', '/api/admin/support')).status, 403);
  assert.equal((await fam('GET', `/api/support/tickets/${ticket.id}`)).status, 404);
});

test('customer service: the assistant sees only the signed-in person\'s own bills, and hands over on money problems', async () => {
  const { accountContext, setAnswererForTests, resetLimitsForTests, mustEscalate } = await import('../server/support.js');
  resetLimitsForTests();
  const bills = await import('../server/bills.js');
  const somePayer = await one<{ id: string }>("SELECT payer_id id FROM bills WHERE payer_id IS NOT NULL LIMIT 1");
  assert.ok(somePayer, 'demo data has bills');
  const payer = (await one<any>('SELECT * FROM users WHERE id = $1', somePayer!.id))!;
  const mine = await bills.listBillsFor(payer);
  const others = await one<{ ref: string }>('SELECT ref FROM bills WHERE payer_id IS DISTINCT FROM $1 LIMIT 1', payer.id);
  const ctx = await accountContext(payer);
  // The assistant's instructions carry the help centre in the person's language, and the guest rule.
  const { systemPrompt } = await import('../server/support.js');
  const guestPrompt = await systemPrompt({ lang: 'fr', bill_id: null } as any, null);
  assert.match(guestPrompt, /Combien ça coûte/); assert.match(guestPrompt, /NOT signed in/); assert.ok(!guestPrompt.includes(mine[0].ref));
  assert.ok((await systemPrompt({ lang: 'en', bill_id: null } as any, payer)).includes(mine[0].ref));
  assert.ok(mine.every((b) => ctx.includes(b.ref)));
  if (others) assert.ok(!ctx.includes(others.ref));

  // With an assistant: it answers; asking about a refund goes to a person without asking it.
  let calls = 0;
  setAnswererForTests(async () => { calls++; return { reply: 'Votre facture est payée.', handoff: false, reason: '' }; });
  try {
    const api = client(); await login(api, payer.phone);
    const own = mine[0];
    const r = (await api('POST', '/api/support/tickets', { text: 'Où en est ma facture ?', billId: own.id })).data.ticket;
    assert.equal(r.status, 'bot'); assert.equal(r.messages.at(-1).body, 'Votre facture est payée.'); assert.equal(r.billId, own.id);
    const r2 = (await api('POST', `/api/support/tickets/${r.id}/messages`, { text: 'Je veux un remboursement' })).data.ticket;
    assert.equal(r2.status, 'open'); assert.equal(calls, 1);
    assert.equal(mustEscalate('je veux parler à un agent'), 'asked_for_person');
    assert.equal(mustEscalate('Combien de temps ça prend ?'), '');
    assert.equal(mustEscalate("J'ai payé mais l'hôpital n'a rien reçu"), 'sensitive');
    // Someone else's bill can't be attached to a conversation.
    if (others) {
      const otherId = (await one<{ id: string }>('SELECT id FROM bills WHERE ref = $1', others.ref))!.id;
      assert.equal((await api('POST', '/api/support/tickets', { text: 'Et celle-ci ?', billId: otherId })).status, 404);
    }
    // "Talk to a person" from the assistant.
    const r3 = (await api('POST', '/api/support/tickets', { text: 'Comment inviter ma sœur ?' })).data.ticket;
    assert.equal((await api('POST', `/api/support/tickets/${r3.id}/escalate`)).data.ticket.status, 'open');
    assert.equal((await api('GET', '/api/support/tickets')).data.tickets.length >= 2, true);
  } finally { setAnswererForTests(null); }
});
