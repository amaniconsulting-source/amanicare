// AmaniCare PWA. TypeScript compiled by tsc to a plain ES module (no bundler).
import { initMonitoring, report, setUser } from './monitoring.js';
/** The deploy this page belongs to (set by the server in index.html). */
const APP_VERSION = document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content || '';

initMonitoring();

type Lang = 'fr' | 'en' | 'ln' | 'sw';
type Role = 'payer' | 'family' | 'clinic' | 'admin';
type AdminTab = 'overview' | 'support' | 'bills' | 'clinics' | 'users' | 'prices' | 'settings' | 'messages' | 'payments';
type Params = Record<string, string | number>;

interface Me { id: string; phone: string; name: string; role: Role; lang: Lang; clinicId: string | null }
interface Reason { code: string; points: number; params?: Record<string, unknown> }
interface Risk { score?: number; level: string; reasons?: Reason[] }
interface Bill {
  id: string; ref: string; status: string; patientName: string; billNumber: string; billDate: string;
  currency: 'USD' | 'CDF'; items: { d: string; q: number; p: number }[]; total: number; totalUsd: number; feeUsd: number;
  expectedUsd?: number; createdAt: string; hasPhoto: boolean;
  clinic: { id: string; name: string; commune: string } | null;
  payer?: { id: string; name: string } | null;
  waitingFor?: { relation: string; phone: string | null };
  family: { id: string; name: string } | null;
  risk: Risk; aiUsed: boolean; edited: boolean;
  events: { at: string; type: string; note: string }[];
  payout?: { ref: string | null; status: string; account?: string };
  rejection?: { by: 'hospital' | 'review'; reason: string | null; note: string };
}
interface Payer { id: string; name: string; relation: string }
type Category = 'health_centre' | 'clinic' | 'hospital' | 'diagnostic' | 'pharmacy';
const CATEGORIES: Category[] = ['health_centre', 'clinic', 'hospital', 'diagnostic', 'pharmacy'];
interface Clinic { id: string; name: string; commune: string; city: string; category: Category }
interface AdminClinic extends Clinic { whatsapp_phone: string; payout_method: string; payout_account: string; trust: number; active: number; flexpay_merchant: string; payout_phone: string }
interface AiRead {
  clinic_name: string; bill_number: string; date: string; patient_name: string; currency: 'USD' | 'CDF';
  items: { description: string; qty: number; unit_price: number }[]; total: number; tamper_flags: string[]; confidence: number;
}

// Launch languages (22 Nov 2026): French, English, Lingala. Swahili is kept on file but not offered.
const LANGS: Lang[] = ['fr', 'en', 'ln'];
const app = document.getElementById('app')!;
const state: { me: Me | null; lang: Lang; dict: Record<string, string>; fallback: Record<string, string>; adminTab: AdminTab; priceScope: string } =
  { me: null, lang: 'fr', dict: {}, fallback: {}, adminTab: 'overview', priceScope: '' };
const me = (): Me => state.me!;

// ---------- i18n ----------
async function loadLang(lang: Lang): Promise<void> {
  const get = (l: string) => fetch(`/i18n/${l}.json?v=${APP_VERSION}`).then((r) => r.json() as Promise<Record<string, string>>);
  state.fallback = Object.keys(state.fallback).length ? state.fallback : await get('fr');
  state.dict = lang === 'fr' ? state.fallback : await get(lang).catch(() => ({}));
  state.lang = lang;
  document.documentElement.lang = lang;
  (document.getElementById('langSel') as HTMLSelectElement).value = lang;
  document.getElementById('logoutBtn')!.textContent = t('logout');
  document.getElementById('helpLabel')!.textContent = t('help');
  try { localStorage.setItem('lang', lang); } catch {}
}
function t(key: string, params: Params = {}): string {
  let s = state.dict[key] ?? state.fallback[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// ---------- helpers ----------
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const usd = (n: unknown): string => '$' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cdf = (n: unknown): string => Math.round(Number(n || 0)).toLocaleString('fr-FR') + ' FC';
const fmtDate = (s: string | null | undefined): string => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + (s.length > 10 && !s.endsWith('Z') ? 'Z' : ''));
  return isNaN(d.getTime()) ? s : (state.lang === 'ln'
    // Lingala: day/month/year in figures (month names in Lingala are long and little used in writing).
    ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : d.toLocaleDateString(state.lang === 'en' ? 'en-US' : 'fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }));
};
/** Chat times: the hour today, else the day and hour. */
const chatTime = (s: string): string => {
  const d = new Date(s.replace(' ', 'T') + (s.length > 10 && !s.endsWith('Z') ? 'Z' : ''));
  if (isNaN(d.getTime())) return s;
  const loc = state.lang === 'en' ? 'en-US' : 'fr-FR';
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString(loc, { day: 'numeric', month: 'short' })} ${hm}`;
};
function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
const val = (sel: string, root: ParentNode = document): string => $<HTMLInputElement | HTMLSelectElement>(sel, root).value;
const btn = (e: Event) => e.currentTarget as HTMLButtonElement;

// ---------- phone numbers ----------
// Every phone field has a country-code picker. People can also type the full number with "+"
// (the picker is then ignored), and a forgotten code is added from the picker, so
// "0812345678" with 🇨🇩 +243 becomes +243812345678. The server completes Congolese numbers too.
// Short names rather than flag emojis: Windows shows flags as two letters ("CD").
const COUNTRIES: [string, string, string][] = [
  ['CD', '243', 'RDC'], ['US', '1', 'USA'], ['CA', '1', 'Canada'], ['FR', '33', 'France'], ['BE', '32', 'Belgique'],
  ['GB', '44', 'UK'], ['DE', '49', 'Deutschland'], ['CH', '41', 'Suisse'], ['ZA', '27', 'South Africa'], ['AO', '244', 'Angola'], ['CG', '242', 'Congo-Brazza'],
];
const dialOf = (cc: string): string => (COUNTRIES.find(([c]) => c === cc) || COUNTRIES[0])[1];
/** Splits a stored number (+243812345678) into its country and the rest, for editing. */
function splitPhone(full: string, fallback: string): { cc: string; local: string } {
  if (!full.startsWith('+')) return { cc: fallback, local: full };
  const digits = full.slice(1);
  const hit = COUNTRIES.filter(([, d]) => digits.startsWith(d)).sort((a, b) => b[1].length - a[1].length)
    .find(([c, d]) => d !== '1' || c === fallback || c === 'US');
  return hit ? { cc: hit[0], local: digits.slice(hit[1].length) } : { cc: fallback, local: full };
}
function phoneField(id: string, opts: { value?: string; cc?: string; placeholder?: string; autocomplete?: boolean } = {}): string {
  const { cc, local } = splitPhone(opts.value || '', opts.cc || 'CD');
  return `<div class="phone-field">
    <select id="${id}Cc" aria-label="${t('phone.country')}">${COUNTRIES.map(([c, d, f]) => `<option value="${c}" ${c === cc ? 'selected' : ''}>+${d} ${f}</option>`).join('')}</select>
    <input id="${id}" type="tel" inputmode="tel" ${opts.autocomplete ? 'autocomplete="tel"' : ''} value="${esc(local)}" placeholder="${esc(opts.placeholder || '81 234 5678')}">
  </div>`;
}
/** The number in international format, or '' when the field is empty. */
function readPhone(id: string, root: ParentNode = document): string {
  let p = val('#' + id, root).trim().replace(/[\s\-().\/]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+')) return p;
  const dial = dialOf(val('#' + id + 'Cc', root));
  if (p.startsWith(dial) && p.length > dial.length + 8) return '+' + p; // typed the code without "+"
  return '+' + dial + p.replace(/^0+/, ''); // drop the national trunk "0"
}
function setPhoneCountry(id: string, cc: string, root: ParentNode = document): void {
  const sel = root.querySelector<HTMLSelectElement>('#' + id + 'Cc'); if (sel) sel.value = cc;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const el = document.getElementById('toast')!;
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 3000);
}

class ApiError extends Error {
  code?: string; status?: number; detail?: string;
  constructor(code?: string, status?: number, detail?: string) {
    super(code || 'error');
    this.code = code; this.status = status; this.detail = detail;
  }
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  // Every request that changes something is sent as JSON, even without data (e.g. DELETE):
  // the server refuses anything else, as a protection against forged requests from other sites.
  const send = method !== 'GET' ? (body ?? {}) : undefined;
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: send !== undefined ? { 'content-type': 'application/json' } : {},
    body: send !== undefined ? JSON.stringify(send) : undefined,
  });
  checkVersion(res.headers.get('x-app-version'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error, res.status, data.message);
  return data as T;
}

// After a deploy, a page that is already open still runs the old code (an open app is not reloaded by itself).
// Every API answer carries the server's version; when it changes, offer a one-tap update. If the page was in the
// background, it simply updates the next time the person comes back to it.
let loadedVersion: string | null = APP_VERSION || null; // the version this page was served with
let updateWaiting = false;
function checkVersion(v: string | null): void {
  if (!v) return;
  if (!loadedVersion) { loadedVersion = v; return; }
  if (v === loadedVersion || updateWaiting) return;
  updateWaiting = true;
  if (document.hidden) { location.reload(); return; }
  const bar = document.createElement('div');
  bar.className = 'update-bar'; bar.setAttribute('role', 'status');
  bar.innerHTML = `<span>${t('update.available')}</span><button>${t('update.reload')}</button>`;
  bar.querySelector('button')!.onclick = () => location.reload();
  document.body.append(bar);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (updateWaiting && document.getElementById('modal')?.classList.contains('hidden')) location.reload(); // never in the middle of a form
  else fetch('/healthz', { cache: 'no-store' }).then((r) => checkVersion(r.headers.get('x-app-version'))).catch(() => {});
});
const errText = (e: unknown): string => {
  const err = e as ApiError;
  return t('err.' + err.code) !== 'err.' + err.code ? t('err.' + err.code, { name: err.detail || '' }) : (err.detail || t('err.generic'));
};
// Unexpected errors (bugs, not API answers like "wrong code") go to Sentry.
const reportUnexpected = (e: unknown) => { if (!(e instanceof ApiError) || (e.status ?? 0) >= 500) report(e); };

function openModal(html: string, onMount?: (sheet: HTMLElement) => void): void {
  const m = document.getElementById('modal')!;
  document.getElementById('sheet')!.innerHTML = html;
  m.classList.remove('hidden');
  if (onMount) onMount(document.getElementById('sheet')!);
}
function closeModal(): void { document.getElementById('modal')!.classList.add('hidden'); document.getElementById('sheet')!.innerHTML = ''; }
document.getElementById('modal')!.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.id === 'modal' || target.closest('[data-close]')) closeModal();
});

function confirmDialog(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(`<p>${esc(message)}</p><div class="row"><button class="secondary grow" data-close>${t('cancel')}</button><button class="grow ${danger ? 'danger' : ''}" id="dlgOk">${esc(okLabel)}</button></div>`, (s) => {
      $('#dlgOk', s).onclick = () => { closeModal(); resolve(true); };
      $$('[data-close]', s).forEach((b) => b.addEventListener('click', () => resolve(false)));
    });
  });
}

async function busy<T>(button: HTMLButtonElement, fn: () => Promise<T>): Promise<T | undefined> {
  const label = button.innerHTML; button.disabled = true; button.innerHTML = '<span class="spinner"></span>';
  try { return await fn(); } catch (e) { reportUnexpected(e); toast(errText(e)); } finally { button.disabled = false; button.innerHTML = label; }
  return undefined;
}

// ---------- bills (shared rendering) ----------
const STEP: Record<string, number> = { review: 1, awaiting_clinic: 1, awaiting_payer: 2, payment_pending: 2, payment_failed: 2, paying_out: 3, payout_failed: 3, paid: 4, rejected: -1, declined: -1 };
function steps(status: string): string {
  const s = STEP[status];
  // The four stages, labelled, so people see where the bill is without reading the status.
  return `<div class="progress" aria-hidden="true"><div class="steps">${[1, 2, 3, 4].map((i) => `<i class="${s < 0 ? 'x' : i <= s ? 'on' : ''}"></i>`).join('')}</div>
    ${s < 0 ? '' : `<div class="step-labels">${[1, 2, 3, 4].map((i) => `<span class="${i <= s ? 'on' : ''}">${t('step.' + i)}</span>`).join('')}</div>`}</div>`;
}
const riskPill = (r: Risk | undefined): string => r?.level ? `<span class="pill ${r.level}">${t('risk.' + r.level)}${r.score !== undefined ? ' · ' + r.score : ''}</span>` : '';
const reasonText = (r: Reason): string => {
  const params: Record<string, unknown> = { ...(r.params || {}) };
  if (state.lang !== 'en' && params.flag_fr) params.flag = params.flag_fr; // what the app saw on the photo, in French
  return t('reason.' + r.code, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'number' && /usd/i.test(k) ? usd(v) : String(v)])));
};

function billCard(b: Bill, { actions = '', showReasons = false, showExpected = false, showNext = true } = {}): string {
  return `<div class="bill" data-bill="${b.id}">
    <div class="top">
      <div><b>${esc(b.patientName)}</b><div class="muted small">${esc(b.clinic?.name || '')} · ${fmtDate(b.createdAt)}</div></div>
      <div class="center"><div class="amount">${usd(b.totalUsd)}</div>${b.currency === 'CDF' ? `<div class="muted small">${cdf(b.total)}</div>` : ''}</div>
    </div>
    <div class="row">${riskPill(b.risk)}<span class="pill st">${t('status.' + b.status)}</span>${b.aiUsed ? `<span class="pill st">${t('aiRead')}</span>` : ''}</div>
    ${steps(b.status)}
    ${rejectionHtml(b)}
    ${showNext ? nextStep(b) : ''}
    ${showNext ? resendHtml(b) : ''}
    ${showExpected && b.expectedUsd !== undefined ? `<div class="muted small">${t('expectedCost', { amount: usd(b.expectedUsd) })}</div>` : ''}
    ${showReasons && b.risk?.reasons?.filter((r) => r.points).length ? `<ul class="reasons">${b.risk.reasons.filter((r) => r.points).map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>` : ''}
    ${actions}
    <button class="link" data-detail="${b.id}">${t('details')}</button>
  </div>`;
}

function wireDetails(root: ParentNode): void {
  $$('[data-detail]', root).forEach((el) => el.addEventListener('click', () => showBill(el.dataset.detail!)));
  wireResend(root);
}

// ---------- rejection reasons and reminders ----------
const HOSPITAL_REASONS = ['patient_unknown', 'wrong_amount', 'already_paid', 'not_our_bill', 'other'];
const REVIEW_REASONS = ['unverifiable', 'duplicate', 'unreadable_photo', 'not_in_network', 'other'];

/** Who stopped the bill and why, in plain words. */
function rejectionHtml(b: Bill): string {
  const r = b.rejection;
  if (b.status !== 'rejected' || !r) return '';
  return `<div class="notice bad reject"><b>${t('reject.by.' + r.by)}</b>
    <div>${r.reason ? t('reject.' + r.reason) : t('reject.noReason')}</div>
    ${r.note ? `<div class="muted small">“${esc(r.note)}”</div>` : ''}</div>`;
}
/** While the hospital hasn't answered, the family or payer can send the WhatsApp request again. */
function resendHtml(b: Bill): string {
  const role = state.me?.role;
  if (b.status !== 'awaiting_clinic' || !['family', 'payer', 'admin'].includes(role || '')) return '';
  return `<button class="secondary small" data-resend="${b.id}">📲 ${t('resend.button')}</button>`;
}
function wireResend(root: ParentNode): void {
  $$<HTMLButtonElement>('[data-resend]', root).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => {
    await api('POST', `/api/bills/${b.dataset.resend}/resend-clinic`, {});
    toast(t('resend.done'));
  })));
}
/** Asks why a bill is being rejected. Resolves to null if cancelled. */
function rejectDialog(reasons: string[]): Promise<{ reason: string; note: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    openModal(`<div class="row between"><h2>${t('reject.pick')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
      <p class="muted small">${t('reject.pickHint')}</p>
      ${reasons.map((r, i) => `<label class="radio"><input type="radio" name="why" value="${r}" ${i === 0 ? 'checked' : ''}> ${t('reject.' + r)}</label>`).join('')}
      <label for="whyNote">${t('reject.note')}</label>
      <input id="whyNote" maxlength="300" placeholder="${t('reject.notePh')}">
      <div class="row"><button class="secondary grow" data-close>${t('cancel')}</button><button class="grow danger" id="whyOk">${t('reject.confirm')}</button></div>`, (s) => {
      $('#whyOk', s).onclick = () => {
        done = true;
        const reason = $<HTMLInputElement>('input[name="why"]:checked', s).value;
        const note = val('#whyNote', s);
        closeModal(); resolve({ reason, note });
      };
      $$('[data-close]', s).forEach((b) => b.addEventListener('click', () => { if (!done) resolve(null); }));
    });
  });
}

/** How the payer pays: bank card, or mobile money from a wallet number. Resolves to null if cancelled. */
const WALLETS = ['mpesa', 'orange', 'airtel'] as const;
function payDialog(amount: string): Promise<{ method: string; walletPhone?: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const myPhone = me().phone || '';
    openModal(`<div class="row between"><h2>${t('pay.title', { amount: esc(amount) })}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
      <p class="muted small">${t('pay.hint')}</p>
      <label class="radio"><input type="radio" name="how" value="card" checked> <span><b>${t('pay.card')}</b><br><span class="muted small">${t('pay.cardHint')}</span></span></label>
      ${WALLETS.map((w) => `<label class="radio"><input type="radio" name="how" value="${w}"> <span><b>${t('pay.' + w)}</b><br><span class="muted small">${t('pay.mobileHint')}</span></span></label>`).join('')}
      <div id="walletBox" class="hidden">
        <label for="walletPhone">${t('pay.walletPhone')}</label>
        ${phoneField('walletPhone', { value: myPhone.startsWith('+243') ? myPhone : '', cc: 'CD', autocomplete: true })}
        <p class="muted small">${t('pay.walletNote')}</p>
      </div>
      <div class="row"><button class="secondary grow" data-close>${t('cancel')}</button><button class="grow" id="payOk">${t('pay.continue')}</button></div>`, (sheet) => {
      const picked = () => $<HTMLInputElement>('input[name="how"]:checked', sheet).value;
      $$<HTMLInputElement>('input[name="how"]', sheet).forEach((r) => (r.onchange = () => $('#walletBox', sheet).classList.toggle('hidden', picked() === 'card')));
      $('#payOk', sheet).onclick = () => {
        const method = picked();
        const walletPhone = readPhone('walletPhone', sheet);
        if (method !== 'card' && !walletPhone) { $('#walletPhone', sheet).focus(); return; }
        done = true; closeModal();
        resolve(method === 'card' ? { method } : { method, walletPhone });
      };
      $$('[data-close]', sheet).forEach((b) => b.addEventListener('click', () => { if (!done) resolve(null); }));
    });
  });
}

async function showBill(id: string): Promise<void> {
  const { bill: b } = await api<{ bill: Bill }>('GET', `/api/bills/${id}`);
  const items = b.items.map((i) => `<tr><td>${esc(i.d)}</td><td class="num">${i.q}</td><td class="num">${b.currency === 'CDF' ? cdf(i.p) : usd(i.p)}</td></tr>`).join('');
  openModal(`
    <div class="row between"><h2>${esc(b.patientName)}</h2><button class="link" data-close>✕</button></div>
    <p class="muted small">${esc(b.clinic?.name || '')} · ${t('billNo')} ${esc(b.billNumber || '—')} · ${t('ref')} ${esc(b.ref)}</p>
    <div class="row">${riskPill(b.risk)}<span class="pill st">${t('status.' + b.status)}</span></div>
    ${steps(b.status)}
    ${rejectionHtml(b)}
    ${nextStep(b)}
    ${resendHtml(b)}
    <div class="scroll"><table><thead><tr><th>${t('item')}</th><th class="num">${t('qty')}</th><th class="num">${t('unitPrice')}</th></tr></thead><tbody>${items}</tbody></table></div>
    <p class="row between"><b>${t('total')}</b><b>${b.currency === 'CDF' ? cdf(b.total) + ' · ' : ''}${usd(b.totalUsd)}</b></p>
    ${b.expectedUsd !== undefined ? `<p class="muted small">${t('expectedCost', { amount: usd(b.expectedUsd) })}</p>` : ''}
    ${b.risk?.reasons?.length ? `<ul class="reasons">${b.risk.reasons.map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>` : ''}
    ${b.payout ? `<p class="notice info">${t('payoutSent', { ref: esc(b.payout.ref), account: esc(b.payout.account || '') })}</p>` : ''}
    <ul class="timeline">${b.events.map((e) => `<li>${fmtDate(e.at)} · ${esc(eventText(e.type, b))}</li>`).join('')}</ul>
    ${b.hasPhoto ? `<img class="photo-full" src="/api/bills/${b.id}/photo" alt="${t('billPhoto')}">` : ''}
    ${state.me?.role !== 'admin' ? `<button class="secondary block" data-bill-help>💬 ${t('chat.billHelp')}</button>` : ''}
  `, (sheet) => { wireResend(sheet); sheet.querySelector<HTMLButtonElement>('[data-bill-help]')?.addEventListener('click', () => openSupport({ billId: b.id, billRef: b.ref })); });
}

// ---------- how it works, help, next steps ----------
type GuideRole = 'payer' | 'family' | 'clinic';
const GUIDE_ICONS: Record<GuideRole, string[]> = {
  payer: ['👨‍👩‍👧', '📷', '🏥', '💳'],
  family: ['🔗', '📷', '🏥', '✅'],
  clinic: ['💬', '✅', '💰'],
};
const FAQ = ['cost', 'invite', 'time', 'clinic', 'held', 'failed', 'many', 'privacy', 'code'];
const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || '';

function guideSteps(role: GuideRole): string {
  return `<ol class="guide-steps">${GUIDE_ICONS[role].map((icon, i) => `<li>
    <span class="gs-icon" aria-hidden="true">${icon}<span class="gs-num">${i + 1}</span></span>
    <div><b>${t(`guide.${role}.${i + 1}.t`)}</b><p>${t(`guide.${role}.${i + 1}.d`)}</p></div></li>`).join('')}</ol>`;
}

/** "How it works" with a tab per audience. Call wireGuide() after inserting it. */
function guideHtml(selected: GuideRole, roles: GuideRole[] = ['payer', 'family', 'clinic']): string {
  return `<div class="guide" data-guide>
    <div class="seg" role="tablist">${roles.map((r) => `<button type="button" role="tab" data-guide-tab="${r}" aria-selected="${r === selected}" class="${r === selected ? 'on' : ''}">${t('guide.tab.' + r)}</button>`).join('')}</div>
    <div data-guide-steps>${guideSteps(selected)}</div>
  </div>`;
}
function wireGuide(root: ParentNode): void {
  $$('[data-guide]', root).forEach((g) => $$<HTMLButtonElement>('[data-guide-tab]', g).forEach((b) => (b.onclick = () => {
    $$<HTMLButtonElement>('[data-guide-tab]', g).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $('[data-guide-steps]', g).innerHTML = guideSteps(b.dataset.guideTab as GuideRole);
  })));
}

function trustHtml(): string {
  return `<div class="trust">${['🔒', '🔎', '👀', '🤝'].map((icon, i) => `<div><span aria-hidden="true">${icon}</span>
    <b>${t(`trust.${i + 1}.t`)}</b><p>${t(`trust.${i + 1}.d`)}</p></div>`).join('')}</div>`;
}

function supportHtml(): string {
  const email = meta('support-email');
  const wa = meta('support-whatsapp').replace(/\D/g, '');
  return `<p class="contact">${email ? `<a href="mailto:${esc(email)}">✉️ ${esc(email)}</a>` : ''}${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 ${t('support.whatsapp')} +${esc(wa)}</a>` : ''}</p>`;
}

function faqHtml(): string {
  return `<div class="faq"><h2>${t('faq.title')}</h2>
    ${FAQ.map((k) => `<details><summary>${t(`faq.${k}.q`)}</summary><p>${t(`faq.${k}.a`)}${k === 'privacy' ? ` <a href="/privacy.html${state.lang === 'en' ? '#en' : ''}">${t('privacy')}</a>` : ''}</p></details>`).join('')}
    <details><summary>${t('faq.contact.q')}</summary><p>${t('faq.contact.a')}</p>${supportHtml()}</details>
  </div>`;
}

function openHelp(): void {
  const role = state.me?.role;
  const selected: GuideRole = role === 'family' ? 'family' : role === 'clinic' ? 'clinic' : 'payer';
  openModal(`<div class="row between"><h2>${t('guide.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    ${role === 'admin' ? '' : `<button class="block chat-cta" data-chat>💬 ${t('chat.cta')}</button>`}
    ${role === 'admin' ? '' : networkLink()}
    <p class="muted">${t('guide.intro')}</p>
    ${guideHtml(selected)}
    ${trustHtml()}
    ${installed() ? '' : `<div class="install-help"><h2>${t('install.title')}</h2><p class="muted">${t('install.why')}</p>${installSteps()}${installPrompt ? `<button class="block" data-install-now>${t('install.button')}</button>` : ''}</div>`}
    ${faqHtml()}`, (sheet) => { wireGuide(sheet); wireChatLinks(sheet); wireNetworkLinks(sheet); sheet.querySelector<HTMLButtonElement>('[data-install-now]')?.addEventListener('click', () => { closeModal(); installApp().catch(() => {}); }); });
}
// ---------- customer service chat ----------
// The assistant answers first; a person on the team takes over when needed (or when asked).
// Signed in: conversations belong to the account. Not signed in: name + phone number with its country
// code, and the conversation is kept on this device with a token (localStorage).
type ChatMsg = { id: number; at: string; from: 'user' | 'bot' | 'agent' | 'system'; body: string };
type Ticket = { id: string; ref: string; status: 'bot' | 'open' | 'waiting' | 'resolved'; billId: string | null; unread: number; messages: ChatMsg[]; canVerify?: boolean; needsPhone?: boolean; phoneHint?: string };
const GUEST_TICKET_KEY = 'supportTicket';
function guestTicket(): { id: string; token: string } | null {
  try { return JSON.parse(localStorage.getItem(GUEST_TICKET_KEY) || 'null'); } catch { return null; }
}
function setGuestTicket(v: { id: string; token: string } | null): void {
  try { if (v) localStorage.setItem(GUEST_TICKET_KEY, JSON.stringify(v)); else localStorage.removeItem(GUEST_TICKET_KEY); } catch { /* private mode */ }
}
/** Support calls carry the guest token when there is no session. */
async function supportApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const g = !state.me ? guestTicket() : null;
  const send = method !== 'GET' ? (body ?? {}) : undefined;
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(send !== undefined ? { 'content-type': 'application/json' } : {}), ...(g ? { 'x-support-token': g.token } : {}) },
    body: send !== undefined ? JSON.stringify(send) : undefined,
  });
  checkVersion(res.headers.get('x-app-version'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error, res.status, data.message);
  return data as T;
}

let chatPoll: ReturnType<typeof setInterval> | undefined;
let chatTick: (() => void) | undefined;
const stopChatPoll = () => {
  clearInterval(chatPoll); chatPoll = undefined;
  if (chatTick) document.removeEventListener('visibilitychange', chatTick);
  chatTick = undefined;
};

function chatBubbles(msgs: ChatMsg[]): string {
  return msgs.map((m) => m.from === 'system'
    ? `<p class="chat-note">${esc(m.body)}</p>`
    : `<div class="msg ${m.from === 'user' ? 'me' : m.from}"><span class="who">${m.from === 'user' ? t('chat.you') : m.from === 'agent' ? t('chat.agent') : t('chat.bot')}</span>${esc(m.body).replace(/\n/g, '<br>')}<time>${chatTime(m.at)}</time></div>`).join('');
}

/** Opens the customer-service chat: the current conversation, or a new one (about a bill, if given). */
async function openSupport(opts: { billId?: string; billRef?: string } = {}): Promise<void> {
  stopChatPoll();
  try {
    if (state.me) {
      const { tickets } = await api<{ tickets: { id: string; status: string; billId: string | null }[] }>('GET', '/api/support/tickets');
      const current = tickets.find((x) => x.status !== 'resolved' && (!opts.billId || x.billId === opts.billId));
      if (current) return showChat(current.id);
    } else {
      const g = guestTicket();
      if (g) {
        const r = await supportApi<{ ticket: Ticket }>('GET', `/api/support/tickets/${g.id}`).catch(() => null);
        if (r && r.ticket.status !== 'resolved') return showChat(g.id, r.ticket);
        if (!r) setGuestTicket(null);
      }
    }
  } catch (e) { reportUnexpected(e); }
  newChat(opts);
}

function newChat(opts: { billId?: string; billRef?: string } = {}): void {
  stopChatPoll();
  const guest = !state.me;
  openModal(`<div class="row between"><h2>💬 ${t('chat.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted">${t('chat.intro')}</p>
    ${opts.billRef ? `<p class="notice info">${t('chat.aboutBill', { ref: esc(opts.billRef) })}</p>` : ''}
    ${guest ? `<label for="chName">${t('chat.name')}</label><input id="chName" autocomplete="name">
      <label for="chPhone">${t('chat.phone')}</label>${phoneField('chPhone', { autocomplete: true, cc: state.lang === 'en' ? 'US' : 'CD' })}
      <p class="muted small">${t('chat.phoneHint')}</p>` : ''}
    <label for="chText">${t('chat.question')}</label>
    <textarea id="chText" rows="3" maxlength="1000" placeholder="${esc(t('chat.placeholder'))}"></textarea>
    <button class="block" id="chStart">${t('chat.send')}</button>
    ${guest ? `<p class="muted small">${t('chat.guestNote')}</p>` : ''}`, (sheet) => {
    $('#chStart', sheet).onclick = (e) => busy(btn(e), async () => {
      const text = val('#chText', sheet).trim();
      if (!text) { toast(t('chat.empty')); return; }
      const body: Record<string, unknown> = { text, lang: state.lang, billId: opts.billId };
      if (guest) {
        body.name = val('#chName', sheet).trim();
        body.phone = readPhone('chPhone', sheet) || undefined;
      }
      const r = await supportApi<{ ticket: Ticket; token?: string }>('POST', '/api/support/tickets', body);
      if (r.token) setGuestTicket({ id: r.ticket.id, token: r.token });
      showChat(r.ticket.id, r.ticket);
    });
  });
}

async function showChat(id: string, ticket?: Ticket): Promise<void> {
  const tk = ticket || (await supportApi<{ ticket: Ticket }>('GET', `/api/support/tickets/${id}`)).ticket;
  const statusText = (s: Ticket['status']) => t('chat.status.' + s);
  openModal(`<div class="row between"><h2>💬 ${t('chat.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted small"><span>${t('chat.request', { ref: esc(tk.ref) })}</span> · <span id="chStatus">${statusText(tk.status)}</span></p>
    <div class="chat" id="chList" aria-live="polite">${chatBubbles(tk.messages)}</div>
    <div class="chat-input"><textarea id="chText" rows="2" maxlength="1000" placeholder="${esc(t('chat.placeholder'))}"></textarea><button id="chSend" aria-label="${t('chat.send')}">➤</button></div>
    <div class="row between chat-actions"><button class="link ${tk.status === 'bot' ? '' : 'hidden'}" id="chHuman">🙋 ${t('chat.human')}</button><button class="link" id="chEnd">✓ ${t('chat.end')}</button><button class="link" id="chNew">${t('chat.new')}</button></div>
    <div class="verify-box ${tk.needsPhone ? '' : 'hidden'}" id="chPhoneBox">
      <p class="small">📱 ${t('chat.addPhoneWhy')}</p>
      ${phoneField('chAddPhone', { autocomplete: true, cc: state.lang === 'en' ? 'US' : 'CD' })}
      <button class="secondary block" id="chAddPhoneBtn">${t('chat.addPhone')}</button>
    </div>
    <div class="verify-box ${tk.canVerify ? '' : 'hidden'}" id="chVerifyBox">
      <p class="small">🔒 ${t('chat.verifyWhy')}</p>
      <button class="secondary block" id="chVerify">${t('chat.verify', { phone: esc(tk.phoneHint || '') })}</button>
      <div class="hidden" id="chCodeStep">
        <p class="small">${t('chat.codeSent', { phone: esc(tk.phoneHint || '') })}</p>
        <p class="muted small">${t('chat.noCode')}</p>
        <p class="notice hidden" id="chDev"></p>
        <div class="chat-input"><input id="chCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"><button id="chCheck">${t('chat.check')}</button></div>
      </div>
    </div>`, (sheet) => {
    let last = tk;
    const list = $('#chList', sheet);
    const paint = (x: Ticket) => {
      const scrolledDown = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
      if (x.messages.length !== last.messages.length || x === last) list.innerHTML = chatBubbles(x.messages);
      $('#chStatus', sheet).textContent = statusText(x.status);
      $('#chHuman', sheet).classList.toggle('hidden', x.status !== 'bot');
      if (scrolledDown || x !== last) list.scrollTop = list.scrollHeight;
      last = x;
      markSupportUnread(false);
    };
    paint(tk); list.scrollTop = list.scrollHeight;
    const sendMsg = (b: HTMLButtonElement) => busy(b, async () => {
      const text = val('#chText', sheet).trim();
      if (!text) return;
      // Show the message at once; the answer follows.
      list.insertAdjacentHTML('beforeend', chatBubbles([{ id: -1, at: new Date().toISOString(), from: 'user', body: text }]) + `<p class="chat-note" data-typing><span class="spinner"></span></p>`);
      list.scrollTop = list.scrollHeight;
      $<HTMLTextAreaElement>('#chText', sheet).value = '';
      try { paint((await supportApi<{ ticket: Ticket }>('POST', `/api/support/tickets/${id}/messages`, { text })).ticket); }
      catch (e) { list.querySelector('[data-typing]')?.remove(); $<HTMLTextAreaElement>('#chText', sheet).value = text; throw e; }
    });
    $('#chSend', sheet).onclick = (e) => sendMsg(btn(e));
    $<HTMLTextAreaElement>('#chText', sheet).onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $<HTMLButtonElement>('#chSend', sheet).click(); } };
    $('#chHuman', sheet).onclick = (e) => busy(btn(e), async () => paint((await supportApi<{ ticket: Ticket }>('POST', `/api/support/tickets/${id}/escalate`)).ticket));
    $('#chNew', sheet).onclick = () => { if (!state.me) setGuestTicket(null); newChat(); };
    // Ending it clears the chat: the help button then opens a fresh one.
    $('#chEnd', sheet).onclick = (e) => busy(btn(e), async () => {
      await supportApi('POST', `/api/support/tickets/${id}/close`);
      if (!state.me) setGuestTicket(null);
      stopChatPoll(); closeModal(); markSupportUnread(false); toast(t('chat.ended'));
    });
    // A visitor who started without a number adds it (then can verify it).
    $('#chAddPhoneBtn', sheet).onclick = (e) => busy(btn(e), async () => {
      const ph = readPhone('chAddPhone', sheet);
      if (!ph) { toast(t('chat.phoneNeeded')); return; }
      const r = await supportApi<{ ticket: Ticket }>('POST', `/api/support/tickets/${id}/phone`, { phone: ph });
      showChat(id, r.ticket);
    });
    // A visitor proves the number is theirs (code by WhatsApp): then the assistant sees their bills.
    $('#chVerify', sheet).onclick = (e) => busy(btn(e), async () => {
      const r = await supportApi<{ devCode?: string }>('POST', `/api/support/tickets/${id}/send-code`);
      $('#chCodeStep', sheet).classList.remove('hidden');
      $('#chVerify', sheet).classList.add('hidden');
      if (r.devCode) { const d = $('#chDev', sheet); d.textContent = t('login.devCode', { code: r.devCode }); d.classList.remove('hidden'); }
      $<HTMLInputElement>('#chCode', sheet).focus();
    });
    $('#chCheck', sheet).onclick = (e) => busy(btn(e), async () => {
      const code = val('#chCode', sheet).replace(/\D/g, '');
      if (code.length !== 6) { toast(t('err.invalid_code')); return; }
      const r = await supportApi<{ ticket: Ticket; user: Me }>('POST', `/api/support/tickets/${id}/verify`, { code });
      $('#chVerifyBox', sheet).classList.add('hidden');
      { setGuestTicket(null); state.me = r.user; setUser(r.user.id, r.user.role); document.getElementById('logoutBtn')!.classList.remove('hidden'); route(); }
      paint(r.ticket);
    });
    $<HTMLInputElement>('#chCode', sheet).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $<HTMLButtonElement>('#chCheck', sheet).click(); } };
    // While a person is on it, look for their answer every few seconds (only while the chat is open).
    // Also checked as soon as the person comes back to the app.
    chatTick = async () => {
      if (!document.body.contains(list)) return stopChatPoll();
      if (document.hidden || (last.status !== 'open' && last.status !== 'waiting')) return;
      try { paint((await supportApi<{ ticket: Ticket }>('GET', `/api/support/tickets/${id}`)).ticket); } catch { /* try again later */ }
    };
    chatPoll = setInterval(chatTick, 8000);
    document.addEventListener('visibilitychange', chatTick);
  });
}

/** A dot on the help button when the team has answered. */
function markSupportUnread(on: boolean): void { document.getElementById('helpBtn')?.classList.toggle('unread', on); }
async function checkSupportUnread(): Promise<void> {
  try {
    if (state.me) {
      if (state.me.role === 'admin') return;
      const { tickets } = await api<{ tickets: { unread: number }[] }>('GET', '/api/support/tickets');
      markSupportUnread(tickets.some((x) => x.unread));
    } else {
      const g = guestTicket();
      if (!g) return;
      const r = await supportApi<{ ticket: Ticket }>('GET', `/api/support/tickets/${g.id}`).catch(() => null);
      // Reading the ticket clears the server's flag, so judge by the last message instead.
      markSupportUnread(!!r && r.ticket.messages.at(-1)?.from === 'agent');
    }
  } catch { /* not important */ }
}
// ---------- partner hospitals, by commune ----------
type Facility = { name: string; commune: string; city: string; category: string };
type Commune = { name: string; aliases: string[] };
const foldText = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return d[b.length];
}
async function openNetwork(): Promise<void> {
  const { facilities, communes: all } = await api<{ facilities: Facility[]; communes: Commune[] }>('GET', '/api/network');
  const communes = [...new Set(facilities.map((f) => f.commune).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  // Every way of writing a commune ("Bandal", "Ndjili", "Binza"…), and every facility name: what a search can mean.
  const names: { key: string; label: string; commune?: string }[] = [
    ...all.flatMap((c) => [c.name, ...c.aliases].map((n) => ({ key: foldText(n), label: c.name, commune: c.name }))),
    ...facilities.flatMap((f) => [foldText(f.name), ...foldText(f.name).split(' ').filter((w) => w.length >= 4)].map((key) => ({ key, label: f.name }))),
  ];
  openModal(`<div class="row between"><h2>🏥 ${t('network.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted">${t('network.intro')}</p>
    <div class="row filters"><select id="nwCommune" aria-label="${t('network.commune')}"><option value="">${t('network.allCommunes')} (${facilities.length})</option>
      ${communes.map((c) => `<option value="${esc(c)}">${esc(c)} (${facilities.filter((f) => f.commune === c).length})</option>`).join('')}</select>
      <input id="nwSearch" type="search" placeholder="${esc(t('network.search'))}" aria-label="${esc(t('network.search'))}"></div>
    <p class="small hidden" id="nwSuggest"></p>
    <div id="nwList"></div>
    <p class="muted small">${t('network.missing')}</p>
    <button class="secondary block" data-chat>💬 ${t('chat.cta')}</button>`, (sheet) => {
    const search = $<HTMLInputElement>('#nwSearch', sheet);
    const paint = () => {
      const c = val('#nwCommune', sheet), q = foldText(search.value);
      // A commune typed by its short name or a neighbourhood counts as that commune.
      const meant = q.length >= 3 ? names.find((n) => n.commune && n.key === q)?.commune : undefined;
      const rows = facilities.filter((f) => (!c || f.commune === c) && (!q || (meant ? f.commune === meant : foldText(`${f.name} ${f.commune}`).includes(q))));
      // Nothing found: suggest the closest name or commune ("Vouliez-vous dire Bandalungwa ?").
      const sug = $('#nwSuggest', sheet);
      let suggestion: string | undefined;
      if (q.length >= 3 && !rows.length && !meant) {
        const scored = names.map((n) => ({ n, d: n.key.startsWith(q) ? 0 : editDistance(q, n.key.slice(0, Math.max(q.length, Math.min(n.key.length, q.length + 2)))) }))
          .filter((x) => x.d <= (q.length >= 6 ? 2 : 1)).sort((a, b) => a.d - b.d);
        suggestion = scored[0]?.n.label;
      }
      sug.classList.toggle('hidden', !suggestion);
      sug.innerHTML = suggestion ? `${t('network.didYouMean')} <button class="link" data-sug="${esc(suggestion)}">${esc(suggestion)}</button> ?` : '';
      sug.querySelector<HTMLButtonElement>('[data-sug]')?.addEventListener('click', (e) => { search.value = (e.currentTarget as HTMLElement).dataset.sug!; paint(); });
      const groups = [...new Set(rows.map((f) => f.commune || t('network.noCommune')))];
      $('#nwList', sheet).innerHTML = rows.length ? groups.map((g) => `<h3 class="nw-commune">${esc(g)}</h3><ul class="nw">${rows.filter((f) => (f.commune || t('network.noCommune')) === g)
        .map((f) => `<li><b>${esc(f.name)}</b><span class="muted small">${t('cat.' + f.category)}${f.city && f.city !== 'Kinshasa' ? ' · ' + esc(f.city) : ''}</span></li>`).join('')}</ul>`).join('')
        : `<p class="muted">${meant ? t('network.noneIn', { commune: esc(meant) }) : t('network.none')}</p>`;
    };
    $('#nwCommune', sheet).onchange = paint;
    search.oninput = paint;
    wireChatLinks(sheet);
    paint();
  });
}
const networkLink = () => `<p class="center"><button class="link" data-network>🏥 ${t('network.cta')}</button></p>`;
const wireNetworkLinks = (root: ParentNode) => $$('[data-network]', root).forEach((b) => (b.onclick = () => openNetwork().catch(reportUnexpected)));

const chatLink = () => `<p class="center"><button class="link" data-chat>💬 ${t('chat.cta')}</button></p>`;
const wireChatLinks = (root: ParentNode) => $$('[data-chat]', root).forEach((b) => (b.onclick = () => openSupport()));

// ---------- "install the app" ----------
// AmaniCare is an installable web app: once added to the home screen it opens full screen, like an app.
// Android (Chrome, Edge, Samsung Internet) offers a real install prompt; iPhone only allows Share › Add to
// Home Screen, so we show the steps; WhatsApp's or Facebook's built-in browser can't install at all.
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPrompt | null = null;
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);
const inAppBrowser = /FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)/i.test(ua);
const installed = (): boolean => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const INSTALL_KEY = 'installDismissedAt';
function installSteps(): string {
  if (inAppBrowser) return `<p>${t('install.inapp')}</p>`;
  if (isIOS) return `<ol class="steps"><li>${t('install.ios.1')}</li><li>${t('install.ios.2')}</li><li>${t('install.ios.3')}</li><li>${t('install.ios.4')}</li></ol>`;
  return `<ol class="steps"><li>${t('install.android.1')}</li><li>${t('install.android.2')}</li><li>${t('install.android.3')}</li></ol>`;
}
function openInstallGuide(): void {
  openModal(`<div class="row between"><h2>${t('install.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted">${t('install.why')}</p>${installSteps()}
    <button class="block" data-close>${t('close')}</button>`);
}
async function installApp(): Promise<void> {
  if (!installPrompt || isIOS || inAppBrowser) return openInstallGuide();
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome === 'accepted') { hideInstallBar(); toast(t('install.done')); }
}
function hideInstallBar(): void { document.getElementById('installBar')?.remove(); }
let appReady = false; // the bar waits for the person's language to be loaded
function showInstallBar(): void {
  if (!appReady || installed() || document.getElementById('installBar')) return;
  if (!isIOS && !isAndroid && !installPrompt) return; // computers: only when the browser offers to install
  try { const at = Number(localStorage.getItem(INSTALL_KEY) || 0); if (Date.now() - at < 14 * 864e5) return; } catch { /* storage blocked */ }
  const bar = document.createElement('div');
  bar.id = 'installBar'; bar.className = 'install-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', t('install.title'));
  bar.innerHTML = `<img src="/icon-192.png" alt="" width="36" height="36"><span>${t('install.bar')}</span>
    <button type="button" data-install>${t('install.button')}</button><button type="button" class="link" data-later aria-label="${t('install.later')}">✕</button>`;
  bar.querySelector<HTMLButtonElement>('[data-install]')!.onclick = () => { installApp().catch(() => openInstallGuide()); };
  bar.querySelector<HTMLButtonElement>('[data-later]')!.onclick = () => { try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch { /* ignore */ } hideInstallBar(); };
  document.querySelector('header.bar')!.after(bar);
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e as InstallPrompt; showInstallBar(); });
window.addEventListener('appinstalled', () => { hideInstallBar(); installPrompt = null; });

document.getElementById('helpBtn')!.addEventListener('click', openHelp);
const helpLink = () => `<p class="center"><button class="link" data-help>❓ ${t('howItWorks')}</button></p>`;
const wireHelpLinks = (root: ParentNode) => $$('[data-help]', root).forEach((b) => (b.onclick = openHelp));

/** One sentence telling payer or family what happens next with this bill. */
/** A history line as the reader sees it: the payer and the family each read it from their own side
 *  ("You started the payment" / "Marie started the payment"); others get the neutral wording. */
function eventText(type: string, b: Bill): string {
  const role = state.me?.role;
  const own = `event.${type}.${role}`;
  const key = (role === 'payer' || role === 'family') && (state.dict[own] ?? state.fallback[own]) ? own : `event.${type}`;
  return t(key, { payer: b.payer?.name || t('event.someoneAbroad'), family: b.family?.name || t('event.theFamily') });
}

function nextStep(b: Bill): string {
  const role = state.me?.role;
  if (role !== 'payer' && role !== 'family') return '';
  if (b.status === 'rejected' && b.rejection?.reason) return ''; // the reason already says what to do
  const payer = esc(b.payer?.name || '');
  // Sent before the relative abroad accepted the invitation.
  if (role === 'family' && !b.payer && b.waitingFor && ['awaiting_clinic', 'awaiting_payer'].includes(b.status)) {
    const name = esc(b.waitingFor.relation || b.waitingFor.phone || '');
    return `<p class="next"><b>${t('next.label')}</b>${t(`next.${b.status}.waiting`, { name })}</p>`;
  }
  const key = ['awaiting_clinic', 'awaiting_payer', 'payment_failed', 'declined', 'paid'].includes(b.status) ? `next.${b.status}.${role}` : `next.${b.status}`;
  const tone = b.status === 'paid' ? 'done' : ['rejected', 'payout_failed', 'payment_failed'].includes(b.status) ? 'bad' : '';
  return `<p class="next ${tone}"><b>${t('next.label')}</b>${t(key, { payer, family: esc(b.family?.name || '') })}</p>`;
}

// ---------- login ----------
function renderLogin(): void {
  // side: which side of the family the visitor is on. Picked on the welcome card, or guessed from the
  // phone number (+243 → in the DRC) until they pick. It sets the steps shown and the role at sign-up.
  const s: { phone: string; code: string; step: 'phone' | 'code' | 'profile'; role: string; name: string; devCode?: string; side: '' | 'payer' | 'family'; picked: boolean; ccPicked?: boolean } =
    { phone: '', code: '', step: 'phone', role: pendingInvite() ? pendingInviteAs() : '', name: '', side: pendingInvite() ? pendingInviteAs() : '', picked: !!pendingInvite() };
  const setSide = (side: 'payer' | 'family', picked: boolean): void => {
    s.side = side; s.picked = s.picked || picked;
    if (!s.role || picked) s.role = side;
    $$<HTMLButtonElement>('[data-side]').forEach((b) => { b.classList.toggle('on', b.dataset.side === side); b.setAttribute('aria-pressed', String(b.dataset.side === side)); });
    $<HTMLButtonElement>(`[data-guide-tab="${side}"]`)?.click();
    const ph = document.querySelector<HTMLInputElement>('#ph'); if (ph) ph.placeholder = side === 'family' ? '81 234 5678' : '214 555 0100';
    // The country picker follows the side until the person changes it themselves.
    if (!s.ccPicked) setPhoneCountry('ph', side === 'family' ? 'CD' : 'US');
  };
  const draw = (): void => {
    app.innerHTML = `
      <div class="card hero">
        <h1>${t('login.title')}</h1>
        <p class="muted">${t('login.subtitle')}</p>
        ${pendingInvite() ? `<p class="notice info">${t('login.invited')}</p>` : ''}
        ${s.step === 'phone' ? `
          <p class="side-q">${t('side.question')}</p>
          <div class="sides">${(['family', 'payer'] as const).map((r) => `<button type="button" class="side ${s.side === r ? 'on' : ''}" data-side="${r}" aria-pressed="${s.side === r}">
            <span class="side-icon" aria-hidden="true">${r === 'family' ? '🏠' : '✈️'}</span><b>${t('side.' + r)}</b><span>${t('side.' + r + 'Hint')}</span></button>`).join('')}</div>
          <label for="ph">${t('login.phone')}</label>
          ${phoneField('ph', { value: s.phone, cc: s.side === 'payer' ? 'US' : 'CD', placeholder: s.side === 'payer' ? '214 555 0100' : '81 234 5678', autocomplete: true })}
          <p class="muted small">${t('login.phoneHint')}</p>
          <button class="block" id="sendCode">${t('login.sendCode')}</button>`
        : s.step === 'code' ? `
          <label for="cd">${t('login.code', { phone: esc(s.phone) })}</label>
          <input id="cd" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
          ${s.devCode ? `<p class="notice">${t('login.devCode', { code: s.devCode })}</p>` : ''}
          <button class="block" id="verify">${t('login.verify')}</button>
          <button class="link" id="back">${t('login.changeNumber')}</button>`
        : `
          <h2>${t('login.whoAreYou')}</h2>
          <button class="choice ${s.role === 'payer' ? 'on' : ''}" data-role="payer">${t('role.payer')}<span>${t('role.payerHint')}</span></button>
          <button class="choice ${s.role === 'family' ? 'on' : ''}" data-role="family">${t('role.family')}<span>${t('role.familyHint')}</span></button>
          <label for="nm">${t('login.name')}</label>
          <input id="nm" autocomplete="name" value="${esc(s.name)}">
          <button class="block" id="finish">${t('login.start')}</button>`}
      </div>
      <p class="center"><a class="link" href="#guide">❓ ${t('login.haveQuestions')}</a></p>
      ${networkLink()}
      ${chatLink()}
      <section class="card" id="guide">
        <h2>${t('guide.title')}</h2>
        <p class="muted">${t('guide.intro')}</p>
        ${guideHtml(s.side || 'family', ['family', 'payer', 'clinic'])}
        ${trustHtml()}
        ${faqHtml()}
      </section>
      <p class="muted small center">${t('login.footer')}</p>
      <p class="muted small center"><a href="/privacy.html${state.lang === 'en' ? '#en' : ''}">${t('privacy')}</a></p>`;
    wireGuide(app); wireChatLinks(app); wireNetworkLinks(app);

    if (s.step === 'phone') {
      $$<HTMLButtonElement>('[data-side]').forEach((b) => (b.onclick = () => { setSide(b.dataset.side as 'payer' | 'family', true); $('#ph').focus(); }));
      // Until they pick, guess the side from the number: a DRC number means family in the DRC.
      $('#ph').oninput = () => {
        if (s.picked) return;
        const typed = val('#ph').trim();
        const digits = typed.replace(/\D/g, '');
        if (digits.length < 3) return;
        if (typed.startsWith('+') || typed.startsWith('00')) setSide(digits.replace(/^00/, '').startsWith('243') ? 'family' : 'payer', false);
        else if (/^0?[89]/.test(digits) && val('#phCc') === 'CD') setSide('family', false);
      };
      $('#phCc').onchange = () => { s.ccPicked = true; if (!s.picked) setSide(val('#phCc') === 'CD' ? 'family' : 'payer', false); };
      $('#sendCode').onclick = (e) => busy(btn(e), async () => {
        s.phone = readPhone('ph');
        const r = await api<{ devCode?: string }>('POST', '/api/auth/request-otp', { phone: s.phone, lang: state.lang });
        s.devCode = r.devCode; s.step = 'code'; draw(); $('#cd').focus();
      });
    } else if (s.step === 'code') {
      $('#back').onclick = () => { s.step = 'phone'; draw(); };
      $('#verify').onclick = (e) => busy(btn(e), async () => {
        s.code = val('#cd').trim();
        const r = await api<{ needsProfile?: boolean; user: Me }>('POST', '/api/auth/verify', { phone: s.phone, code: s.code, lang: state.lang });
        if (r.needsProfile) { s.step = 'profile'; draw(); return; }
        await signedIn(r.user);
      });
    } else {
      $$('[data-role]').forEach((b) => (b.onclick = () => { s.role = b.dataset.role!; s.name = val('#nm'); draw(); }));
      $('#finish').onclick = (e) => busy(btn(e), async () => {
        s.name = val('#nm').trim();
        if (!s.role) return toast(t('login.pickRole'));
        if (!s.name) return toast(t('login.enterName'));
        const r = await api<{ user: Me }>('POST', '/api/auth/verify', { phone: s.phone, code: s.code, lang: state.lang, role: s.role, name: s.name });
        await signedIn(r.user);
      });
    }
  };
  draw();
}

async function signedIn(user: Me): Promise<void> {
  state.me = user;
  setUser(user.id, user.role);
  if (user.lang && user.lang !== state.lang && LANGS.includes(user.lang)) await loadLang(user.lang);
  document.getElementById('logoutBtn')!.classList.remove('hidden');
  await acceptPendingInvite();
  route();
  checkSupportUnread();
}

// ---------- payer ----------
async function renderPayer(): Promise<void> {
  app.innerHTML = `<p class="center"><span class="spinner"></span></p>`;
  const [{ bills }, { members }, sentInvites] = await Promise.all([
    api<{ bills: Bill[] }>('GET', '/api/bills'),
    api<{ members: { id: string; name: string; phone: string; relation: string }[] }>('GET', '/api/family'),
    sentInvitesHtml(),
  ]);
  const todo = bills.filter((b) => ['awaiting_payer', 'payment_failed'].includes(b.status));
  const moving = bills.filter((b) => ['review', 'awaiting_clinic', 'payment_pending', 'paying_out'].includes(b.status));
  const done = bills.filter((b) => ['paid', 'rejected', 'declined', 'payout_failed'].includes(b.status));
  app.innerHTML = `
    <h1>${t('hello', { name: esc(me().name) })}</h1>
    <p class="muted">${t('payer.subtitle')}</p>
    ${members.length ? '' : `<div class="card start"><h2>${t('start.payer.title')}</h2><p>${t('start.payer.text')}</p>
      ${guideSteps('payer')}
      <button class="block" data-invite>👨‍👩‍👧 ${t('start.payer.button')}</button>
      <button class="secondary block" data-have-code>🔑 ${t('code.received')}</button></div>`}
    <div class="card"><h2>${t('payer.toApprove')}</h2>
      ${todo.length ? todo.map((b) => billCard(b, { showReasons: true, showExpected: true, showNext: false, actions: `
        ${b.status === 'payment_failed' ? `<p class="notice">${t('payer.paymentFailed')}</p>` : ''}
        <div class="row"><button class="grow" data-pay="${b.id}" data-amount="${usd(b.totalUsd + b.feeUsd)}">${t('payer.pay', { amount: usd(b.totalUsd + b.feeUsd) })}</button><button class="secondary small" data-decline="${b.id}">${t('payer.decline')}</button></div>
        <p class="muted small">${t('payer.feeNote', { fee: usd(b.feeUsd) })}</p>` })).join('') : `<p class="empty">${t('payer.nothingToApprove')}</p>`}
    </div>
    ${moving.length ? `<div class="card"><h2>${t('inProgress')}</h2>${moving.map((b) => billCard(b, { showReasons: true })).join('')}</div>` : ''}
    <div class="card"><div class="row between"><h2>${t('payer.family')}</h2><button class="small secondary" id="invite">${t('payer.invite')}</button></div>
      ${members.length ? `<table><tbody>${members.map((m) => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.relation)}</div></td><td class="num muted small">${esc(m.phone)}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${t('payer.noFamily')}</p>`}
      <button class="link" data-have-code>🔑 ${t('code.received')}</button>
    </div>
    ${codeCardHtml(true, t('code.title'), t('code.payerText'))}
    ${sentInvites}
    <div class="card"><h2>${t('history')}</h2>${done.length ? done.map((b) => billCard(b)).join('') : `<p class="empty">${t('noHistory')}</p>`}</div>
    ${helpLink()}`;
  wireDetails(app);
  wireHelpLinks(app);
  $('#invite').onclick = inviteFlow;
  $$('[data-invite]').forEach((b) => (b.onclick = inviteFlow));
  $$('[data-have-code]').forEach((b) => (b.onclick = () => { $('#linkCard').classList.remove('hidden'); $('#code').focus(); }));
  wireCodeCard(renderPayer);
  wireSentInvites(app);
  $$('[data-pay]').forEach((b) => (b.onclick = (e) => busy(btn(e), async () => {
    const how = await payDialog(b.dataset.amount || '');
    if (!how) return;
    const r = await api<{ checkoutUrl: string | null; method: string }>('POST', `/api/bills/${b.dataset.pay}/pay`, how);
    if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
    if (r.method !== 'card') toast(t('pay.approveOnPhone'));
    renderPayer();
  })));
  $$('[data-decline]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('payer.declineConfirm'), t('payer.decline'), true))) return;
    try { await api('POST', `/api/bills/${b.dataset.decline}/decline`, {}); renderPayer(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
}

interface SentInvite { code: string; link: string; relation: string; phone: string | null; expiresAt: number; expired: boolean; sent?: boolean }

/** WhatsApp message (and wa.me link) for an invitation, worded for who it's going to. */
function inviteMessage(inv: SentInvite): { msg: string; wa: string } {
  const abroad = me().role === 'family'; // a relative in the DRC invites someone abroad
  const key = abroad ? (inv.phone ? 'invite.abroad.messagePhone' : 'invite.abroad.message') : (inv.phone ? 'invite.messagePhone' : 'invite.message');
  const url = `${location.origin}/?invite=${inv.code}&as=${abroad ? 'payer' : 'family'}`;
  const msg = t(key, { name: me().name, code: inv.code, url });
  // wa.me opens WhatsApp (app or web) with the message ready; with a number it opens that chat directly.
  return { msg, wa: `https://wa.me/${inv.phone ? inv.phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(msg)}` };
}

/** Code, message and Send-on-WhatsApp / Copy buttons for an invitation just created or renewed. */
function showInvite(root: HTMLElement, inv: SentInvite): void {
  const { msg, wa } = inviteMessage(inv);
  root.innerHTML = `<div class="code">${inv.code}</div>
    <p class="muted small">${inv.phone ? t('invite.expiresPhone', { phone: esc(inv.phone) }) : t('invite.expires')}</p>
    ${inv.sent ? `<p class="notice info">${t('invite.sent', { phone: esc(inv.phone || '') })}</p>` : ''}
    <p class="small">${esc(msg)}</p>
    <a class="btn block" href="${esc(wa)}" target="_blank" rel="noopener">${t(inv.sent ? 'invite.whatsappAgain' : 'invite.whatsapp')}</a>
    <button class="secondary block" data-copy>${t('invite.copy')}</button>`;
  $('[data-copy]', root).onclick = async () => { try { await navigator.clipboard.writeText(msg); toast(t('copied')); } catch { toast(t('copyFailed')); } };
}

function inviteFlow(): void {
  const abroad = me().role === 'family';
  openModal(`
    <div class="row between"><h2>${t(abroad ? 'invite.abroad.title' : 'invite.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted">${t(abroad ? 'invite.abroad.subtitle' : 'invite.subtitle')}</p>
    <label for="rel">${t('invite.relation')}</label>
    <input id="rel" placeholder="${t(abroad ? 'invite.abroad.relationPh' : 'invite.relationPh')}">
    <label for="invPhone">${t('invite.phone')}</label>
    ${phoneField('invPhone', { cc: abroad ? 'US' : 'CD', placeholder: abroad ? '214 555 0100' : '81 234 5678' })}
    <p class="muted small">${t('invite.phoneHint')}</p>
    <button class="block" id="mk">${t('invite.create')}</button>
    <div id="out"></div>`, (s) => {
    $('#mk', s).onclick = (e) => busy(btn(e), async () => {
      const phone = readPhone('invPhone', s);
      const inv = await api<SentInvite>('POST', '/api/invites', { relation: val('#rel', s), phone: phone || undefined });
      $('#mk', s).classList.add('hidden');
      showInvite($('#out', s), inv);
      route(); // the page behind now lists this invitation
    });
  });
}

/** "Invitations sent" list: waiting ones can be shared again; expired ones sent again with a new code. */
async function sentInvitesHtml(list?: SentInvite[]): Promise<string> {
  const invites = list || (await api<{ invites: SentInvite[] }>('GET', '/api/invites')).invites;
  if (!invites.length) return '';
  return `<div class="card"><h2>${t('invites.title')}</h2>${invites.map((i) => `<div class="invite-row">
    <div><b>${esc(i.relation || i.phone || i.code)}</b><div class="muted small">${i.phone ? esc(i.phone) + ' · ' : ''}${i.expired
      ? `<span class="pill high">${t('invites.expired')}</span>`
      : t('invites.waiting', { date: fmtDate(new Date(i.expiresAt).toISOString()) })}</div></div>
    <button class="small ${i.expired ? '' : 'secondary'}" data-inv="${esc(i.code)}" data-expired="${i.expired ? 1 : 0}">${t(i.expired ? 'invites.renew' : 'invites.share')}</button>
  </div>`).join('')}</div>`;
}
function wireSentInvites(root: ParentNode): void {
  $$<HTMLButtonElement>('[data-inv]', root).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => {
    let inv: SentInvite;
    if (b.dataset.expired === '1') {
      inv = await api<SentInvite>('POST', `/api/invites/${encodeURIComponent(b.dataset.inv!)}/renew`, {});
      toast(t('invites.renewed'));
    } else {
      inv = (await api<{ invites: SentInvite[] }>('GET', '/api/invites')).invites.find((x) => x.code === b.dataset.inv)!;
    }
    openModal(`<div class="row between"><h2>${t(me().role === 'family' ? 'invite.abroad.title' : 'invite.title')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div><div id="out"></div>`,
      (sheet) => showInvite($('#out', sheet), inv));
    if (b.dataset.expired === '1') route();
  })));
}

/** Code entry, for the code a relative sent (either direction). */
function codeCardHtml(hidden: boolean, title: string, text: string): string {
  return `<div class="card ${hidden ? 'hidden' : ''}" id="linkCard">
    <h2>${title}</h2><p class="muted">${text}</p>
    <input id="code" maxlength="6" placeholder="ABC123" autocapitalize="characters" aria-label="${t('code.title')}">
    <button class="block" id="link">${t('family.link')}</button>
  </div>`;
}
function wireCodeCard(after: () => void): void {
  $('#link').onclick = (e) => busy(btn(e), async () => {
    const r = await api<{ linkedWith: { name: string } }>('POST', '/api/invites/accept', { code: val('#code').trim().toUpperCase() });
    toast(t('family.linked', { name: r.linkedWith.name })); after();
  });
}

// ---------- family ----------
async function renderFamily(): Promise<void> {
  app.innerHTML = `<p class="center"><span class="spinner"></span></p>`;
  const [{ bills }, { payers }, { invites }] = await Promise.all([
    api<{ bills: Bill[] }>('GET', '/api/bills'), api<{ payers: Payer[] }>('GET', '/api/payers'), api<{ invites: SentInvite[] }>('GET', '/api/invites'),
  ]);
  const sentInvites = await sentInvitesHtml(invites);
  // A bill can be sent as soon as someone abroad is invited: it goes to them when they accept.
  const canSend = payers.length > 0 || invites.length > 0;
  const waitingNames = invites.map((i) => i.relation || i.phone || i.code).join(', ');
  app.innerHTML = `
    <h1>${t('hello', { name: esc(me().name) })}</h1>
    ${canSend ? `
      <button class="block big" id="newBill">📷 ${t('family.newBill')}</button>
      <p class="muted small center">${payers.length
        ? t('family.supportedBy', { names: esc(payers.map((p) => p.name).join(', ')) })
        : t('family.waitingFor', { names: esc(waitingNames) })}</p>` : `
      <div class="card start"><h2>🤝 ${t('start.family.title')}</h2><p>${t('start.family.text')}</p>
        <button class="block" data-invite>✉️ ${t('start.family.button')}</button>
        ${guideSteps('family')}</div>`}
    ${codeCardHtml(canSend, canSend ? t('family.linkTitle') : '🔑 ' + t('code.title'), canSend ? t('family.linkSubtitle') : t('start.family.code'))}
    ${canSend ? `<div class="card"><h2>${t('family.myBills')}</h2>${bills.length ? bills.map((b) => billCard(b)).join('') : `<p class="empty">${t('start.family.noBills')}</p>`}</div>` : ''}
    ${sentInvites}
    ${canSend ? `<div class="card"><h2>${t('family.addPayer')}</h2>
      <button class="secondary block" data-invite>✉️ ${t('start.family.button')}</button>
      <button class="link" data-have-code>🔑 ${t('code.received')}</button></div>` : ''}
    ${helpLink()}`;
  wireDetails(app);
  wireHelpLinks(app);
  wireCodeCard(renderFamily);
  wireSentInvites(app);
  $$('[data-invite]').forEach((b) => (b.onclick = inviteFlow));
  $$('[data-have-code]').forEach((b) => (b.onclick = () => { $('#linkCard').classList.remove('hidden'); $('#code').focus(); }));
  if (canSend) $('#newBill').onclick = () => newBillFlow(payers, invites);
}

async function compressImage(file: File, max = 1600, quality = 0.82): Promise<{ b64: string; url: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new ApiError('unsupported_image');
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale);
  c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((r, reject) => c.toBlob((b) => (b ? r(b) : reject(new ApiError('unsupported_image'))), 'image/jpeg', quality));
  const b64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  return { b64, url: URL.createObjectURL(blob) };
}

interface ItemDraft { d: string; q: number | string; p: number | string }

/** "1 Photo · 2 Check · 3 Send" indicator for sending a bill (4 = all done). */
const flowSteps = (current: number) => `<div class="flow" aria-hidden="true">${[1, 2, 3].map((i) =>
  `<span class="${i < current ? 'done' : i === current ? 'on' : ''}">${i < current ? '✓' : i} ${t('flow.' + i)}</span>`).join('')}</div>`;

async function newBillFlow(payers: Payer[], invites: SentInvite[] = []): Promise<void> {
  // Who pays: linked relatives abroad; with none yet, the relatives invited (the bill waits for them).
  const payTo = payers.length
    ? payers.map((p) => ({ value: 'p:' + p.id, label: `${p.name}${p.relation ? ` (${p.relation})` : ''}` }))
    : invites.map((i) => ({ value: 'i:' + i.code, label: `${i.relation || i.phone || i.code} · ${t('family.notJoinedYet')}` }));
  const { clinics } = await api<{ clinics: Clinic[] }>('GET', '/api/clinics');
  const f: { draftId: string | null; ai: AiRead | null; aiAvailable?: boolean; items: ItemDraft[]; photoUrl: string | null } =
    { draftId: null, ai: null, items: [{ d: '', q: 1, p: '' }], photoUrl: null };
  const drawPhoto = (): void => {
    app.innerHTML = `
      <button class="link" id="cancel">← ${t('back')}</button>
      <h1>${t('family.newBill')}</h1>
      ${flowSteps(1)}
      <div class="card">
        <label class="photo-drop" for="file"><b>📷 ${t('family.takePhoto')}</b>${t('family.photoHint')}
          <input id="file" type="file" accept="image/*" capture="environment"></label>
        <label class="btn secondary block gallery" for="file2">🖼️ ${t('photo.gallery')}
          <input id="file2" type="file" accept="image/*"></label>
        <div id="reading"></div>
        <h2>${t('photo.tips')}</h2>
        <ul class="tips">${[1, 2, 3, 4].map((i) => `<li>${t('photo.tip' + i)}</li>`).join('')}</ul>
        <p class="muted small">${t('photo.noPaper')}</p>
      </div>`;
    $('#cancel').onclick = renderFamily;
    $<HTMLInputElement>('#file2').onchange = (e) => $<HTMLInputElement>('#file').onchange!(e);
    $<HTMLInputElement>('#file').onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
      $('#reading').innerHTML = `<p class="center"><span class="spinner"></span> ${t('family.reading')}</p>`;
      try {
        const img = await compressImage(file);
        f.photoUrl = img.url;
        const r = await api<{ draftId: string; ai: AiRead | null; aiAvailable: boolean }>('POST', '/api/bills/extract', { image: img.b64, mediaType: 'image/jpeg' });
        f.draftId = r.draftId; f.ai = r.ai; f.aiAvailable = r.aiAvailable;
        if (r.ai?.items?.length) f.items = r.ai.items.map((i) => ({ d: i.description, q: i.qty, p: i.unit_price }));
        drawForm();
      } catch (err) { $('#reading').innerHTML = ''; reportUnexpected(err); toast(errText(err)); }
    };
  };
  const drawForm = (): void => {
    const ai: Partial<AiRead> = f.ai || {};
    const guessClinic = clinics.find((c) => ai.clinic_name && ai.clinic_name.toLowerCase().includes(c.name.toLowerCase().split(' ').pop()!));
    app.innerHTML = `
      <button class="link" id="cancel">← ${t('back')}</button>
      <h1>${t('family.checkDetails')}</h1>
      ${flowSteps(2)}
      ${f.ai && (f.ai.items?.length || f.ai.patient_name || f.ai.total) ? `<p class="notice info">${t('family.aiDone', { pct: Math.round((ai.confidence || 0) * 100) })}</p>`
        : `<p class="notice">${f.aiAvailable ? t('family.aiFailed') : t('family.aiOff')}</p>`}
      <div class="card">
        <img class="preview" src="${f.photoUrl}" alt="${t('billPhoto')}">
        <label for="clinic">${t('family.clinic')}</label>
        <select id="clinic"><option value="">${t('family.pickClinic')}</option>${clinics.map((c) => `<option value="${c.id}" ${guessClinic?.id === c.id ? 'selected' : ''}>${esc(c.name)} – ${esc(c.commune)} · ${t('cat.' + c.category)}</option>`).join('')}</select>
        <p class="muted small">${t('family.clinicMissing')}</p>
        ${payTo.length > 1 ? `<label for="payer">${t('family.whoPays')}</label><select id="payer">${payTo.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>` : ''}
        ${!payers.length ? `<p class="notice info">${t('family.billWaits', { name: esc(payTo[0].label.split(' · ')[0]) })}</p>` : ''}
        <div class="grid2">
          <div><label for="patient">${t('family.patient')}</label><input id="patient" value="${esc(ai.patient_name || '')}"></div>
          <div><label for="billNo">${t('billNo')}</label><input id="billNo" value="${esc(ai.bill_number || '')}"></div>
          <div><label for="date">${t('date')}</label><input id="date" type="date" value="${esc(ai.date || new Date().toISOString().slice(0, 10))}"></div>
          <div><label for="cur">${t('currency')}</label><select id="cur"><option value="USD">USD ($)</option><option value="CDF" ${ai.currency === 'CDF' ? 'selected' : ''}>CDF (FC)</option></select></div>
        </div>
        <label>${t('family.items')}</label>
        <div class="scroll"><table><thead><tr><th>${t('item')}</th><th class="num">${t('qty')}</th><th class="num">${t('unitPrice')}</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
        <button class="link" id="addItem">+ ${t('family.addItem')}</button>
        <label for="total">${t('family.totalOnBill')}</label>
        <input id="total" type="number" inputmode="decimal" step="0.01" value="${ai.total || ''}">
        <button class="block" id="submit">${t('family.submit')}</button>
        <p class="muted small">${t('family.submitHint')}</p>
      </div>`;
    const drawItems = (): void => {
      $('#items').innerHTML = f.items.map((i, n) => `<tr>
        <td><input data-n="${n}" data-k="d" value="${esc(i.d)}" placeholder="${t('family.itemPh')}"></td>
        <td class="num"><input class="qty" data-n="${n}" data-k="q" type="number" min="1" inputmode="numeric" value="${i.q}"></td>
        <td class="num"><input class="price" data-n="${n}" data-k="p" type="number" min="0" step="0.01" inputmode="decimal" value="${i.p}"></td>
        <td><button class="link" data-rm="${n}" aria-label="${t('remove')}">✕</button></td></tr>`).join('');
      $$<HTMLInputElement>('#items input').forEach((inp) => (inp.oninput = () => { f.items[Number(inp.dataset.n)][inp.dataset.k as keyof ItemDraft] = inp.value; }));
      $$('#items [data-rm]').forEach((b) => (b.onclick = () => { f.items.splice(Number(b.dataset.rm), 1); if (!f.items.length) f.items.push({ d: '', q: 1, p: '' }); drawItems(); }));
    };
    drawItems();
    $('#cancel').onclick = renderFamily;
    $('#addItem').onclick = () => { f.items.push({ d: '', q: 1, p: '' }); drawItems(); };
    $('#submit').onclick = (e) => busy(btn(e), async () => {
      const items = f.items.filter((i) => String(i.d).trim()).map((i) => ({ d: String(i.d).trim(), q: Number(i.q) || 1, p: Number(i.p) || 0 }));
      if (!val('#clinic')) return toast(t('family.pickClinic'));
      if (!val('#patient').trim()) return toast(t('family.enterPatient'));
      if (!items.length) return toast(t('err.items_required'));
      const total = Number(val('#total')) || items.reduce((a, i) => a + i.q * i.p, 0);
      if (!(total > 0)) { $('#total').focus(); return toast(t('err.invalid_total')); }
      const { bill } = await api<{ bill: Bill }>('POST', '/api/bills', {
        draftId: f.draftId, ...payToBody(document.querySelector<HTMLSelectElement>('#payer')?.value || payTo[0].value), clinicId: val('#clinic'),
        patientName: val('#patient').trim(), billNumber: val('#billNo').trim(), billDate: val('#date'),
        currency: val('#cur'), items, total: Number(val('#total')) || undefined,
      });
      app.innerHTML = `${flowSteps(4)}<div class="card center"><h1>${bill.status === 'review' ? '🔎' : '✅'}</h1>
        <h2>${bill.status === 'review' ? t('family.sentReview') : t('family.sentClinic')}</h2>
        <p class="muted">${t('family.nextSteps')}</p>${billCard(bill)}<button class="block" id="home">${t('family.done')}</button></div>`;
      wireDetails(app);
      $('#home').onclick = renderFamily;
    });
  };
  drawPhoto();
}

/** 'p:<id>' → linked payer; 'i:<code>' → invited relative who hasn't accepted yet. */
const payToBody = (v: string) => (v.startsWith('i:') ? { inviteCode: v.slice(2) } : { payerId: v.slice(2) });

// ---------- clinic ----------
async function renderClinic(): Promise<void> {
  app.innerHTML = `<p class="center"><span class="spinner"></span></p>`;
  const { bills } = await api<{ bills: Bill[] }>('GET', '/api/bills');
  const todo = bills.filter((b) => b.status === 'awaiting_clinic');
  const rest = bills.filter((b) => b.status !== 'awaiting_clinic');
  app.innerHTML = `
    <h1>${t('clinic.title')}</h1><p class="muted">${t('clinic.subtitle')}</p>
    <div class="card"><h2>${t('clinic.toConfirm')}</h2>
      ${todo.length ? todo.map((b) => billCard(b, { actions: `
        ${b.risk?.level === 'med' ? `<p class="notice">${t('clinic.checkCarefully')}</p>` : ''}
        <div class="row"><button class="grow" data-ok="${b.id}">✅ ${t('clinic.confirm')}</button><button class="grow danger" data-no="${b.id}">❌ ${t('clinic.reject')}</button></div>` })).join('') : `<p class="empty">${t('clinic.nothing')}</p>`}
    </div>
    <div class="card"><h2>${t('history')}</h2>${rest.length ? rest.map((b) => billCard(b, { actions: b.payout && b.status === 'paid' ? `<p class="notice info">${t('payoutSent', { ref: esc(b.payout.ref), account: esc(b.payout.account || '') })}</p>` : '' })).join('') : `<p class="empty">${t('noHistory')}</p>`}</div>
    ${helpLink()}`;
  wireDetails(app);
  wireHelpLinks(app);
  $$('[data-ok]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('clinic.confirmQ'), t('clinic.confirm')))) return;
    try { await api('POST', `/api/bills/${b.dataset.ok}/confirm`, {}); toast(t('clinic.confirmed')); renderClinic(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
  $$('[data-no]').forEach((b) => (b.onclick = async () => {
    const why = await rejectDialog(HOSPITAL_REASONS);
    if (!why) return;
    try { await api('POST', `/api/bills/${b.dataset.no}/reject`, why); renderClinic(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
}

// ---------- admin ----------
const ADMIN_TABS: AdminTab[] = ['overview', 'support', 'bills', 'clinics', 'users', 'prices', 'settings', 'messages', 'payments'];
async function renderAdmin(): Promise<void> {
  app.innerHTML = `<h1>${t('admin.title')}</h1>
    <nav class="tabs">${ADMIN_TABS.map((k) => `<button data-tab="${k}" class="${state.adminTab === k ? 'on' : ''}">${t('admin.tab.' + k)}</button>`).join('')}</nav>
    <div id="adminBody"><p class="center"><span class="spinner"></span></p></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { state.adminTab = b.dataset.tab as AdminTab; renderAdmin(); }));
  // On phones the tabs are one swipeable row: keep the open tab in view, and drop the fade at the end.
  const nav = $('nav.tabs');
  const atEnd = () => nav.classList.toggle('end', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 4);
  nav.onscroll = atEnd;
  const on = nav.querySelector<HTMLElement>('.on');
  if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - nav.offsetLeft - 16);
  atEnd();
  // Conversations waiting for a person: a count on the Support tab, whatever tab is open.
  api<{ counts: Record<string, number> }>('GET', '/api/admin/support?status=open&limit=1').then(({ counts }) => {
    const tab = nav.querySelector('[data-tab="support"]');
    if (tab && counts.open) tab.innerHTML = `${t('admin.tab.support')} <span class="badge">${counts.open}</span>`;
  }).catch(() => {});
  const body = $('#adminBody');
  try { await ADMIN[state.adminTab](body); } catch (e) { reportUnexpected(e); body.innerHTML = `<p class="notice">${esc(errText(e))}</p>`; }
}

const BILL_STATUSES = ['review', 'awaiting_clinic', 'awaiting_payer', 'payment_pending', 'paying_out', 'paid', 'payment_failed', 'payout_failed', 'rejected', 'declined'];

/**
 * A list that loads 50 at a time with a "Load more" button. fetchPage(offset) returns the rows and whether
 * there are more; renderRows(rows) returns their HTML (appended into `body`); wire(rows) attaches handlers.
 */
async function pagedList<T>(box: HTMLElement, opts: { fetchPage: (offset: number) => Promise<{ rows: T[]; hasMore: boolean; total?: number }>;
  renderRows: (rows: T[]) => string; wrap: (inner: string) => string; body: string; empty: string; wire?: (all: T[]) => void }): Promise<void> {
  const rows: T[] = [];
  const page = await opts.fetchPage(0);
  rows.push(...page.rows);
  if (!rows.length) { box.innerHTML = `<p class="empty">${opts.empty}</p>`; return; }
  box.innerHTML = opts.wrap(opts.renderRows(rows)) + `<p class="muted small center" data-count></p><button class="secondary block hidden" data-more>${t('list.more')}</button>`;
  const more = $<HTMLButtonElement>('[data-more]', box);
  const count = $('[data-count]', box);
  const update = (p: { hasMore: boolean; total?: number }) => {
    more.classList.toggle('hidden', !p.hasMore);
    count.textContent = p.total !== undefined ? t('list.count', { shown: rows.length, total: p.total }) : '';
  };
  update(page);
  opts.wire?.(rows);
  more.onclick = (e) => busy(btn(e), async () => {
    const next = await opts.fetchPage(rows.length);
    rows.push(...next.rows);
    $(opts.body, box).insertAdjacentHTML('beforeend', opts.renderRows(next.rows));
    update(next); opts.wire?.(rows);
  });
}

// Edit a person's name and phone number, or delete their account (admin).
function editUserDialog(u: { id: string; name: string; phone: string }, done: () => void): void {
  openModal(`<div class="row between"><h2>${t('admin.editUser')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <label for="uName">${t('admin.colName')}</label><input id="uName" value="${esc(u.name)}">
    <label for="uPhone">${t('admin.colPhone')}</label>${phoneField('uPhone', { value: u.phone })}
    <p class="muted small">${t('admin.phoneChangeHint')}</p>
    <div class="row"><button class="secondary grow" data-close>${t('cancel')}</button><button class="grow" id="uSave">${t('save')}</button></div>`, (sheet) => {
    $('#uSave', sheet).onclick = (e) => busy(btn(e), async () => {
      await api('PATCH', `/api/admin/users/${u.id}`, { name: val('#uName', sheet), phone: readPhone('uPhone', sheet) });
      closeModal(); toast(t('saved')); done();
    });
  });
}
async function deleteUser(u: { id: string; name: string }, done: () => void): Promise<void> {
  if (!(await confirmDialog(t('admin.deleteUserConfirm', { name: esc(u.name) }), t('admin.delete'), true))) return;
  try { await api('DELETE', `/api/admin/users/${u.id}`); toast(t('admin.userDeleted', { name: u.name })); done(); }
  catch (err) { toast(errText(err)); }
}
const userActions = (u: { id: string; active: number }, opts: { locked?: boolean; kind: string }): string => opts.locked ? '' :
  `<div class="actions"><button class="link" data-uedit="${u.id}">${t('admin.edit')}</button><button class="link ${u.active ? 'danger' : ''}" data-${opts.kind}="${u.id}" data-active="${u.active}">${u.active ? t('admin.removeAccess') : t('admin.restoreAccess')}</button><button class="link danger" data-udel="${u.id}">${t('admin.delete')}</button></div>`;
function wireUserActions(root: HTMLElement, list: { id: string; name: string; phone: string }[], done: () => void): void {
  $$('[data-uedit]', root).forEach((b) => (b.onclick = () => editUserDialog(list.find((x) => x.id === b.dataset.uedit)!, done)));
  $$('[data-udel]', root).forEach((b) => (b.onclick = () => deleteUser(list.find((x) => x.id === b.dataset.udel)!, done)));
}

const ADMIN: Record<AdminTab, (el: HTMLElement) => Promise<void>> = {
  async overview(el) {
    // Only the bills that need a decision, however many bills there are in total.
    const [ov, { bills: review }, { bills: stuck }] = await Promise.all([
      api<{ paidUsd: number; feesUsd: number; stoppedUsd: number; avgRisk: number }>('GET', '/api/admin/overview'),
      api<{ bills: Bill[] }>('GET', '/api/bills?status=review&limit=100'),
      api<{ bills: Bill[] }>('GET', '/api/bills?status=payout_failed&limit=100'),
    ]);
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${usd(ov.paidUsd)}</b><span>${t('admin.kpi.paid')}</span></div>
        <div class="kpi"><b>${usd(ov.feesUsd)}</b><span>${t('admin.kpi.fees')}</span></div>
        <div class="kpi"><b>${usd(ov.stoppedUsd)}</b><span>${t('admin.kpi.stopped')}</span></div>
        <div class="kpi"><b>${ov.avgRisk}</b><span>${t('admin.kpi.risk')}</span></div>
      </div>
      ${stuck.length ? `<div class="card"><h2>⚠️ ${t('admin.payoutFailed')}</h2>${stuck.map((b) => billCard(b, { actions: `<button class="small" data-retry="${b.id}">${t('admin.retryPayout')}</button>` })).join('')}</div>` : ''}
      <div class="card"><h2>${t('admin.reviewQueue')}</h2><p class="muted small">${t('admin.reviewHint')}</p>
        ${review.length ? review.map((b) => billCard(b, { showReasons: true, showExpected: true, actions: `<div class="row"><button class="grow small" data-approve="${b.id}">${t('admin.approve')}</button><button class="grow small danger" data-reject="${b.id}">${t('clinic.reject')}</button></div>` })).join('') : `<p class="empty">${t('admin.queueEmpty')}</p>`}
      </div>`;
    wireDetails(el);
    $$('[data-approve]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('POST', `/api/bills/${b.dataset.approve}/review`, { approve: true }); renderAdmin(); })));
    $$('[data-reject]', el).forEach((b) => (b.onclick = async () => {
      const why = await rejectDialog(REVIEW_REASONS);
      if (!why) return;
      try { await api('POST', `/api/bills/${b.dataset.reject}/review`, { approve: false, ...why }); renderAdmin(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
    }));
    $$('[data-retry]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('POST', `/api/bills/${b.dataset.retry}/retry-payout`, {}); renderAdmin(); })));
  },
  async bills(el) {
    el.innerHTML = `<div class="card"><div class="grid2">
        <input id="bQ" type="search" placeholder="${t('admin.searchBills')}" aria-label="${t('admin.searchBills')}">
        <select id="bStatus" aria-label="${t('status')}"><option value="">${t('admin.allStatuses')}</option>${BILL_STATUSES.map((st) => `<option value="${st}">${t('status.' + st)}</option>`).join('')}</select>
      </div><div id="bList" class="scroll"><p class="center"><span class="spinner"></span></p></div></div>`;
    const row = (b: Bill) => `<tr><td><button class="link" data-detail="${b.id}">${esc(b.ref)}</button></td><td>${esc(b.patientName)}</td><td>${esc(b.clinic?.name || '')}</td><td class="num">${usd(b.totalUsd)}</td><td>${riskPill(b.risk)}</td><td class="small">${t('status.' + b.status)}</td></tr>`;
    const load = () => pagedList<Bill>($('#bList', el), {
      fetchPage: async (offset) => {
        const r = await api<{ bills: Bill[]; hasMore: boolean; total: number }>('GET', `/api/bills?offset=${offset}&q=${encodeURIComponent(val('#bQ', el))}&status=${val('#bStatus', el)}`);
        return { rows: r.bills, hasMore: r.hasMore, total: r.total };
      },
      wrap: (inner) => `<table><thead><tr><th>${t('ref')}</th><th>${t('family.patient')}</th><th>${t('family.clinic')}</th><th class="num">${t('total')}</th><th>${t('risk')}</th><th>${t('status')}</th></tr></thead><tbody>${inner}</tbody></table>`,
      body: 'tbody', renderRows: (rows) => rows.map(row).join(''), empty: t('admin.noBills'),
      wire: () => $$<HTMLButtonElement>('button[data-detail]', el).forEach((b) => (b.onclick = () => showBill(b.dataset.detail!))),
    }).catch((e) => toast(errText(e)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    $('#bQ', el).oninput = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    $('#bStatus', el).onchange = load;
    await load();
  },
  async clinics(el) {
    const payoutLabel = (m: string) => ({ bank: t('pay.bankAccount'), mpesa: 'M-Pesa', orange: 'Orange Money', airtel: 'Airtel Money' } as Record<string, string>)[m] || m;
    const { clinics } = await api<{ clinics: AdminClinic[] }>('GET', '/api/admin/clinics');
    el.innerHTML = `
      <div class="card scroll"><h2>${t('admin.network')}</h2><table><thead><tr><th>${t('family.clinic')}</th><th>${t('admin.whatsapp')}</th><th>${t('admin.payoutAccount')}</th><th class="num">${t('admin.trust')}</th></tr></thead><tbody>
        ${clinics.map((c) => `<tr class="${c.active ? '' : 'inactive'}"><td><b>${esc(c.name)}</b>${c.active ? '' : ` <span class="pill high">${t('admin.inactive')}</span>`}<div class="muted small">${t('cat.' + c.category)} · ${esc(c.commune)}, ${esc(c.city)}</div>
          <div class="actions"><button class="link" data-edit="${c.id}">${t('admin.edit')}</button><button class="link" data-toggle="${c.id}" data-active="${c.active}">${c.active ? t('admin.deactivate') : t('admin.activate')}</button><button class="link danger" data-delete="${c.id}">${t('admin.delete')}</button></div></td><td class="small">${esc(c.whatsapp_phone)}</td><td class="small">${esc(payoutLabel(c.payout_method))} · ${esc(c.payout_account)}${c.flexpay_merchant ? `<div><span class="pill low">FlexPay ${esc(c.flexpay_merchant)}</span></div>` : c.payout_phone ? `<div class="muted">${t('admin.payoutPhone')}: ${esc(c.payout_phone)}</div>` : ''}</td><td class="num"><span class="pill ${c.trust >= 80 ? 'low' : c.trust >= 65 ? 'med' : 'high'}">${c.trust}</span></td></tr>`).join('')}
      </tbody></table></div>
      <div class="card"><h2>${t('admin.addClinic')}</h2>
        <div class="grid2">
          <div><label>${t('admin.clinicName')}</label><input id="cName"></div>
          <div><label>${t('admin.category')}</label><select id="cCat">${CATEGORIES.map((k) => `<option value="${k}" ${k === 'clinic' ? 'selected' : ''}>${t('cat.' + k)}</option>`).join('')}</select></div>
          <div><label>${t('admin.commune')}</label><input id="cCommune" list="communeList" autocomplete="off"></div>
          <div><label>${t('admin.city')}</label><input id="cCity" value="Kinshasa"></div>
          <div><label>${t('admin.whatsapp')}</label>${phoneField('cWa')}</div>
          <div><label>${t('admin.payoutMethod')}</label><select id="cMethod"><option value="bank">${t('pay.bankAccount')}</option><option value="mpesa">M-Pesa</option><option value="orange">Orange Money</option><option value="airtel">Airtel Money</option></select></div>
          <div><label>${t('admin.payoutAccount')}</label><input id="cAcct"></div>
          <div><label>${t('admin.flexpayMerchant')}</label><input id="cFlex" placeholder="${t('admin.optional')}"></div>
          <div><label>${t('admin.payoutPhone')}</label>${phoneField('cPayPhone', { placeholder: t('admin.optional') })}</div>
        </div>
        <p class="muted small">${t('admin.flexpayHint')}</p>
        <button class="block" id="addClinic">${t('admin.addClinic')}</button>
      </div>`;
    $$('[data-toggle]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('PATCH', `/api/admin/clinics/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }); renderAdmin(); })));
    // Edit a hospital: every detail, including its FlexPay merchant code and mobile-money payout number.
    const methods = [['bank', t('pay.bankAccount')], ['mpesa', 'M-Pesa'], ['orange', 'Orange Money'], ['airtel', 'Airtel Money']];
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
      const c = clinics.find((x) => x.id === b.dataset.edit)!;
      openModal(`<div class="row between"><h2>${t('admin.editClinic')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
        <label for="eName">${t('admin.clinicName')}</label><input id="eName" value="${esc(c.name)}">
        <label for="eCat">${t('admin.category')}</label><select id="eCat">${CATEGORIES.map((k) => `<option value="${k}" ${k === c.category ? 'selected' : ''}>${t('cat.' + k)}</option>`).join('')}</select>
        <div class="grid2">
          <div><label for="eCommune">${t('admin.commune')}</label><input id="eCommune" list="communeList" autocomplete="off" value="${esc(c.commune)}"></div>
          <div><label for="eCity">${t('admin.city')}</label><input id="eCity" value="${esc(c.city)}"></div>
        </div>
        <label for="eWa">${t('admin.whatsapp')}</label>${phoneField('eWa', { value: c.whatsapp_phone })}
        <div class="grid2">
          <div><label for="eMethod">${t('admin.payoutMethod')}</label><select id="eMethod">${methods.map(([v, l]) => `<option value="${v}" ${v === c.payout_method ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label for="eAcct">${t('admin.payoutAccount')}</label><input id="eAcct" value="${esc(c.payout_account)}"></div>
        </div>
        <p class="muted small">${t('admin.flexpayHint')}</p>
        <div class="grid2">
          <div><label for="eFlex">${t('admin.flexpayMerchant')}</label><input id="eFlex" value="${esc(c.flexpay_merchant)}" placeholder="${t('admin.optional')}"></div>
          <div><label for="ePayPhone">${t('admin.payoutPhone')}</label>${phoneField('ePayPhone', { value: c.payout_phone, placeholder: t('admin.optional') })}</div>
        </div>
        <div class="row"><button class="secondary grow" data-close>${t('cancel')}</button><button class="grow" id="eSave">${t('save')}</button></div>`, (sheet) => {
        $('#eSave', sheet).onclick = (e) => busy(btn(e), async () => {
          await api('PATCH', `/api/admin/clinics/${c.id}`, {
            name: val('#eName', sheet), category: val('#eCat', sheet), commune: val('#eCommune', sheet), city: val('#eCity', sheet),
            whatsappPhone: readPhone('eWa', sheet), payoutMethod: val('#eMethod', sheet), payoutAccount: val('#eAcct', sheet),
            flexpayMerchant: val('#eFlex', sheet), payoutPhone: readPhone('ePayPhone', sheet),
          });
          closeModal(); toast(t('saved')); renderAdmin();
        });
      });
    }));
    $$('[data-delete]', el).forEach((b) => (b.onclick = async () => {
      const c = clinics.find((x) => x.id === b.dataset.delete)!;
      if (!(await confirmDialog(t('admin.deleteConfirm', { name: esc(c.name) }), t('admin.delete'), true))) return;
      try { await api('DELETE', `/api/admin/clinics/${c.id}`); toast(t('admin.deleted')); renderAdmin(); }
      catch (err) { toast(errText(err)); }
    }));
    $('#addClinic', el).onclick = (e) => busy(btn(e), async () => {
      await api('POST', '/api/admin/clinics', { name: val('#cName'), commune: val('#cCommune'), city: val('#cCity'), whatsappPhone: readPhone('cWa'), payoutMethod: val('#cMethod'), payoutAccount: val('#cAcct'), category: val('#cCat'), flexpayMerchant: val('#cFlex'), payoutPhone: readPhone('cPayPhone') });
      toast(t('saved')); renderAdmin();
    });
  },
  async users(el) {
    type AdminUser = { id: string; phone: string; name: string; role: 'admin' | 'clinic'; active: number; clinic: string | null };
    const [{ users, owner }, { clinics }] = await Promise.all([
      api<{ users: AdminUser[]; owner: string | null }>('GET', '/api/admin/users'),
      api<{ clinics: AdminClinic[] }>('GET', '/api/admin/clinics'),
    ]);
    const row = (u: AdminUser): string => {
      const mine = u.id === me().id; const isOwner = !!owner && u.phone === owner;
      const tag = mine ? ` <span class="pill low">${t('admin.you')}</span>` : isOwner ? ` <span class="pill low">${t('admin.owner')}</span>` : '';
      const action = userActions(u, { locked: mine || isOwner, kind: 'access' });
      return `<tr class="${u.active ? '' : 'inactive'}"><td><b>${esc(u.name)}</b>${tag}${u.active ? '' : ` <span class="pill high">${t('admin.inactive')}</span>`}${action}</td>
        <td class="small" data-label="${t('admin.colPhone')}">${esc(u.phone)}</td><td class="small" data-label="${t('admin.role')}">${u.role === 'admin' ? t('admin.roleAdmin') : esc(u.clinic || t('admin.roleClinic'))}</td></tr>`;
    };
    const table = (list: AdminUser[]) => list.length ? `<div class="scroll"><table class="cards"><thead><tr><th>${t('admin.colName')}</th><th>${t('admin.colPhone')}</th><th>${t('admin.role')}</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>` : `<p class="empty">${t('admin.noUsers')}</p>`;
    el.innerHTML = `
      <div class="card"><div class="row between"><h2>${t('admin.customers')}</h2><span class="muted small" id="custCounts"></span></div>
        <p class="muted small">${t('admin.customersHint')}</p>
        <input id="custQ" type="search" placeholder="${t('admin.searchCustomers')}" aria-label="${t('admin.searchCustomers')}">
        <div class="row filters"><button class="secondary small on" data-ckind="">${t('admin.all')}</button><button class="secondary small" data-ckind="payer">${t('admin.payers')}</button><button class="secondary small" data-ckind="family">${t('admin.families')}</button></div>
        <div id="custList"><p class="center"><span class="spinner"></span></p></div>
      </div>
      <div id="teamBox"><div class="card"><h2>${t('admin.admins')}</h2>${table(users.filter((u) => u.role === 'admin'))}</div>
      <div class="card"><h2>${t('admin.staff')}</h2>${table(users.filter((u) => u.role === 'clinic'))}</div></div>
      <div class="card"><h2>${t('admin.addUser')}</h2><p class="muted small">${t('admin.addStaffHint')}</p>
        <div class="grid2">
          <div><label for="sName">${t('admin.colName')}</label><input id="sName"></div>
          <div><label for="sPhone">${t('admin.colPhone')}</label>${phoneField('sPhone')}</div>
          <div><label for="sRole">${t('admin.role')}</label><select id="sRole"><option value="clinic">${t('admin.roleClinic')}</option><option value="admin">${t('admin.roleAdmin')}</option></select></div>
          <div id="sClinicBox"><label for="sClinic">${t('family.clinic')}</label><select id="sClinic">${clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <p class="muted small">${t('phone.hint')}</p>
        <button class="block" id="addStaff">${t('admin.addUser')}</button>
      </div>`;
    // Payers and families: searchable list.
    type Customer = { id: string; name: string; phone: string; role: 'payer' | 'family'; active: number; created_at: string; last_login: string | null; linked: string | null; bills: number; paid_usd: number };
    let kind = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const day = (d: string | null) => d ? new Date(d).toLocaleDateString(state.lang === 'en' ? 'en-US' : 'fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const custRow = (c: Customer) => `<tr class="${c.active ? '' : 'inactive'}"><td><b>${esc(c.name)}</b> <span class="pill ${c.role === 'payer' ? 'low' : 'med'}">${t(c.role === 'payer' ? 'admin.payer' : 'admin.family')}</span>${c.active ? '' : ` <span class="pill high">${t('admin.inactive')}</span>`}
            <div class="muted small">${t('admin.joined', { date: day(c.created_at) })} · ${t('admin.lastLogin', { date: day(c.last_login) })}</div>
            ${userActions(c, { kind: 'caccess' })}</td>
          <td class="small" data-label="${t('admin.colPhone')}">${esc(c.phone)}</td><td class="small" data-label="${t('admin.linkedTo')}">${esc(c.linked || '—')}</td><td class="num" data-label="${t('admin.colBills')}">${c.bills}</td><td class="num" data-label="${t('admin.colPaid')}">${usd(c.paid_usd)}</td></tr>`;
    const loadCustomers = (): Promise<void> => pagedList<Customer>($('#custList', el), {
      fetchPage: async (offset) => {
        const r = await api<{ customers: Customer[]; counts: { payers: number; families: number }; total: number; hasMore: boolean }>('GET',
          `/api/admin/customers?offset=${offset}&kind=${kind}&q=${encodeURIComponent(val('#custQ', el))}`);
        $('#custCounts', el).textContent = t('admin.customerCounts', { payers: r.counts.payers, families: r.counts.families });
        return { rows: r.customers, hasMore: r.hasMore, total: r.total };
      },
      wrap: (inner) => `<div class="scroll"><table class="cards"><thead><tr><th>${t('admin.colName')}</th><th>${t('admin.colPhone')}</th><th>${t('admin.linkedTo')}</th><th class="num">${t('admin.colBills')}</th><th class="num">${t('admin.colPaid')}</th></tr></thead><tbody>${inner}</tbody></table></div>`,
      body: 'tbody', renderRows: (rows) => rows.map(custRow).join(''), empty: t('admin.noUsers'),
      wire: (list) => {
        $$('[data-caccess]', $('#custList', el)).forEach((b) => (b.onclick = async () => {
          const c = list.find((x) => x.id === b.dataset.caccess)!;
          const removing = b.dataset.active === '1';
          if (removing && !(await confirmDialog(t('admin.removeAccessConfirm', { name: esc(c.name) }), t('admin.removeAccess'), true))) return;
          try { await api('PATCH', `/api/admin/users/${c.id}`, { active: !removing }); toast(t('saved')); await loadCustomers(); }
          catch (err) { toast(errText(err)); }
        }));
        wireUserActions($('#custList', el), list, () => { loadCustomers().catch((e) => toast(errText(e))); });
      },
    });
    $('#custQ', el).oninput = () => { clearTimeout(timer); timer = setTimeout(() => { loadCustomers().catch((e) => toast(errText(e))); }, 300); };
    $$<HTMLButtonElement>('[data-ckind]', el).forEach((b) => (b.onclick = () => {
      kind = b.dataset.ckind || ''; $$('[data-ckind]', el).forEach((x) => x.classList.toggle('on', x === b));
      loadCustomers().catch((e) => toast(errText(e)));
    }));
    await loadCustomers();
    $<HTMLSelectElement>('#sRole', el).onchange = () => $('#sClinicBox', el).classList.toggle('hidden', val('#sRole', el) === 'admin');
    $('#addStaff', el).onclick = (e) => busy(btn(e), async () => {
      const role = val('#sRole', el);
      await api('POST', '/api/admin/users', { name: val('#sName', el), phone: readPhone('sPhone', el), role, clinicId: role === 'clinic' ? val('#sClinic', el) : undefined });
      toast(t('saved')); renderAdmin();
    });
    $$('[data-access]', $('#teamBox', el)).forEach((b) => (b.onclick = async () => {
      const u = users.find((x) => x.id === b.dataset.access)!;
      const removing = b.dataset.active === '1';
      if (removing && !(await confirmDialog(t('admin.removeAccessConfirm', { name: esc(u.name) }), t('admin.removeAccess'), true))) return;
      try { await api('PATCH', `/api/admin/users/${u.id}`, { active: !removing }); toast(t('saved')); renderAdmin(); }
      catch (err) { toast(errText(err)); }
    }));
    wireUserActions($('#teamBox', el), users, () => renderAdmin());
  },
  async prices(el) {
    type PriceRow = { id: string; name: string; keywords: string[]; usd: number; category: Category | null; clinic_id: string | null };
    const [{ prices }, { clinics }] = await Promise.all([
      api<{ prices: PriceRow[] }>('GET', '/api/admin/prices'),
      api<{ clinics: AdminClinic[] }>('GET', '/api/admin/clinics'),
    ]);
    // Which list is being edited: '' = all facilities, 'cat:<type>' or 'clinic:<id>'.
    let scope = state.priceScope;
    let rows: { id?: string; name: string; keywords: string; usd: number | string }[] = [];
    const load = (): void => {
      const [kind, key] = scope.split(':');
      rows = prices.filter((p) => kind === 'clinic' ? p.clinic_id === key : kind === 'cat' ? p.category === key && !p.clinic_id : !p.category && !p.clinic_id)
        .map((p) => ({ ...p, keywords: p.keywords.join(', ') }));
    };
    const count = (f: (p: PriceRow) => boolean) => { const n = prices.filter(f).length; return n ? ` (${n})` : ''; };
    const draw = (): void => {
      el.innerHTML = `<div class="card"><h2>${t('admin.prices')}</h2><p class="muted small">${t('admin.pricesHint')}</p>
        <label for="pScope">${t('admin.priceScope')}</label>
        <select id="pScope">
          <option value="">${t('admin.scopeAll')}${count((p) => !p.category && !p.clinic_id)}</option>
          <optgroup label="${t('admin.category')}">${CATEGORIES.map((k) => `<option value="cat:${k}" ${scope === 'cat:' + k ? 'selected' : ''}>${t('cat.' + k)}${count((p) => p.category === k)}</option>`).join('')}</optgroup>
          <optgroup label="${t('admin.network')}">${clinics.map((c) => `<option value="clinic:${c.id}" ${scope === 'clinic:' + c.id ? 'selected' : ''}>${esc(c.name)}${count((p) => p.clinic_id === c.id)}</option>`).join('')}</optgroup>
        </select>
        <p class="muted small">${t('admin.scopeHint')}</p>
        ${scope && !rows.length ? `<p class="empty">${t('admin.scopeEmpty')}</p><button class="secondary small" id="copyGeneral">${t('admin.copyGeneral')}</button>` : ''}
        <div class="scroll"><table><thead><tr><th>${t('item')}</th><th>${t('admin.keywords')}</th><th class="num">USD</th><th></th></tr></thead><tbody>
        ${rows.map((p, n) => `<tr><td><input data-n="${n}" data-k="name" value="${esc(p.name)}"></td><td><input data-n="${n}" data-k="keywords" value="${esc(p.keywords)}"></td><td class="num"><input class="price" data-n="${n}" data-k="usd" type="number" step="0.01" value="${p.usd}"></td><td><button class="link" data-rm="${n}">✕</button></td></tr>`).join('')}
        </tbody></table></div><button class="link" id="addP">+ ${t('family.addItem')}</button>
        <button class="block" id="saveP">${t('save')}</button></div>`;
      $$<HTMLInputElement>('input[data-n]', el).forEach((i) => (i.oninput = () => { rows[Number(i.dataset.n)][i.dataset.k as 'name' | 'keywords' | 'usd'] = i.value; }));
      $$('[data-rm]', el).forEach((b) => (b.onclick = () => { rows.splice(Number(b.dataset.rm), 1); draw(); }));
      $('#addP', el).onclick = () => { rows.push({ name: '', keywords: '', usd: '' }); draw(); };
      $<HTMLSelectElement>('#pScope', el).onchange = (e) => { scope = state.priceScope = (e.target as HTMLSelectElement).value; load(); draw(); };
      document.querySelector<HTMLButtonElement>('#copyGeneral')?.addEventListener('click', () => {
        rows = prices.filter((p) => !p.category && !p.clinic_id).map((p) => ({ name: p.name, keywords: p.keywords.join(', '), usd: p.usd }));
        draw();
      });
      $('#saveP', el).onclick = (e) => busy(btn(e), async () => {
        const [kind, key] = scope.split(':');
        await api('PUT', '/api/admin/prices', { prices: rows.filter((r) => r.name), scope: kind === 'clinic' ? { clinicId: key } : kind === 'cat' ? { category: key } : undefined });
        toast(t('saved')); renderAdmin();
      });
    };
    load();
    draw();
  },
  async settings(el) {
    const { settings: s, partner, messaging, ai } = await api<{
      settings: { cdfPerUsd: number; priceFlagRatio: number; feePct: number; feeMinUsd: number; reviewAboveUsd: number };
      partner: string; messaging: string; ai: boolean;
    }>('GET', '/api/admin/settings');
    el.innerHTML = `<div class="card"><h2>${t('admin.tab.settings')}</h2>
      <p class="muted small">${t('admin.integrations', { partner, messaging, ai: ai ? t('on') : t('off') })}</p>
      <div class="grid2">
        <div><label>${t('admin.rate')}</label><input id="sRate" type="number" value="${s.cdfPerUsd}"></div>
        <div><label>${t('admin.ratio')}</label><input id="sRatio" type="number" step="0.1" value="${s.priceFlagRatio}"></div>
        <div><label>${t('admin.feePct')}</label><input id="sFee" type="number" step="0.5" value="${s.feePct * 100}"></div>
        <div><label>${t('admin.feeMin')}</label><input id="sFeeMin" type="number" step="0.5" value="${s.feeMinUsd}"></div>
        <div><label>${t('admin.reviewAbove')}</label><input id="sReview" type="number" value="${s.reviewAboveUsd}"></div>
      </div>
      <button class="block" id="saveS">${t('save')}</button></div>`;
    $('#saveS', el).onclick = (e) => busy(btn(e), async () => {
      await api('PUT', '/api/admin/settings', { cdfPerUsd: +val('#sRate'), priceFlagRatio: +val('#sRatio'), feePct: +val('#sFee') / 100, feeMinUsd: +val('#sFeeMin'), reviewAboveUsd: +val('#sReview') });
      toast(t('saved'));
    });
  },
  async support(el) {
    type Row = { id: string; ref: string; status: string; channel: string; subject: string; reason: string; name: string; phone: string | null; role: string | null;
      signedIn: boolean; billRef: string | null; last: string | null; lastFrom: string | null; messages: number; updatedAt: string };
    const filters = ['open', 'waiting', 'bot', 'resolved', 'all'];
    const filter = sessionStorage.getItem('supportFilter') || 'open';
    el.innerHTML = `<div class="card"><h2>${t('admin.tab.support')}</h2><p class="muted small">${t('support.hint')}</p>
      <div class="row filters" id="sFilters">${filters.map((f) => `<button class="secondary small ${f === filter ? 'on' : ''}" data-sf="${f}">${t('support.filter.' + f)} <span data-sc="${f}"></span></button>`).join('')}</div>
      <div id="sList"></div></div>`;
    $$('[data-sf]', el).forEach((b) => (b.onclick = () => { sessionStorage.setItem('supportFilter', b.dataset.sf!); renderAdmin(); }));
    // The list keeps itself up to date while it's on screen (not while a conversation is open).
    clearInterval(supportListPoll);
    supportListPoll = setInterval(() => {
      if (!document.body.contains(el) || state.adminTab !== 'support') { clearInterval(supportListPoll); return; }
      if (!document.hidden && document.getElementById('modal')!.classList.contains('hidden')) renderAdmin();
    }, 30000);
    await pagedList<Row>($('#sList', el), {
      fetchPage: async (offset) => {
        const r = await api<{ tickets: Row[]; hasMore: boolean; counts: Record<string, number> }>('GET', `/api/admin/support?status=${filter}&offset=${offset}`);
        filters.forEach((f) => { const n = f === 'all' ? Object.values(r.counts).reduce((a, b) => a + b, 0) : r.counts[f] || 0; const c = el.querySelector(`[data-sc="${f}"]`); if (c) c.textContent = n ? `(${n})` : ''; });
        return { rows: r.tickets, hasMore: r.hasMore };
      },
      wrap: (inner) => `<div data-rows>${inner}</div>`, body: '[data-rows]', empty: t('support.empty'),
      renderRows: (rows) => rows.map((x) => `<button class="ticket" data-ticket="${x.id}">
        <span class="row between"><b>${esc(x.name || x.phone || '—')}</b><span class="pill ${x.status === 'open' ? 'high' : x.status === 'waiting' ? 'med' : x.status === 'resolved' ? 'low' : 'st'}">${t('support.filter.' + x.status)}</span></span>
        <span class="muted small">${esc(x.ref)} · ${esc(x.phone || '')} · ${x.signedIn ? t('support.role.' + x.role) : t('support.guest')}${x.channel === 'whatsapp' ? ' · WhatsApp' : ''}${x.billRef ? ' · ' + t('ref') + ' ' + esc(x.billRef) : ''} · ${fmtDate(x.updatedAt)}</span>
        <span class="small">“${esc((x.last || x.subject).slice(0, 140))}”${x.lastFrom === 'agent' ? ` <span class="muted">· ${t('support.youAnswered')}</span>` : ''}</span></button>`).join(''),
      wire: () => $$('[data-ticket]', el).forEach((b) => (b.onclick = () => supportThread(b.dataset.ticket!))),
    });
  },
  async messages(el) {
    type Msg = { to_phone: string; channel: string; status: string; created_at: string; body: string; payload: string | null; error?: string | null };
    el.innerHTML = `<div class="card"><h2>${t('admin.tab.messages')}</h2><p class="muted small">${t('admin.messagesHint')}</p><div id="mList"></div></div>`;
    await pagedList<Msg>($('#mList', el), {
      fetchPage: async (offset) => { const r = await api<{ messages: Msg[]; hasMore: boolean }>('GET', `/api/admin/messages?offset=${offset}`); return { rows: r.messages, hasMore: r.hasMore }; },
      wrap: (inner) => `<div data-rows>${inner}</div>`, body: '[data-rows]', empty: '—',
      renderRows: (rows) => rows.map((m) => `<div class="bill"><div class="row between"><b class="small">→ ${esc(m.to_phone)}</b><span class="muted small">${esc(m.channel)} · ${esc(m.status)} · ${fmtDate(m.created_at)}</span></div><p class="small">${esc(m.body).replace(/\n/g, '<br>')}</p>${m.error ? `<p class="notice">${esc(m.error)}</p>` : ''}${((JSON.parse(m.payload || '{}').buttons || []) as { title: string }[]).map((b) => `<span class="pill st">${esc(b.title)}</span> `).join('')}</div>`).join(''),
    });
  },
  async payments(el) {
    type Pay = { bill_ref: string; kind: string; amount_usd: number; partner: string; partner_ref: string | null; status: string; failure_reason: string | null };
    el.innerHTML = `<div class="card scroll"><h2>${t('admin.tab.payments')}</h2><div id="pList"></div></div>`;
    await pagedList<Pay>($('#pList', el), {
      fetchPage: async (offset) => { const r = await api<{ payments: Pay[]; hasMore: boolean }>('GET', `/api/admin/payments?offset=${offset}`); return { rows: r.payments, hasMore: r.hasMore }; },
      wrap: (inner) => `<table><thead><tr><th>${t('ref')}</th><th>${t('admin.kind')}</th><th class="num">USD</th><th>${t('admin.partnerRef')}</th><th>${t('status')}</th></tr></thead><tbody>${inner}</tbody></table>`,
      body: 'tbody', empty: '—',
      renderRows: (rows) => rows.map((p) => `<tr><td>${esc(p.bill_ref)}</td><td>${esc(p.kind)}</td><td class="num">${usd(p.amount_usd)}</td><td class="small">${esc(p.partner)} · ${esc(p.partner_ref || '')}</td><td><span class="pill ${p.status === 'succeeded' ? 'low' : p.status === 'failed' ? 'high' : 'med'}">${esc(p.status)}</span>${p.failure_reason ? `<div class="muted small">${esc(p.failure_reason)}</div>` : ''}</td></tr>`).join(''),
    });
  },
};


let agentPoll: ReturnType<typeof setInterval> | undefined;
let supportListPoll: ReturnType<typeof setInterval> | undefined;
// One conversation, for the team: the person, the bill, the messages, and a reply box.
async function supportThread(id: string): Promise<void> {
  type Thread = { ticket: { id: string; ref: string; status: string; channel: string; reason: string; assignedTo: string | null };
    contact: { name: string; phone: string | null; signedIn: boolean; account: { id: string; name: string; role: string } | null };
    bill: { id: string; ref: string; status: string; patientName: string } | null;
    messages: (ChatMsg & { agent?: string })[] };
  const d = await api<Thread>('GET', `/api/admin/support/${id}`);
  const c = d.contact;
  const threadHtml = (msgs: Thread['messages']) => msgs.map((m) => m.from === 'system' ? `<p class="chat-note">${esc(m.body)}</p>` :
    `<div class="msg ${m.from === 'user' ? 'them' : m.from === 'agent' ? 'me' : 'bot'}"><span class="who">${m.from === 'user' ? esc(c.name || t('support.guest')) : m.from === 'agent' ? esc(m.agent || t('chat.agent')) : t('chat.bot')}</span>${esc(m.body).replace(/\n/g, '<br>')}<time>${chatTime(m.at)}</time></div>`).join('');
  const wa = (c.phone || '').replace(/\D/g, '');
  openModal(`<div class="row between"><h2>${esc(c.name || c.phone || '—')}</h2><button class="link" data-close aria-label="${t('close')}">✕</button></div>
    <p class="muted small">${esc(d.ticket.ref)} · ${esc(c.phone || '')}${wa ? ` · <a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a> · <a href="tel:${esc(c.phone)}">${t('support.call')}</a>` : ''}</p>
    <p class="small">${c.signedIn ? t('support.signedIn', { role: t('support.role.' + c.account?.role) }) : c.account ? t('support.guestKnown', { name: esc(c.account.name), role: t('support.role.' + c.account.role) }) : c.phone ? t('support.guestUnknown') : t('support.noPhone')}</p>
    ${d.bill ? `<p class="small">${t('ref')} <button class="link" data-sbill="${d.bill.id}">${esc(d.bill.ref)}</button> · ${esc(d.bill.patientName)} · <span class="pill st">${t('status.' + d.bill.status)}</span></p>` : ''}
    ${d.ticket.reason ? (() => { const [code, ...more] = d.ticket.reason.split(': '); const label = t('support.why.' + code) !== 'support.why.' + code ? t('support.why.' + code) : code;
      return `<p class="muted small">${t('support.reason')} : ${esc(label)}${more.length ? `<br><code class="small">${esc(more.join(': '))}</code>` : ''}</p>`; })() : ''}
    <div class="chat agent-view">${threadHtml(d.messages)}</div>
    <label for="sReply">${t('support.reply')}</label>
    <textarea id="sReply" rows="3" maxlength="2000"></textarea>
    <p class="muted small">${t('support.replyHint')}</p>
    <div class="row"><button class="grow" id="sSend">${t('chat.send')}</button>
    ${d.ticket.status === 'resolved' ? `<button class="secondary grow" id="sReopen">${t('support.reopen')}</button>` : `<button class="secondary grow" id="sResolve">✓ ${t('support.resolve')}</button>`}</div>`, (sheet) => {
    const box = $('.chat', sheet); box.scrollTop = box.scrollHeight;
    let count = d.messages.length;
    // New messages from the person (or the assistant) appear by themselves while this is open.
    const refresh = async (force = false) => {
      const x = await api<Thread>('GET', `/api/admin/support/${id}`);
      if (!force && x.messages.length === count) return;
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.innerHTML = threadHtml(x.messages);
      if (force || atBottom || x.messages.length > count) box.scrollTop = box.scrollHeight;
      count = x.messages.length;
    };
    clearInterval(agentPoll);
    agentPoll = setInterval(() => {
      if (!document.body.contains(box)) { clearInterval(agentPoll); return; }
      if (!document.hidden) refresh().catch(() => { /* try again later */ });
    }, 5000);
    sheet.querySelector<HTMLButtonElement>('[data-sbill]')?.addEventListener('click', () => showBill(d.bill!.id));
    $('#sSend', sheet).onclick = (e) => busy(btn(e), async () => {
      const text = val('#sReply', sheet).trim();
      if (!text) return;
      await api('POST', `/api/admin/support/${id}/messages`, { text });
      $<HTMLTextAreaElement>('#sReply', sheet).value = '';
      toast(t('support.sent'));
      await refresh(true);
      renderAdmin();
    });
    $<HTMLTextAreaElement>('#sReply', sheet).onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $<HTMLButtonElement>('#sSend', sheet).click(); } };
    const setStatus = (status: string) => (e: Event) => busy(btn(e), async () => { await api('PATCH', `/api/admin/support/${id}`, { status }); closeModal(); renderAdmin(); });
    sheet.querySelector<HTMLButtonElement>('#sResolve')?.addEventListener('click', setStatus('resolved'));
    sheet.querySelector<HTMLButtonElement>('#sReopen')?.addEventListener('click', setStatus('open'));
  });
}

// ---------- routing ----------
function route(): void {
  if (!state.me) return renderLogin();
  const r = { payer: renderPayer, family: renderFamily, clinic: renderClinic, admin: renderAdmin }[state.me.role];
  Promise.resolve(r()).catch((e) => {
    reportUnexpected(e);
    app.innerHTML = `<div class="card"><p>${esc(errText(e))}</p><button id="retry">${t('retry')}</button></div>`;
    $('#retry').onclick = route;
  });
}

document.getElementById('langSel')!.addEventListener('change', async (e) => {
  await loadLang((e.target as HTMLSelectElement).value as Lang);
  if (document.getElementById('installBar')) { hideInstallBar(); showInstallBar(); } // in the new language
  if (state.me) api('PATCH', '/api/me', { lang: state.lang }).catch(() => {});
  route();
});
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  state.me = null; setUser(null); markSupportUnread(false); document.getElementById('logoutBtn')!.classList.add('hidden'); route();
});

// An invitation link (/?invite=CODE) is kept until the relative has logged in, then accepted.
const INVITE_KEY = 'pendingInvite';
const INVITE_AS_KEY = 'pendingInviteAs';
function pendingInvite(): string | null { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } }
/** Which side the invitation link is for: 'family' (sent from abroad) or 'payer' (sent from the DRC). */
function pendingInviteAs(): 'payer' | 'family' { try { return sessionStorage.getItem(INVITE_AS_KEY) === 'payer' ? 'payer' : 'family'; } catch { return 'family'; } }
function setPendingInvite(code: string | null, as: string | null = null): void {
  try {
    if (code) { sessionStorage.setItem(INVITE_KEY, code); sessionStorage.setItem(INVITE_AS_KEY, as === 'payer' ? 'payer' : 'family'); }
    else { sessionStorage.removeItem(INVITE_KEY); sessionStorage.removeItem(INVITE_AS_KEY); }
  } catch {}
}
async function acceptPendingInvite(): Promise<void> {
  const code = pendingInvite();
  if (!code || (state.me?.role !== 'family' && state.me?.role !== 'payer')) return;
  setPendingInvite(null);
  try {
    const r = await api<{ linkedWith: { name: string } }>('POST', '/api/invites/accept', { code });
    toast(t('family.linked', { name: r.linkedWith.name }));
  } catch (e) { toast(errText(e)); }
}

(async function init() {
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite && /^[A-Za-z0-9]{6}$/.test(invite)) {
    setPendingInvite(invite.toUpperCase(), new URLSearchParams(location.search).get('as'));
    history.replaceState(null, '', location.pathname); // don't leave the code in the address bar
  }
  let lang = 'fr';
  try { lang = localStorage.getItem('lang') || ''; } catch {}
  if (!LANGS.includes(lang as Lang)) lang = LANGS.find((l) => (navigator.language || '').startsWith(l)) || 'fr';
  await loadLang(lang as Lang);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const { user } = await api<{ user: Me | null }>('GET', '/api/me');
    if (user) { await signedIn(user); return; }
  } catch {}
  route();
  appReady = true;
  checkSupportUnread();
  setTimeout(showInstallBar, 1500); // iPhone and in-app browsers never send beforeinstallprompt
})();
