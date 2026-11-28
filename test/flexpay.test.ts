// FlexPaie (pilot payment partner), with FlexPaie's API simulated as documented (PAYIN Corporate v2.0 and
// Check Status v2.0): mobile money and card collections, direct payment to a hospital's own merchant account,
// payouts, and callbacks re-checked with the check API (reference, amount and currency).
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
process.env.FLEXPAY_TOKEN = ' Bearer fx-test-token ';
process.env.FLEXPAY_MERCHANT = 'AMANICARE';
process.env.FLEXPAY_BASE_URL = 'https://test.flexpaie.com/';
process.env.FLEXPAY_PAYOUT_URL = 'https://test.flexpaie.com/api/rest/v1/merchantPayOutService';
process.env.ANTHROPIC_API_KEY = '';
process.env.MESSAGING = 'sandbox';

// Simulated FlexPay API. Transactions stay pending until the test settles them.
type Tx = { reference: string; status: string; merchant: string; kind: string; body: any; amount?: string; currency?: string };
const txs = new Map<string, Tx>();
const calls: { url: string; auth: string; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/flexpa(y|ie)\.(cd|com)/.test(url)) return realFetch(input, init);
  const auth = String((init?.headers as Record<string, string>)?.authorization || '');
  if (url.includes('/check/')) {
    const t = txs.get(decodeURIComponent(url.split('/check/')[1]));
    return Response.json(t ? { code: '0', message: 'Une transaction trouvée', transaction: { orderNumber: 'x', reference: t.reference, status: t.status,
      amount: t.amount ?? `${Number(t.body.amount ?? 0).toFixed(1)}`, amountCustomer: '0', currency: t.currency ?? t.body.currency, createdAt: '27-11-2026 10:00:00', channel: 'mpesa' } }
      : { code: '1', message: 'Aucune transaction trouvée', transaction: null });
  }
  const body = JSON.parse(String(init?.body));
  calls.push({ url, auth, body });
  const orderNumber = `FX${calls.length}`;
  const kind = url.includes('PayOut') ? 'payout' : body.type === '2' ? 'card' : 'mobile';
  txs.set(orderNumber, { reference: body.reference, status: '2', merchant: body.merchant, kind, body });
  return Response.json({ code: '0', message: 'ok', orderNumber, ...(kind === 'card' ? { url: `https://test.flexpaie.com/gwvisa/${orderNumber}` } : {}) });
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
  assert.equal(req.url, 'https://test.flexpaie.com/api/rest/v1/paymentService');
  assert.equal(req.auth, 'Bearer fx-test-token');
  assert.equal(req.body.type, '1');
  assert.equal(req.body.currency, 'USD');
  assert.equal(req.body.callback_url, `${config.baseUrl}/api/webhooks/payments/flexpay`);
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
  assert.match(pay.data.checkoutUrl, /^https:\/\/test\.flexpaie\.com\/gwvisa\//);
  const req = calls.at(-1)!;
  assert.equal(req.url, 'https://test.flexpaie.com/api/rest/v1/paymentService'); // cards use the same service, type 2
  assert.equal(req.body.type, '2');
  for (const [k, r] of [['approve_url', 'approve'], ['cancel_url', 'cancel'], ['decline_url', 'decline']]) assert.equal(req.body[k], `${config.baseUrl}/?bill=${bill.id}&pay=${r}`);
  assert.equal(req.body.phone, undefined);
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
  assert.match(p!.failure_reason, /FlexPaie dashboard/);
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

test('FlexPaie: a success for a different amount does not settle the bill', async () => {
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 5);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243815550188' });
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  Object.assign(txs.get(order)!, { status: '0', amount: '1.0' });
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await billStatus(payer, bill.id), 'payment_pending');
  const a = await one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'flexpay_amount_mismatch' ORDER BY id DESC LIMIT 1");
  assert.match(a!.detail, new RegExp(pay.data.paymentId));
  // The same amount in another currency doesn't count either.
  Object.assign(txs.get(order)!, { amount: undefined, currency: 'CDF' });
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await billStatus(payer, bill.id), 'payment_pending');
});

test('FlexPaie: a refunded or cancelled payment counts as not paid', async () => {
  const { flexpayStatus } = await import('../server/payments/flexpay.js');
  assert.deepEqual(['0', '1', '2', '3', '4', '5', ''].map(flexpayStatus), ['succeeded', 'failed', 'pending', 'failed', 'failed', 'failed', 'pending']);
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 6);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243815550177' });
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '4';
  await callback({ code: '1', reference: pay.data.paymentId, orderNumber: order });
  await waitFor(payer, bill.id, 'payment_failed');
  const p = await one<{ failure_reason: string }>('SELECT failure_reason FROM payments WHERE id = $1', pay.data.paymentId);
  assert.match(p!.failure_reason, /refunded/);
});

test('FlexPaie card: back through "cancel", the attempt ends; a late confirmation still counts', async () => {
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 7);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' });
  assert.equal(pay.status, 200);
  // FlexPaie still says pending (no callback came): a plain check changes nothing yet.
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {})).data.bill.status, 'payment_pending');
  // Someone else can't touch it.
  const stranger = client(); await login(stranger, '+15550003301', { name: 'Stranger', role: 'payer' });
  assert.equal((await stranger('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'cancel' })).status, 404);
  // Back through "cancel": the attempt ends, the payer can try again.
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'cancel' })).data.bill.status, 'payment_failed');
  const p = await one<{ failure_reason: string; status: string }>('SELECT failure_reason, status FROM payments WHERE id = $1', pay.data.paymentId);
  assert.equal(p!.status, 'failed');
  assert.match(p!.failure_reason, /cancelled/);
  // FlexPaie then says it was paid after all: the money counts, the bill goes on to the hospital.
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '0';
  await callback({ code: '0', reference: pay.data.paymentId, orderNumber: order });
  await waitFor(payer, bill.id, 'paid');
});

test('FlexPaie: a pending payment is settled when the payer\'s page asks again', async () => {
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 8);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243815550166' });
  const order = [...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0];
  txs.get(order)!.status = '0'; // paid, but FlexPaie's callback never came
  const r = await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {});
  assert.notEqual(r.data.bill.status, 'payment_pending');
  await waitFor(payer, bill.id, 'paid');
});

test('FlexPaie: a stuck payment can be given up after 5 minutes, and ends by itself after 15', async () => {
  const { run } = await import('../server/db.js');
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 9);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' });
  let view = (await payer('GET', `/api/bills/${bill.id}`)).data.bill;
  assert.deepEqual(view.pending, { method: 'card', minutes: 0 });
  // Too early: "try again" waits (the payment may still be going through).
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'retry' })).data.bill.status, 'payment_pending');
  await run("UPDATE payments SET created_at = now() - interval '6 minutes' WHERE id = $1", pay.data.paymentId);
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'retry' })).data.bill.status, 'payment_failed');
  // Paying again works; this time the payer just walks away, and the page's own check ends it after 15 minutes.
  const again = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'orange', walletPhone: '+243895550144' });
  assert.equal(again.status, 200);
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {})).data.bill.status, 'payment_pending');
  await run("UPDATE payments SET created_at = now() - interval '16 minutes' WHERE id = $1", again.data.paymentId);
  view = (await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {})).data.bill;
  assert.equal(view.status, 'payment_failed');
});

test('never charged twice: paying again first re-checks the attempt given up, and a second success is flagged for refund', async () => {
  // 1. The payer cancels on the card page, but the payment went through after all (no callback).
  //    Paying again is refused and the first payment counts.
  const first = await confirmedBill('Centre Médical Espoir', '+243810000001', 10);
  const p1 = await payer('POST', `/api/bills/${first.bill.id}/pay`, { method: 'card' });
  assert.equal((await payer('POST', `/api/bills/${first.bill.id}/payment/refresh`, { result: 'cancel' })).data.bill.status, 'payment_failed');
  txs.get([...txs.entries()].find(([, t]) => t.reference === p1.data.paymentId)![0])!.status = '0';
  const before = calls.length;
  const again = await payer('POST', `/api/bills/${first.bill.id}/pay`, { method: 'card' });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'already_paid');
  assert.equal(calls.length, before); // nothing new was sent to FlexPaie
  await waitFor(payer, first.bill.id, 'paid');

  // 2. Cancelled, paid again successfully, then the first one turns out to have gone through too:
  //    no second payout, the bill says so, and the admin is told to refund.
  const second = await confirmedBill('Centre Médical Espoir', '+243810000001', 11);
  const a = await payer('POST', `/api/bills/${second.bill.id}/pay`, { method: 'card' });
  await payer('POST', `/api/bills/${second.bill.id}/payment/refresh`, { result: 'cancel' });
  const b = await payer('POST', `/api/bills/${second.bill.id}/pay`, { method: 'card' });
  assert.equal(b.status, 200);
  const orderB = [...txs.entries()].find(([, t]) => t.reference === b.data.paymentId)![0];
  txs.get(orderB)!.status = '0';
  await callback({ code: '0', reference: b.data.paymentId, orderNumber: orderB });
  await waitFor(payer, second.bill.id, 'paid');
  const orderA = [...txs.entries()].find(([, t]) => t.reference === a.data.paymentId)![0];
  txs.get(orderA)!.status = '0';
  await callback({ code: '0', reference: a.data.paymentId, orderNumber: orderA });
  await new Promise((r) => setTimeout(r, 100));
  const view = (await payer('GET', `/api/bills/${second.bill.id}`)).data.bill;
  assert.equal(view.status, 'paid');
  assert.ok(view.events.some((e: { type: string }) => e.type === 'double_payment'));
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE bill_id = $1 AND kind = 'payout'", second.bill.id))!.n, 1);
  assert.ok(await one("SELECT 1 FROM audit WHERE action = 'late_payment_refund' AND detail LIKE $1", `%${second.bill.ref || ''}%`));
});

test('FlexPaie card: back with the browser\'s Back button ends the attempt like Cancel', async () => {
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 12);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' });
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'back' })).data.bill.status, 'payment_failed');
  const p = await one<{ failure_reason: string; ended_by_app: number }>('SELECT failure_reason, ended_by_app FROM payments WHERE id = $1', pay.data.paymentId);
  assert.match(p!.failure_reason, /Back button/);
  assert.equal(p!.ended_by_app, 1);
  // Mobile money has no page to leave: "back" changes nothing there.
  const mm = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'mpesa', walletPhone: '+243815550155' });
  assert.equal(mm.status, 200);
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'back' })).data.bill.status, 'payment_pending');
});

test('FlexPaie card: back through "approve", the payment is never given up; a misread return is recovered', async () => {
  const { run } = await import('../server/db.js');
  const { bill } = await confirmedBill('Centre Médical Espoir', '+243810000001', 13);
  const pay = await payer('POST', `/api/bills/${bill.id}/pay`, { method: 'card' });
  // Approved on the card page, FlexPaie's status check still says pending.
  let v = (await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'approve' })).data.bill;
  assert.equal(v.status, 'payment_pending');
  assert.equal(v.pending.approved, true);
  await run("UPDATE payments SET created_at = now() - interval '25 hours' WHERE id = $1", pay.data.paymentId);
  // Not after 15 minutes, not with "try again": still pending, and the admin is alerted after a day.
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, { result: 'retry' })).data.bill.status, 'payment_pending');
  assert.equal((await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {})).data.bill.status, 'payment_pending');
  assert.ok(await one("SELECT 1 FROM audit WHERE action = 'payment_unconfirmed' AND detail LIKE $1", `${v.ref}:%`));
  txs.get([...txs.entries()].find(([, t]) => t.reference === pay.data.paymentId)![0])!.status = '0';
  await payer('POST', `/api/bills/${bill.id}/payment/refresh`, {});
  await waitFor(payer, bill.id, 'paid');

  // The return was misread as "back" (ended), but FlexPaie had accepted it: the next check recovers it.
  const second = await confirmedBill('Centre Médical Espoir', '+243810000001', 14);
  const p2 = await payer('POST', `/api/bills/${second.bill.id}/pay`, { method: 'card' });
  assert.equal((await payer('POST', `/api/bills/${second.bill.id}/payment/refresh`, { result: 'back' })).data.bill.status, 'payment_failed');
  txs.get([...txs.entries()].find(([, t]) => t.reference === p2.data.paymentId)![0])!.status = '0';
  await payer('POST', `/api/bills/${second.bill.id}/payment/refresh`, {});
  await waitFor(payer, second.bill.id, 'paid');
});
