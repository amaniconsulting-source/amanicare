// Seeds reference prices, default settings and (outside production) demo clinics.
import { randomUUID } from 'node:crypto';
import { one, run, setSetting, getSetting } from './db.js';
import { config } from './config.js';
import { DEFAULT_SETTINGS } from './screening.js';
import type { Category } from './types.js';

// Illustrative placeholder prices (USD). Replace with real prices collected during the pilot.
export const REFERENCE_PRICES: [name: string, keywords: string[], usd: number][] = [
  ['Consultation', ['consult', 'consultation'], 10],
  ['Malaria test (TDR / goutte épaisse)', ['tdr', 'goutte epaisse', 'test palu', 'malaria test'], 5],
  ['Malaria treatment', ['coartem', 'artemether', 'lumefantrine', 'antipalud', 'quinine', 'artesunate'], 8],
  ['Blood count (NFS)', ['nfs', 'hemogramme', 'blood count', 'fbc'], 10],
  ['Typhoid test (Widal)', ['widal', 'typho'], 8],
  ['Hospital day', ['hospitalisation', 'hospitalization', 'journee', 'bed', 'nuitee'], 25],
  ['IV fluids / perfusion', ['perfusion', 'serum', 'glucose 5', 'ringer', 'iv fluid'], 6],
  ['Ultrasound', ['echographie', 'ultrasound', 'echo'], 30],
  ['Normal delivery', ['accouchement', 'delivery', 'maternite'], 120],
  ['C-section', ['cesarienne', 'c-section', 'caesarean'], 450],
  ['Paracetamol', ['paracetamol', 'doliprane'], 2],
  ['Antibiotics', ['amoxicilline', 'amoxicillin', 'antibiotique', 'ceftriaxone'], 6],
  ['Blood glucose test', ['glycemie', 'glucose test'], 4],
  ['X-ray', ['radiographie', 'x-ray', 'radio'], 20],
];

export const DEMO_CLINICS: [name: string, commune: string, whatsapp: string, method: string, account: string, category: Category][] = [
  ['Centre Médical Espoir', 'Lemba', '+243810000001', 'bank', 'Bank ••4821', 'clinic'],
  ['Clinique Bonne Santé', 'Bandal', '+243810000002', 'bank', 'Bank ••1937', 'clinic'],
  ['Polyclinique La Grâce', 'Ngaliema', '+243810000003', 'mpesa', 'M-Pesa merchant ••7710', 'clinic'],
  ['Centre de Santé Amani', 'Kintambo', '+243810000004', 'orange', 'Orange Money ••3305', 'health_centre'],
];

export async function seedIfEmpty({ demo = !config.production } = {}): Promise<void> {
  if (!(await one('SELECT 1 FROM reference_prices LIMIT 1'))) {
    for (const [name, kw, usd] of REFERENCE_PRICES) {
      await run('INSERT INTO reference_prices(id, name, keywords, usd) VALUES($1,$2,$3,$4)', randomUUID(), name, JSON.stringify(kw), usd);
    }
  }
  if (!(await getSetting('screening', null))) await setSetting('screening', DEFAULT_SETTINGS);
  if (demo && !(await one('SELECT 1 FROM clinics LIMIT 1'))) {
    for (const [name, commune, wa, method, acct, category] of DEMO_CLINICS) {
      const id = randomUUID();
      await run('INSERT INTO clinics(id, name, commune, whatsapp_phone, payout_method, payout_account, trust, category) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        id, name, commune, wa, method, acct, 75, category);
      // Demo clinic login: the clinic's own number (codes appear on screen while OTP_DEV is on).
      await run("INSERT INTO users(id, phone, name, role, lang, clinic_id) VALUES($1,$2,$3,'clinic','fr',$4) ON CONFLICT DO NOTHING",
        randomUUID(), wa, `${name} (caisse)`, id);
    }
  }
}
