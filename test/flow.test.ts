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

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;
function client(): Api {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  };
}
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
  const rev = await admin('POST', `/api/bills/${dup.data.bill.id}/review`, { approve: false });
  assert.equal(rev.data.bill.status, 'rejected');
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
  const { data: { bill } } = await family('POST', '/api/bills', { payerId, clinicId: c.id, patientName: 'Patrick M.', billNumber: 'CBS-77', currency: 'CDF', items: [{ d: 'Consultation', q: 1, p: 28500 }], total: 28500 });
  assert.equal(bill.totalUsd, 10);
  await login(clinic, '+243810000002');
  await clinic('POST', `/api/bills/${bill.id}/confirm`, {});
  const p1 = await payer('POST', `/api/bills/${bill.id}/pay`, {});
  await payer('POST', `/api/sandbox/payments/${p1.data.paymentId}/complete`, { outcome: 'fail' });
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.status, 'payment_failed');
  const p2 = await payer('POST', `/api/bills/${bill.id}/pay`, {});
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

test('payment webhooks require a valid signature', async () => {
  const api = client();
  const r = await fetch(`${base}/api/webhooks/payments/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'nope' }, body: '{"payment_id":"x","status":"succeeded"}' });
  assert.equal(r.status, 401);
  void api;
});
