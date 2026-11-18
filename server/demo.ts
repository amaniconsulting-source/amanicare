// Resets the database to a clean, realistic demo: a fictional family (John abroad; his mother Jeanne
// and brother Daniel in Kinshasa), six fictional facilities with their own prices, and six bills at
// every stage, each with a photo of the printed bill. Used before demos (e.g. for Equity BCDC).
//
//   npm run build && npm run demo:reset -- --yes [--hospital-whatsapp +243...] [--payer-phone +1...] [--family-phone +243...]
//
// It deletes every bill, payment, message and pending invitation in the database it points at
// (DATABASE_URL). Users, links and facilities are kept; facilities outside the demo network are
// switched off. With --hospital-whatsapp, Centre Médical Espoir's requests go to that number: use the
// phone that plays the hospital in the demo (it must be a test recipient of the WhatsApp number).
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { openDb, closeDb, one, run } from './db.js';
import { migrate } from './migrate.js';
import { seedIfEmpty } from './seed.js';
import { createBill, clinicDecision, reviewDecision, getBill } from './bills.js';
import { startPayment, applyPaymentUpdate, sandboxPayoutDelayMs } from './payments/flow.js';
import type { Category, Lang, UserRow } from './types.js';

type Item = [string, number, number];
interface DemoBill {
  key: string; clinic: string; number: string; patient: string; family: 'jeanne' | 'daniel'; currency: 'USD' | 'CDF';
  daysAgo?: number; minutesAgo?: number; date: number; items: Item[];
  outcome: 'paid' | 'confirmed' | 'waiting' | 'review' | 'rejected'; reason?: string; note?: string;
}

const ROOT = join(import.meta.dirname, '..', '..');
const DEMO = JSON.parse(readFileSync(join(ROOT, 'demo', 'bills.json'), 'utf8')) as { bills: DemoBill[] };

/** The demo network: [name, commune, category, payout method, payout account, default WhatsApp]. */
const FACILITIES: [string, string, Category, string, string, string][] = [
  ['Centre Médical Espoir', 'Lemba', 'clinic', 'bank', 'Equity BCDC ••4821', '+243810000001'],
  ['Clinique Bonne Santé', 'Bandalungwa', 'clinic', 'bank', 'Equity BCDC ••1937', '+243810000002'],
  ['Polyclinique La Grâce', 'Ngaliema', 'clinic', 'bank', 'Equity BCDC ••7710', '+243810000003'],
  ['Centre de Santé Amani', 'Kintambo', 'health_centre', 'mpesa', 'M-Pesa marchand ••3305', '+243810000004'],
  ['Laboratoire Bio-Lumière', 'Gombe', 'diagnostic', 'bank', 'Equity BCDC ••5502', '+243810000005'],
  ['Hôpital Mère-Enfant Tujenge', 'Ngaliema', 'hospital', 'bank', 'Equity BCDC ••6618', '+243810000006'],
];
/** Prices that differ by facility type or facility (the general list comes from seed.ts). */
const SCOPED_PRICES: { scope: { category?: Category; clinic?: string }; name: string; keywords: string[]; usd: number }[] = [
  { scope: { category: 'hospital' }, name: 'Hospital day (hospital)', keywords: ['hospitalisation', 'journee', 'nuitee'], usd: 30 },
  { scope: { clinic: 'Hôpital Mère-Enfant Tujenge' }, name: 'Normal delivery (Tujenge)', keywords: ['accouchement', 'eutocique'], usd: 150 },
  { scope: { category: 'diagnostic' }, name: 'Blood count (lab)', keywords: ['nfs', 'hemogramme'], usd: 12 },
];

/** The value after a --flag; numbers may be typed with spaces ("+243 81 234 5678"). */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const parts: string[] = [];
  for (const a of process.argv.slice(i + 1)) { if (a.startsWith('--')) break; parts.push(a); }
  return parts.join(' ') || undefined;
}
const cleanPhone = (p: string | undefined) => (p ? '+' + p.replace(/\D/g, '') : undefined);

async function user(phone: string, name: string, role: 'payer' | 'family', lang: Lang): Promise<UserRow> {
  const existing = await one<UserRow>('SELECT * FROM users WHERE phone = $1', phone);
  if (existing && existing.role !== role) throw new Error(`${phone} is already a ${existing.role}: choose another number for ${name}`);
  if (existing) { await run('UPDATE users SET name = $2, lang = $3 WHERE id = $1', existing.id, name, lang); return { ...existing, name, lang }; }
  const id = randomUUID();
  await run('INSERT INTO users(id, phone, name, role, lang) VALUES($1,$2,$3,$4,$5)', id, phone, name, role, lang);
  return (await one<UserRow>('SELECT * FROM users WHERE id = $1', id))!;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.log('This deletes all bills, payments, messages and pending invitations, then loads the demo.\nRun again with --yes to go ahead.');
    return;
  }
  if (config.paymentPartner !== 'sandbox') throw new Error('Demo reset only runs with PAYMENT_PARTNER=sandbox.');
  // Nothing goes out on WhatsApp while the demo history is created; payouts complete at once.
  config.messaging = 'sandbox';
  sandboxPayoutDelayMs.value = 0;

  openDb();
  await migrate({ log: false });
  await seedIfEmpty({ demo: false });

  console.log('Clearing bills, payments, messages and pending invitations…');
  for (const sql of ['DELETE FROM payments', 'DELETE FROM bill_events', 'DELETE FROM bills', 'DELETE FROM bill_drafts', 'DELETE FROM photos',
    'DELETE FROM messages', 'DELETE FROM invites WHERE used_by IS NULL', 'DELETE FROM otps',
    'DELETE FROM reference_prices WHERE category IS NOT NULL OR clinic_id IS NOT NULL']) await run(sql);

  // Facilities: kept if they exist (and keep their WhatsApp number), others switched off.
  const hospitalWa = cleanPhone(arg('--hospital-whatsapp'));
  const clinicIds: Record<string, string> = {};
  for (const [name, commune, category, method, account, wa] of FACILITIES) {
    let c = await one<{ id: string; whatsapp_phone: string }>('SELECT id, whatsapp_phone FROM clinics WHERE name = $1', name);
    if (!c) {
      const id = randomUUID();
      await run('INSERT INTO clinics(id, name, commune, whatsapp_phone, payout_method, payout_account, trust, category) VALUES($1,$2,$3,$4,$5,$6,80,$7)',
        id, name, commune, wa, method, account, category);
      await run("INSERT INTO users(id, phone, name, role, lang, clinic_id) VALUES($1,$2,$3,'clinic','fr',$4) ON CONFLICT (phone) DO NOTHING",
        randomUUID(), wa, `${name} (caisse)`, id);
      c = { id, whatsapp_phone: wa };
    }
    const phone = name === 'Centre Médical Espoir' && hospitalWa ? hospitalWa : c.whatsapp_phone || wa;
    await run(`UPDATE clinics SET commune = $2, category = $3, payout_method = $4, payout_account = $5, whatsapp_phone = $6, active = 1, trust = 80
      WHERE id = $1`, c.id, commune, category, method, account, phone);
    clinicIds[name] = c.id;
  }
  await run('UPDATE clinics SET active = 0 WHERE NOT (id = ANY($1))', Object.values(clinicIds));
  for (const p of SCOPED_PRICES) {
    await run('INSERT INTO reference_prices(id, name, keywords, usd, category, clinic_id) VALUES($1,$2,$3,$4,$5,$6)', randomUUID(), p.name,
      JSON.stringify(p.keywords), p.usd, p.scope.category ?? null, p.scope.clinic ? clinicIds[p.scope.clinic] : null);
  }

  // The family. Numbers can be real phones (to receive WhatsApp) or the fictional defaults.
  const john = await user(cleanPhone(arg('--payer-phone')) || '+12145550142', 'John Amani', 'payer', 'en');
  const grace = await user('+32470555014', 'Grace Kalonji', 'payer', 'fr');
  const jeanne = await user(cleanPhone(arg('--family-phone')) || '+243815550142', 'Jeanne Amani', 'family', 'fr');
  const daniel = await user('+243815550143', 'Daniel Amani', 'family', 'fr');
  for (const [payer, fam, relation] of [[john, jeanne, 'Maman'], [john, daniel, 'Frère'], [grace, jeanne, 'Tante']] as const) {
    await run('INSERT INTO links(payer_id, family_id, relation) VALUES($1,$2,$3) ON CONFLICT (payer_id, family_id) DO UPDATE SET relation = $3', payer.id, fam.id, relation);
  }
  const families = { jeanne, daniel };
  const admin = (await one<UserRow>("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"))
    ?? { id: null, role: 'admin' } as unknown as UserRow;

  // Oldest first, so the duplicate and "recent bills" checks see the history as it would have happened.
  const order = [...DEMO.bills].sort((a, b) => (b.daysAgo ?? 0) * 1440 + (b.minutesAgo ?? 0) - ((a.daysAgo ?? 0) * 1440 + (a.minutesAgo ?? 0)));
  for (const d of order) {
    const photo = readFileSync(join(ROOT, 'demo', 'bills', `${d.key}.jpg`));
    const photoId = randomUUID();
    await run('INSERT INTO photos(id, media_type, data) VALUES($1,$2,$3)', photoId, 'image/jpeg', photo);
    const billDate = new Date(Date.now() + d.date * 864e5).toISOString().slice(0, 10);
    const created = await createBill(families[d.family], {
      payerId: john.id, clinicId: clinicIds[d.clinic], patientName: d.patient, billNumber: d.number, billDate, currency: d.currency,
      items: d.items.map(([desc, q, p]) => ({ d: desc, q, p })), total: d.items.reduce((s, [, q, p]) => s + q * p, 0),
    });
    await run('UPDATE bills SET photo_path = $2, photo_sha256 = $3 WHERE id = $1', created.id, `db:${photoId}`, createHash('sha256').update(photo).digest('hex'));

    if (created.status === 'review' && d.outcome !== 'review') await reviewDecision(created.id, true, admin);
    if (d.outcome === 'rejected') {
      await clinicDecision(created.id, 'reject', null);
      await run('UPDATE bills SET reject_reason = $2, reject_note = $3 WHERE id = $1', created.id, d.reason ?? 'other', d.note ?? '');
    }
    if (d.outcome === 'confirmed' || d.outcome === 'paid') await clinicDecision(created.id, 'confirm', null);
    if (d.outcome === 'paid') {
      const { paymentId } = await startPayment(created.id, john);
      await applyPaymentUpdate({ paymentId, status: 'succeeded' });
      for (let i = 0; i < 50 && (await getBill(created.id))!.status !== 'paid'; i++) await new Promise((r) => setTimeout(r, 100));
    }
    // Move the bill and its history back in time, keeping the gaps between steps.
    const ageMin = (d.daysAgo ?? 0) * 1440 + (d.minutesAgo ?? 0);
    const shift = `${ageMin} minutes`;
    await run(`UPDATE bills SET created_at = created_at - $2::interval, updated_at = updated_at - $2::interval WHERE id = $1`, created.id, shift);
    // Spread each step out a little (minutes to hours), so the timeline reads like real life.
    await run(`UPDATE bill_events e SET at = e.at - $2::interval + (s.n * least($3::int, 45) * interval '1 minute')
      FROM (SELECT id, row_number() OVER (ORDER BY id) - 1 n FROM bill_events WHERE bill_id = $1) s WHERE e.id = s.id`, created.id, shift, Math.max(1, Math.floor(ageMin / 20)));
    await run(`UPDATE payments SET created_at = created_at - $2::interval, updated_at = updated_at - $2::interval WHERE bill_id = $1`, created.id, shift);
    const b = (await getBill(created.id))!;
    console.log(`  ${b.ref}  ${d.clinic.padEnd(28)} ${d.patient.padEnd(14)} ${b.status.padEnd(16)} risk ${b.risk_level} ${b.risk_score}`);
  }
  // The demo should start with nothing in the outbox.
  await run('DELETE FROM messages');

  const espoir = (await one<{ whatsapp_phone: string }>('SELECT whatsapp_phone FROM clinics WHERE id = $1', clinicIds['Centre Médical Espoir']))!;
  console.log(`
Demo ready. Log in with (codes show on screen while OTP_DEV=1):
  Abroad (payer):        John Amani   ${john.phone}
  In Kinshasa (family):  Jeanne Amani    ${jeanne.phone}   ·  Daniel Amani ${daniel.phone}
  Hospital:              Centre Médical Espoir receives WhatsApp requests on ${espoir.whatsapp_phone}
Live bill to photograph: demo/bills/live-demo.jpg (Centre Médical Espoir, Joseph Amani, 29 USD).`);
}

main().then(() => closeDb()).catch(async (e) => { console.error(e); await closeDb().catch(() => {}); process.exit(1); });
