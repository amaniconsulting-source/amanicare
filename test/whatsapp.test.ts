// WhatsApp messaging, with the Graph API simulated: templates go out, clinic button replies and
// delivery receipts come back through the signed webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';

process.env.UPLOAD_DIR = 'data/test-uploads';
process.env.OTP_DEV = '1';
process.env.ADMIN_PHONE = '+15550000001';
process.env.SANDBOX_PAYOUT_DELAY_MS = '0';
process.env.PAYMENT_PARTNER = 'sandbox';
process.env.ANTHROPIC_API_KEY = '';
process.env.MESSAGING = 'whatsapp';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify';
process.env.WHATSAPP_USE_TEMPLATES = '1';
process.env.WHATSAPP_TEMPLATE_PREFIX = '';

// Simulated Graph API: records what would be sent to WhatsApp.
const sent: { to: string; type: string; template?: any }[] = [];
let failNext = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://graph.facebook.com/')) {
    if (failNext) { failNext = false; return new Response('{"error":{"message":"Template not found"}}', { status: 400 }); }
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { config } = await import('../server/config.js');
const { openDb, closeDb, one } = await import('../server/db.js');
const { migrate } = await import('../server/migrate.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { createApp } = await import('../server/index.js');

const databaseUrl = process.env.TEST_DATABASE_URL || config.databaseUrl;
const schema = `test_wa_${process.pid}_${Date.now().toString(36)}`;
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
  const { data } = await api('POST', '/api/auth/request-otp', { phone, lang: profile.lang });
  return api('POST', '/api/auth/verify', { phone, code: data.devCode, ...profile });
}
function webhook(payload: unknown, secret = 'test-app-secret') {
  const raw = JSON.stringify(payload);
  return realFetch(`${base}/api/webhooks/whatsapp`, {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') },
  });
}
const lastTo = (phone: string) => [...sent].reverse().find((m) => m.to === phone.replace('+', ''));

test('WhatsApp: templates out, button replies and receipts in', async () => {
  const payer = client(), family = client();
  await login(payer, '+12145550800', { name: 'Payer', role: 'payer', lang: 'en' });

  // Login code: authentication template with the code in the body and the copy-code button.
  const otp = lastTo('+12145550800')!;
  assert.equal(otp.type, 'template');
  assert.equal(otp.template.name, 'amanicare_login_code');
  assert.equal(otp.template.language.code, 'en');
  const code = otp.template.components[0].parameters[0].text;
  assert.match(code, /^\d{6}$/);
  assert.equal(otp.template.components[1].sub_type, 'url');
  assert.equal(otp.template.components[1].parameters[0].text, code);

  // Invite sent by AmaniCare itself when a phone number is given.
  const inv = await payer('POST', '/api/invites', { relation: 'Mother', phone: '+243810000800' });
  assert.equal(inv.data.sent, true);
  const invite = lastTo('+243810000800')!.template;
  assert.equal(invite.name, 'amanicare_invite');
  assert.deepEqual(invite.components[0].parameters.map((p: { text: string }) => p.text), ['Payer', `${config.baseUrl}/?invite=${inv.data.code}&as=family`]);
  assert.equal(inv.data.link, `${config.baseUrl}/?invite=${inv.data.code}&as=family`);

  await login(family, '+243810000800', { name: 'Maman', role: 'family', lang: 'ln' });
  // Lingala user: no Lingala template exists, so the French one is used.
  assert.equal(lastTo('+243810000800')!.template.language.code, 'fr');
  await family('POST', '/api/invites/accept', { code: inv.data.code });

  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const clinicId = (await family('GET', '/api/clinics')).data.clinics.find((c: { name: string }) => c.name === 'Centre Médical Espoir').id;
  const bill = (await family('POST', '/api/bills', { draftId: await photo(family), payerId, clinicId, patientName: 'Maman\nTest', billNumber: 'WA-1', currency: 'USD',
    items: [{ d: 'Consultation', q: 1, p: 10 }], total: 10 })).data.bill;
  assert.equal(bill.status, 'awaiting_clinic');

  // Clinic request: utility template, 4 one-line parameters, Confirm/Reject quick replies carrying the bill id.
  const req = lastTo('+243810000001')!;
  assert.equal(req.template.name, 'amanicare_clinic_request');
  const params = req.template.components[0].parameters.map((p: { text: string }) => p.text);
  assert.equal(params.length, 4);
  assert.ok(params.every((p: string) => p && !p.includes('\n')));
  assert.deepEqual(req.template.components.slice(1).map((c: any) => c.parameters[0].payload), [`confirm:${bill.id}`, `reject:${bill.id}`]);

  // A tap from another number is ignored; a bad signature is refused.
  const tap = (from: string) => ({ entry: [{ changes: [{ value: { messages: [{ from, type: 'button', button: { payload: `confirm:${bill.id}`, text: '✅ Confirmer' } }] } }] }] });
  assert.equal((await webhook(tap('243899999999'), 'wrong-secret')).status, 401);
  assert.equal((await webhook(tap('243899999999'))).status, 200);
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.status, 'awaiting_clinic');
  // The clinic's registered number taps "Confirmer" on the template.
  assert.equal((await webhook(tap('243810000001'))).status, 200);
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.status, 'awaiting_payer');
  assert.equal(lastTo('+12145550800')!.template.name, 'amanicare_bill_confirmed');

  // Delivery receipts update the outbox, and never go backwards.
  const msg = (await one<{ provider_id: string }>("SELECT provider_id FROM messages WHERE to_phone = '+243810000001' AND provider_id IS NOT NULL ORDER BY id DESC LIMIT 1"))!;
  const receipt = (status: string, extra = {}) => ({ entry: [{ changes: [{ value: { statuses: [{ id: msg.provider_id, status, ...extra }] } }] }] });
  await webhook(receipt('read'));
  await webhook(receipt('delivered'));
  assert.equal((await one<{ status: string }>('SELECT status FROM messages WHERE provider_id = $1', msg.provider_id))!.status, 'read');

  // A failed send is recorded with the error, visible to admins.
  failNext = true;
  await login(client(), '+12145550801', { name: 'X', role: 'payer' }).catch(() => {});
  const failed = (await one<{ status: string; error: string }>("SELECT status, error FROM messages WHERE to_phone = '+12145550801' ORDER BY id LIMIT 1"))!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Template not found/);
});

test('WhatsApp: a hospital that rejects is asked why, and the family sees the answer', async () => {
  const payer = client(), family = client();
  await login(payer, '+12145550810', { name: 'Payer2', role: 'payer', lang: 'en' });
  const inv = await payer('POST', '/api/invites', { relation: 'Aunt' });
  await login(family, '+243810000810', { name: 'Tantine', role: 'family', lang: 'fr' });
  await family('POST', '/api/invites/accept', { code: inv.data.code });
  const payerId = (await family('GET', '/api/payers')).data.payers[0].id;
  const clinicId = (await family('GET', '/api/clinics')).data.clinics.find((c: { name: string }) => c.name === 'Centre Médical Espoir').id;
  const bill = (await family('POST', '/api/bills', { draftId: await photo(family), payerId, clinicId, patientName: 'Tantine', billNumber: 'WA-2', currency: 'USD',
    items: [{ d: 'Consultation', q: 1, p: 12 }], total: 12 })).data.bill;

  // The family reminds the hospital: the request goes out again; a second reminder right away is refused.
  const before = sent.filter((m) => m.to === '243810000001').length;
  assert.equal((await family('POST', `/api/bills/${bill.id}/resend-clinic`, {})).status, 200);
  assert.equal(sent.filter((m) => m.to === '243810000001').length, before + 1);
  assert.equal((await family('POST', `/api/bills/${bill.id}/resend-clinic`, {})).data.error, 'resend_too_soon');

  const msg = (m: object) => ({ entry: [{ changes: [{ value: { messages: [{ from: '243810000001', ...m }] } }] }] });
  await webhook(msg({ type: 'button', button: { payload: `reject:${bill.id}`, text: '❌ Rejeter' } }));
  let b = (await family('GET', `/api/bills/${bill.id}`)).data.bill;
  assert.equal(b.status, 'rejected');
  assert.deepEqual(b.rejection, { by: 'hospital', reason: null, note: '' });
  // Right after the tap, the hospital gets a list of reasons.
  const why = lastTo('+243810000001') as any;
  assert.equal(why.interactive.type, 'list');
  assert.ok(why.interactive.action.sections[0].rows.some((r: { id: string }) => r.id === `why:${bill.id}:wrong_amount`));
  // It picks one: the family sees it. A second answer doesn't overwrite it.
  await webhook(msg({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `why:${bill.id}:wrong_amount` } } }));
  await webhook(msg({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `why:${bill.id}:other` } } }));
  b = (await family('GET', `/api/bills/${bill.id}`)).data.bill;
  assert.equal(b.rejection.reason, 'wrong_amount');
  assert.equal((await payer('GET', `/api/bills/${bill.id}`)).data.bill.rejection.reason, 'wrong_amount');
});

test('login codes can stay off WhatsApp until the business is verified', async () => {
  const { config } = await import('../server/config.js');
  config.whatsapp.loginCodes = false;
  try {
    const before = sent.length;
    await login(client(), '+12145550900', { name: 'NoWA', role: 'payer' });
    assert.equal(sent.length, before); // nothing sent to WhatsApp
    const m = (await one<{ channel: string; status: string }>("SELECT channel, status FROM messages WHERE to_phone = '+12145550900' ORDER BY id LIMIT 1"))!;
    assert.deepEqual(m, { channel: 'sandbox', status: 'stored' });
  } finally { config.whatsapp.loginCodes = true; }
});

test('WhatsApp webhook verification handshake', async () => {
  const ok = await realFetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345`);
  assert.equal(await ok.text(), '12345');
  assert.equal((await realFetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
});

test('WhatsApp: a written message to our number reaches customer service, and the team answers on WhatsApp', async () => {
  const msg = (from: string, body: string) => webhook({ entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body } }] } }] }] });
  // A stranger asks for a person: a conversation opens, the hand-over note is sent back as a free reply.
  assert.equal((await msg('33612345678', 'Bonjour, je veux parler à un agent')).status, 200);
  const t = await one<{ id: string; status: string; channel: string; guest_phone: string }>("SELECT * FROM support_tickets WHERE guest_phone = '+33612345678'");
  assert.equal(t?.channel, 'whatsapp'); assert.equal(t?.status, 'open');
  const reply = lastTo('+33612345678');
  assert.equal(reply?.type, 'text');
  // A second message joins the same conversation.
  await msg('33612345678', 'Vous êtes là ?');
  assert.equal((await one<{ n: number }>("SELECT COUNT(*)::int n FROM support_tickets WHERE guest_phone = '+33612345678'"))!.n, 1);
  // The agent's answer goes back as a WhatsApp text (inside the 24 h window).
  const owner = client(); await login(owner, '+15550000001');
  const before = sent.length;
  assert.equal((await owner('POST', `/api/admin/support/${t!.id}/messages`, { text: 'Oui, bonjour ! Comment puis-je aider ?' })).data.delivery, 'sent');
  const out = sent.slice(before).find((m) => m.to === '33612345678') as any;
  assert.equal(out?.type, 'text'); assert.match(out.text.body, /Comment puis-je aider/);
});
