// FlexPay (pilot payment partner), with the FlexPay API simulated: mobile money and card collections,
// direct payment to a hospital's own merchant account, payouts, and callbacks re-checked with FlexPay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';

process.env.UPLOAD_DIR = 'data/test-uploads';
process.env.OTP_DEV = '1';
process.env.ADMIN_PHONE = '+15550000001';
process.env.SANDBOX_PAYOUT_DELAY_MS = '0';
process.env.PAYMENT_PARTNER = 'flexpay';
process.env.FLEXPAY_TOKEN = 'fx-test-token';
process.env.FLEXPAY_MERCHANT = 'AMANICARE';
process.env.ANTHROPIC_API_KEY = '';
process.env.MESSAGING = 'sandbox';

// Simulated FlexPay API. Transactions stay pending until the test settles them.
type Tx = { reference: string; status: string; merchant: string; kind: string; body: any };
const txs = new Map<string, Tx>();
const calls: { url: string; auth: string; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/flexpa(y|ie)\.(cd|com)/.test(url)) return realFetch(input, init);
  const auth = String((init?.headers as Record<string, string>)?.authorization || '');
  if (url.includes('/check/')) {
    const t = txs.get(decodeURIComponent(url.split('/check/')[1]));
    return Response.json(t ? { code: '0', transaction: { reference: t.reference, status: t.status } } : { code: '1', message: 'not found' });
  }
  const body = JSON.parse(String(init?.body));
  calls.push({ url, auth, body });
  const orderNumber = `FX${calls.length}`;
  const kind = url.includes('vpos') ? 'card' : url.includes('PayOut') ? 'payout' : 'mobile';
  txs.set(orderNumber, { reference: body.reference, status: '2', merchant: body.merchant, kind, body });
  return Response.json({ code: '0', message: 'ok', orderNumber, ...(kind === 'card' ? { url: `https://cardpayment.flexpay.cd/pay/${orderNumber}` } : {}) });
}) as typeof fetch;

const { config } = await import('../server/config.js');
const { openDb, closeDb, one } = await import('../server/db.js');
const { migrate } = await import('../server/migrate.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { createApp } = await import('../server/index.js');

const databaseUrl = process.env.TEST_DATABASE_URL || config.databaseUrl;
const schema = `test_fx_${process.pid}_${Date.now().toString(36)}`;
async function admin(sql: string) {
  const c = new pg.Client({ connectionString: databaseUrl }); await c.connect();
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
    const res = await realFetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
}
/** A photo of the bill (required): a unique fake image per call, read into a draft. */
/** A fake photo: JPEG's first bytes, then filler (the server checks the file really is a JPEG). */
const fakeJpeg = (n: number, fill: number): string => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, fill)]).toString('base64');
let photoN = 0;
const photo = async (api: Api): Promise<string> => (await api('POST', '/api/bills/extract', { image: fakeJpeg(2600, 150 + (photoN++ % 100)), mediaType: 'image/jpeg' })).data.draftId;

async function login(api: Api, phone: string, profile: Record<string, string> = {}) {
  const { data } = await api('POST', '/api/auth/request-otp', { phone });
  return api('POST', '/api/auth/verify', { phone, code: data.devCode, ...profile });
}
/** FlexPay's callback: unsigned, so the app must re-check it with FlexPay before believing it. */
const callback = (body: unknown) => realFetch(`${base}/api/webhooks/payments/flexpay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const billStatus = async (api: Api, id: string) => (await api('GET', `/api/bills/${id}`)).data.bill.status;
async function waitFor(api: Api, id: string, status: string) {
  for (let i = 0; i < 40; i++) { if ((await billStatus(api, id)) === status) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(await billStatus(api, id), status);
}

const adm = client(), payer = client(), family = client(), clinic = client();
let payerId = '';
async function confirmedBill(clinicName: string, clinicPhone: string, n: number) {
  const { data: { clinics } } = await family('GET', '/api/clinics');
  const c = clinics.find((x: { name: string }) => x.name === clinicName);
  const { data: { bill } } = await family('POST', '/api/bills', { draftId: await photo(family), payerId, clinicId: c.id, patientName: `FX Patient ${n}`, billNumber: `FX-${n}`, currency: 'USD', items: [{ d: 'Consultation', q: 1, p: 20 }], total: 20 });
  await login(clinic, clinicPhone);
  assert.equal((await clinic('POST', `/api/bills/${bill.id}/confirm`, {})).data.bill.status, 'awaiting_payer');
  return { bill, clinicId: c.id };
}

test('FlexPay: setup', async () => {
  await login(adm, '+15550000001');
  await login(payer, '+12145550900', { name: 'FX Payer', role: 'payer' });
  await login(family, '+243810000900', { name: 'FX Family', role: 'family' });
  const inv = await payer('POST', '/api/invites', { relation: 'Sister' });
  await family('POST', '/api/invites/accept', { code: inv.data.code });
  payerId = (await family('GET', '/api/payers')).data.payers[0].id;
});

test('FlexPay direct: mobile money straight into the hospital\'s own merchant account', async () => {
  const { bill, clinicId } = await confirmedBill('Centre Médical Espoir', '+243810000001', 1);
  assert.equal((await adm('PATCH', `/api/admin/clinics/${clinicId}`, { flexpayMerchant: 'CME001' })).status, 200);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'orange', walletPhone: '+243 89 555 0101' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  assert.equal(pay.data.checkoutUrl, null); // mobile money: approved on the phone, no page
  const req = calls.at(-1)!;
  assert.match(req.url, /paymentService$/);
  assert.equal(req.auth, 'Bearer fx-test-token');
  assert.equal(req.body.merchant, 'CME001'); // the hospital's account, not AmaniCare's
  assert.equal(req.body.phone, '243895550101');
  assert.equal(req.body.amount, (bill.totalUsd + bill.feeUsd).toFixed(2));
  assert.equal(req.body.reference, pay.data.paymentId);

  // A forged "success" callback while FlexPay still says pending changes nothing.
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: 'FX1' });
  assert.equal(await billStatus(payer, bill.id), 'payment_pending');
  // A callback pointing at another (successful) transaction changes nothing either.
  txs.set('FXOTHER', { reference: 'someone-else', status: '0', merchant: 'X', kind: 'mobile', body: {} });
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: 'FXOTHER' });
  assert.equal(await billStatus(payer, bill.id), 'payment_pending');

  // A callback forged as the sandbox partner, correctly signed with the (public) development secret,
  // is refused: only the partner in use may report, and only on its own payments.
  const { hmacHex } = await import('../server/payments/partners.js');
  const forged = JSON.stringify({ payment_id: pay.data.paymentId, status: 'succeeded' });
  const fr = await realFetch(`${base}/api/webhooks/payments/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': hmacHex(config.paymentWebhookSecret, forged) }, body: forged });
  assert.equal(fr.status, 404);
  assert.equal(await billStatus(payer, bill.id), 'payment_pending');

  // The payer approves on the phone: FlexPay confirms, the hospital already has the money.
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '0';
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await waitFor(payer, bill.id, 'paid');
  const payout = await one<{ partner_ref: string; status: string }>("SELECT partner_ref, status FROM payments WHERE bill_id = $1 AND kind = 'payout'", bill.id);
  assert.equal(payout!.status, 'succeeded');
  assert.equal(payout!.partner_ref, `direct:${order}`);
  assert.equal(calls.filter((c) => /PayOut/.test(c.url)).length, 0); // nothing sent: no money passed through AmaniCare
});

test('FlexPay through AmaniCare: card payment, then payout to the hospital\'s wallet', async () => {
  const { bill, clinicId } = await confirmedBill('Polyclinique La Grâce', '+243810000003', 2);
  await adm('PATCH', `/api/admin/clinics/${clinicId}`, { payoutPhone: '+243 81 000 7710' });
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' });
  assert.match(pay.data.checkoutUrl, /^https:\/\/cardpayment\.flexpay\.cd\//);
  const req = calls.at(-1)!;
  assert.match(req.url, /vpos\/ask$/);
  assert.equal(req.body.merchant, 'AMANICARE');
  assert.equal(req.body.callback_url, `${config.baseUrl}/api/webhooks/payments/flexpay`);

  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '0';
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await waitFor(payer, bill.id, 'paying_out');
  const out = calls.at(-1)!;
  assert.match(out.url, /merchantPayOutService$/);
  assert.equal(out.body.merchant, 'AMANICARE');
  assert.equal(out.body.phone, '243810007710');
  assert.equal(out.body.amount, bill.totalUsd.toFixed(2)); // the hospital gets the bill; the fee stays

  const outOrder = [...txs.entries()].find(([, t]) => t.reference === out.body.reference)![0];
  txs.get(outOrder)!.status = '0';
  await callback({ code: '0', reference: out.body.reference, orderNumber: outOrder });
  await waitFor(payer, bill.id, 'paid');
});

test('FlexPay: a bank-only hospital without a merchant code needs an operator', async () => {
  const { bill } = await confirmedBill('Clinique Bonne Santé', '+243810000002', 3);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243815550199' });
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '0';
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await waitFor(payer, bill.id, 'payout_failed');
  const p = await one<{ failure_reason: string }>("SELECT failure_reason FROM payments WHERE bill_id = $1 AND kind = 'payout'", bill.id);
  assert.match(p!.failure_reason, /FlexPay dashboard/);
});

test('FlexPay: a refused mobile-money payment can be tried again', async () => {
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 4);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'airtel', walletPhone: '+243975550101' });
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '1';
  await callback({ code: '1', reference: pay.data.paymentId, orderNumber: order, message: 'Solde insuffisant' });
  await waitFor(payer, bill.id, 'payment_failed');
  assert.equal((await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' })).status, 200);
});
