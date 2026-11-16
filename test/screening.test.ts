import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenBill, findReference, clinicNamesMatch, wasEdited, type ScreenInput, type ScreenContext } from '../server/screening.js';
import { REFERENCE_PRICES } from '../server/seed.js';

const prices = REFERENCE_PRICES.map(([name, keywords, usd]) => ({ name, keywords, usd }));
const clinic = { id: 'c1', name: 'Centre Médical Espoir', active: 1 };
const base: Omit<ScreenInput, 'items' | 'total'> = { clinicId: 'c1', billNumber: 'CME-1', patientName: 'Josephine K.', currency: 'USD', edited: false, ai: null };
const ctx: ScreenContext = { clinic, prices, duplicates: 0, recentForPatient: 0 };

test('reference matching works on French bill wording', () => {
  assert.equal(findReference('Consultation générale', prices)?.name, 'Consultation');
  assert.equal(findReference('TDR paludisme', prices)?.name, 'Malaria test (TDR / goutte épaisse)');
  assert.equal(findReference('Coartem 80/480', prices)?.name, 'Malaria treatment');
  assert.equal(findReference('Hospitalisation 3 jours', prices)?.name, 'Hospital day');
  assert.equal(findReference('Orange juice', prices), null);
});

test('a normal malaria bill is low risk', () => {
  const r = screenBill({ ...base, items: [{ d: 'Consultation', q: 1, p: 10 }, { d: 'TDR', q: 1, p: 5 }, { d: 'Coartem', q: 1, p: 8 }], total: 23 }, ctx);
  assert.equal(r.level, 'low');
  assert.equal(r.score, 0);
  assert.equal(r.expectedUsd, 23);
});

test('an inflated bill is high risk', () => {
  const r = screenBill({ ...base, items: [{ d: 'Consultation', q: 1, p: 35 }, { d: 'Hospitalisation', q: 3, p: 90 }, { d: 'Perfusion', q: 4, p: 25 }], total: 405 }, ctx);
  assert.equal(r.level, 'high');
  assert.ok(r.reasons.filter((x) => x.code === 'price_far_above_reference').length >= 3);
});

test('duplicates, wrong totals and AI tamper flags add up', () => {
  const r = screenBill({ ...base, items: [{ d: 'Consultation', q: 1, p: 10 }], total: 110, ai: { clinic_name: 'Centre Médical Espoir', tamper_flags: ['total written over'] } },
    { ...ctx, duplicates: 1 });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('duplicate_bill_number'));
  assert.ok(codes.includes('total_mismatch'));
  assert.ok(codes.includes('ai_tamper_flag'));
  assert.equal(r.level, 'high');
});

test('CDF bills are converted with the configured rate', () => {
  const r = screenBill({ ...base, currency: 'CDF', items: [{ d: 'Consultation', q: 1, p: 28500 }], total: 28500 }, { ...ctx, settings: { cdfPerUsd: 2850 } });
  assert.equal(r.totalUsd, 10);
  assert.equal(r.level, 'low');
});

test('clinic name matching ignores generic words', () => {
  assert.equal(clinicNamesMatch('CENTRE MEDICAL ESPOIR', 'Centre Médical Espoir'), true);
  assert.equal(clinicNamesMatch('Clinique La Paix', 'Centre Médical Espoir'), false);
});

test('edits after AI reading are detected', () => {
  const ai = { items: [{ description: 'Consultation', qty: 1, unit_price: 10 }], total: 10 };
  assert.equal(wasEdited(ai, { items: [{ d: 'Consultation', q: 1, p: 10 }], total: 10 }), false);
  assert.equal(wasEdited(ai, { items: [{ d: 'Consultation', q: 1, p: 50 }], total: 50 }), true);
});
