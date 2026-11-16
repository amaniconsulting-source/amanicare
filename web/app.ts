// AmaniCare PWA. TypeScript compiled by tsc to a plain ES module (no bundler).
import { initMonitoring, report, setUser } from './monitoring.js';

initMonitoring();

type Lang = 'fr' | 'en' | 'ln' | 'sw';
type Role = 'payer' | 'family' | 'clinic' | 'admin';
type AdminTab = 'overview' | 'bills' | 'clinics' | 'prices' | 'settings' | 'messages' | 'payments';
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
  family: { id: string; name: string } | null;
  risk: Risk; aiUsed: boolean; edited: boolean;
  events: { at: string; type: string; note: string }[];
  payout?: { ref: string | null; status: string; account?: string };
}
interface Payer { id: string; name: string; relation: string }
type Category = 'health_centre' | 'clinic' | 'hospital' | 'diagnostic' | 'pharmacy';
const CATEGORIES: Category[] = ['health_centre', 'clinic', 'hospital', 'diagnostic', 'pharmacy'];
interface Clinic { id: string; name: string; commune: string; city: string; category: Category }
interface AdminClinic extends Clinic { whatsapp_phone: string; payout_method: string; payout_account: string; trust: number; active: number }
interface AiRead {
  clinic_name: string; bill_number: string; date: string; patient_name: string; currency: 'USD' | 'CDF';
  items: { description: string; qty: number; unit_price: number }[]; total: number; tamper_flags: string[]; confidence: number;
}

const LANGS: Lang[] = ['fr', 'en', 'ln', 'sw'];
const app = document.getElementById('app')!;
const state: { me: Me | null; lang: Lang; dict: Record<string, string>; fallback: Record<string, string>; adminTab: AdminTab; priceScope: string } =
  { me: null, lang: 'fr', dict: {}, fallback: {}, adminTab: 'overview', priceScope: '' };
const me = (): Me => state.me!;

// ---------- i18n ----------
async function loadLang(lang: Lang): Promise<void> {
  const get = (l: string) => fetch(`/i18n/${l}.json`).then((r) => r.json() as Promise<Record<string, string>>);
  state.fallback = Object.keys(state.fallback).length ? state.fallback : await get('fr');
  state.dict = lang === 'fr' ? state.fallback : await get(lang).catch(() => ({}));
  state.lang = lang;
  document.documentElement.lang = lang;
  (document.getElementById('langSel') as HTMLSelectElement).value = lang;
  document.getElementById('logoutBtn')!.textContent = t('logout');
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
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(state.lang === 'en' ? 'en-US' : 'fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
};
function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
const val = (sel: string, root: ParentNode = document): string => $<HTMLInputElement | HTMLSelectElement>(sel, root).value;
const btn = (e: Event) => e.currentTarget as HTMLButtonElement;

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
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error, res.status, data.message);
  return data as T;
}
const errText = (e: unknown): string => {
  const err = e as ApiError;
  return t('err.' + err.code) !== 'err.' + err.code ? t('err.' + err.code) : (err.detail || t('err.generic'));
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
  return `<div class="steps" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${s < 0 ? 'x' : i <= s ? 'on' : ''}"></i>`).join('')}</div>`;
}
const riskPill = (r: Risk | undefined): string => r?.level ? `<span class="pill ${r.level}">${t('risk.' + r.level)}${r.score !== undefined ? ' · ' + r.score : ''}</span>` : '';
const reasonText = (r: Reason): string => t('reason.' + r.code, Object.fromEntries(Object.entries(r.params || {}).map(([k, v]) => [k, typeof v === 'number' && /usd/i.test(k) ? usd(v) : String(v)])));

function billCard(b: Bill, { actions = '', showReasons = false, showExpected = false } = {}): string {
  return `<div class="bill" data-bill="${b.id}">
    <div class="top">
      <div><b>${esc(b.patientName)}</b><div class="muted small">${esc(b.clinic?.name || '')} · ${fmtDate(b.createdAt)}</div></div>
      <div class="center"><div class="amount">${usd(b.totalUsd)}</div>${b.currency === 'CDF' ? `<div class="muted small">${cdf(b.total)}</div>` : ''}</div>
    </div>
    <div class="row">${riskPill(b.risk)}<span class="pill st">${t('status.' + b.status)}</span>${b.aiUsed ? `<span class="pill st">${t('aiRead')}</span>` : ''}</div>
    ${steps(b.status)}
    ${showExpected && b.expectedUsd !== undefined ? `<div class="muted small">${t('expectedCost', { amount: usd(b.expectedUsd) })}</div>` : ''}
    ${showReasons && b.risk?.reasons?.filter((r) => r.points).length ? `<ul class="reasons">${b.risk.reasons.filter((r) => r.points).map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>` : ''}
    ${actions}
    <button class="link" data-detail="${b.id}">${t('details')}</button>
  </div>`;
}

function wireDetails(root: ParentNode): void {
  $$('[data-detail]', root).forEach((el) => el.addEventListener('click', () => showBill(el.dataset.detail!)));
}

async function showBill(id: string): Promise<void> {
  const { bill: b } = await api<{ bill: Bill }>('GET', `/api/bills/${id}`);
  const items = b.items.map((i) => `<tr><td>${esc(i.d)}</td><td class="num">${i.q}</td><td class="num">${b.currency === 'CDF' ? cdf(i.p) : usd(i.p)}</td></tr>`).join('');
  openModal(`
    <div class="row between"><h2>${esc(b.patientName)}</h2><button class="link" data-close>✕</button></div>
    <p class="muted small">${esc(b.clinic?.name || '')} · ${t('billNo')} ${esc(b.billNumber || '—')} · ${t('ref')} ${esc(b.ref)}</p>
    <div class="row">${riskPill(b.risk)}<span class="pill st">${t('status.' + b.status)}</span></div>
    <div class="scroll"><table><thead><tr><th>${t('item')}</th><th class="num">${t('qty')}</th><th class="num">${t('unitPrice')}</th></tr></thead><tbody>${items}</tbody></table></div>
    <p class="row between"><b>${t('total')}</b><b>${b.currency === 'CDF' ? cdf(b.total) + ' · ' : ''}${usd(b.totalUsd)}</b></p>
    ${b.expectedUsd !== undefined ? `<p class="muted small">${t('expectedCost', { amount: usd(b.expectedUsd) })}</p>` : ''}
    ${b.risk?.reasons?.length ? `<ul class="reasons">${b.risk.reasons.map((r) => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>` : ''}
    ${b.payout ? `<p class="notice info">${t('payoutSent', { ref: esc(b.payout.ref), account: esc(b.payout.account || '') })}</p>` : ''}
    <ul class="timeline">${b.events.map((e) => `<li>${fmtDate(e.at)} · ${esc(t('event.' + e.type))}</li>`).join('')}</ul>
    ${b.hasPhoto ? `<img class="photo-full" src="/api/bills/${b.id}/photo" alt="${t('billPhoto')}">` : ''}
  `);
}

// ---------- login ----------
function renderLogin(): void {
  const s: { phone: string; code: string; step: 'phone' | 'code' | 'profile'; role: string; name: string; devCode?: string } =
    { phone: '', code: '', step: 'phone', role: '', name: '' };
  const draw = (): void => {
    app.innerHTML = `
      <div class="card">
        <h1>${t('login.title')}</h1>
        <p class="muted">${t('login.subtitle')}</p>
        ${s.step === 'phone' ? `
          <label for="ph">${t('login.phone')}</label>
          <input id="ph" type="tel" inputmode="tel" autocomplete="tel" placeholder="+243 81 234 5678" value="${esc(s.phone)}">
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
      <p class="muted small center">${t('login.footer')}</p>`;

    if (s.step === 'phone') {
      $('#sendCode').onclick = (e) => busy(btn(e), async () => {
        s.phone = val('#ph').replace(/[\s\-().]/g, '');
        if (s.phone && !s.phone.startsWith('+')) s.phone = '+' + s.phone;
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
  if (user.lang && user.lang !== state.lang) await loadLang(user.lang);
  document.getElementById('logoutBtn')!.classList.remove('hidden');
  route();
}

// ---------- payer ----------
async function renderPayer(): Promise<void> {
  app.innerHTML = `<p class="center"><span class="spinner"></span></p>`;
  const [{ bills }, { members }] = await Promise.all([
    api<{ bills: Bill[] }>('GET', '/api/bills'),
    api<{ members: { id: string; name: string; phone: string; relation: string }[] }>('GET', '/api/family'),
  ]);
  const todo = bills.filter((b) => ['awaiting_payer', 'payment_failed'].includes(b.status));
  const moving = bills.filter((b) => ['review', 'awaiting_clinic', 'payment_pending', 'paying_out'].includes(b.status));
  const done = bills.filter((b) => ['paid', 'rejected', 'declined', 'payout_failed'].includes(b.status));
  app.innerHTML = `
    <h1>${t('hello', { name: esc(me().name) })}</h1>
    <p class="muted">${t('payer.subtitle')}</p>
    <div class="card"><h2>${t('payer.toApprove')}</h2>
      ${todo.length ? todo.map((b) => billCard(b, { showReasons: true, showExpected: true, actions: `
        ${b.status === 'payment_failed' ? `<p class="notice">${t('payer.paymentFailed')}</p>` : ''}
        <div class="row"><button class="grow" data-pay="${b.id}">${t('payer.pay', { amount: usd(b.totalUsd + b.feeUsd) })}</button><button class="secondary small" data-decline="${b.id}">${t('payer.decline')}</button></div>
        <p class="muted small">${t('payer.feeNote', { fee: usd(b.feeUsd) })}</p>` })).join('') : `<p class="empty">${t('payer.nothingToApprove')}</p>`}
    </div>
    ${moving.length ? `<div class="card"><h2>${t('inProgress')}</h2>${moving.map((b) => billCard(b, { showReasons: true })).join('')}</div>` : ''}
    <div class="card"><div class="row between"><h2>${t('payer.family')}</h2><button class="small secondary" id="invite">${t('payer.invite')}</button></div>
      ${members.length ? `<table><tbody>${members.map((m) => `<tr><td><b>${esc(m.name)}</b><div class="muted small">${esc(m.relation)}</div></td><td class="num muted small">${esc(m.phone)}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${t('payer.noFamily')}</p>`}
    </div>
    <div class="card"><h2>${t('history')}</h2>${done.length ? done.map((b) => billCard(b)).join('') : `<p class="empty">${t('noHistory')}</p>`}</div>`;
  wireDetails(app);
  $('#invite').onclick = inviteFlow;
  $$('[data-pay]').forEach((b) => (b.onclick = (e) => busy(btn(e), async () => {
    const r = await api<{ checkoutUrl: string | null }>('POST', `/api/bills/${b.dataset.pay}/pay`, {});
    if (r.checkoutUrl) location.href = r.checkoutUrl; else renderPayer();
  })));
  $$('[data-decline]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('payer.declineConfirm'), t('payer.decline'), true))) return;
    try { await api('POST', `/api/bills/${b.dataset.decline}/decline`, {}); renderPayer(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
}

function inviteFlow(): void {
  openModal(`
    <div class="row between"><h2>${t('invite.title')}</h2><button class="link" data-close>✕</button></div>
    <p class="muted">${t('invite.subtitle')}</p>
    <label for="rel">${t('invite.relation')}</label>
    <input id="rel" placeholder="${t('invite.relationPh')}">
    <label for="invPhone">${t('invite.phone')}</label>
    <input id="invPhone" type="tel" inputmode="tel" placeholder="+243 81 234 5678">
    <p class="muted small">${t('invite.phoneHint')}</p>
    <button class="block" id="mk">${t('invite.create')}</button>
    <div id="out"></div>`, (s) => {
    $('#mk', s).onclick = (e) => busy(btn(e), async () => {
      let phone = val('#invPhone', s).replace(/[\s\-().]/g, '');
      if (phone && !phone.startsWith('+')) phone = '+' + phone;
      const r = await api<{ code: string; phone: string | null; sent: boolean }>('POST', '/api/invites', { relation: val('#rel', s), phone: phone || undefined });
      const msg = t(r.phone ? 'invite.messagePhone' : 'invite.message', { name: me().name, code: r.code, url: location.origin });
      // wa.me opens WhatsApp (app or web) with the message ready; with a number it opens that chat directly.
      const wa = `https://wa.me/${r.phone ? r.phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(msg)}`;
      $('#out', s).innerHTML = `<div class="code">${r.code}</div>
        <p class="muted small">${r.phone ? t('invite.expiresPhone', { phone: esc(r.phone) }) : t('invite.expires')}</p>
        ${r.sent ? `<p class="notice info">${t('invite.sent', { phone: esc(r.phone || '') })}</p>` : ''}
        <p class="small">${esc(msg)}</p>
        <a class="btn block" id="wa" href="${esc(wa)}" target="_blank" rel="noopener">${t(r.sent ? 'invite.whatsappAgain' : 'invite.whatsapp')}</a>
        <button class="secondary block" id="cp">${t('invite.copy')}</button>`;
      $('#cp', s).onclick = async () => { try { await navigator.clipboard.writeText(msg); toast(t('copied')); } catch { toast(t('copyFailed')); } };
    });
  });
}

// ---------- family ----------
async function renderFamily(): Promise<void> {
  app.innerHTML = `<p class="center"><span class="spinner"></span></p>`;
  const [{ bills }, { payers }] = await Promise.all([api<{ bills: Bill[] }>('GET', '/api/bills'), api<{ payers: Payer[] }>('GET', '/api/payers')]);
  app.innerHTML = `
    <h1>${t('hello', { name: esc(me().name) })}</h1>
    ${payers.length ? `
      <button class="block" id="newBill">📷 ${t('family.newBill')}</button>
      <p class="muted small center">${t('family.supportedBy', { names: esc(payers.map((p) => p.name).join(', ')) })}</p>` : ''}
    <div class="card ${payers.length ? 'hidden' : ''}" id="linkCard">
      <h2>${t('family.linkTitle')}</h2><p class="muted">${t('family.linkSubtitle')}</p>
      <input id="code" maxlength="6" placeholder="ABC123" autocapitalize="characters">
      <button class="block" id="link">${t('family.link')}</button>
    </div>
    <div class="card"><h2>${t('family.myBills')}</h2>${bills.length ? bills.map((b) => billCard(b)).join('') : `<p class="empty">${t('family.noBills')}</p>`}</div>
    ${payers.length ? `<button class="link" id="addPayer">${t('family.addPayer')}</button>` : ''}`;
  wireDetails(app);
  $('#link').onclick = (e) => busy(btn(e), async () => {
    const r = await api<{ payer: { name: string } }>('POST', '/api/invites/accept', { code: val('#code').trim().toUpperCase() });
    toast(t('family.linked', { name: r.payer.name })); renderFamily();
  });
  if (payers.length) {
    $('#newBill').onclick = () => newBillFlow(payers);
    $('#addPayer').onclick = () => $('#linkCard').classList.remove('hidden');
  }
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

async function newBillFlow(payers: Payer[]): Promise<void> {
  const { clinics } = await api<{ clinics: Clinic[] }>('GET', '/api/clinics');
  const f: { draftId: string | null; ai: AiRead | null; aiAvailable?: boolean; items: ItemDraft[]; photoUrl: string | null } =
    { draftId: null, ai: null, items: [{ d: '', q: 1, p: '' }], photoUrl: null };
  const drawPhoto = (): void => {
    app.innerHTML = `
      <button class="link" id="cancel">← ${t('back')}</button>
      <h1>${t('family.newBill')}</h1>
      <div class="card">
        <label class="photo-drop" for="file"><b>📷 ${t('family.takePhoto')}</b>${t('family.photoHint')}
          <input id="file" type="file" accept="image/*" capture="environment"></label>
        <div id="reading"></div>
      </div>`;
    $('#cancel').onclick = renderFamily;
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
      ${f.ai ? `<p class="notice info">${t('family.aiDone', { pct: Math.round((ai.confidence || 0) * 100) })}</p>` : `<p class="notice">${f.aiAvailable ? t('family.aiFailed') : t('family.aiOff')}</p>`}
      <div class="card">
        <img class="preview" src="${f.photoUrl}" alt="${t('billPhoto')}">
        <label for="clinic">${t('family.clinic')}</label>
        <select id="clinic"><option value="">${t('family.pickClinic')}</option>${clinics.map((c) => `<option value="${c.id}" ${guessClinic?.id === c.id ? 'selected' : ''}>${esc(c.name)} – ${esc(c.commune)} · ${t('cat.' + c.category)}</option>`).join('')}</select>
        <p class="muted small">${t('family.clinicMissing')}</p>
        ${payers.length > 1 ? `<label for="payer">${t('family.whoPays')}</label><select id="payer">${payers.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.relation)})</option>`).join('')}</select>` : ''}
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
      const { bill } = await api<{ bill: Bill }>('POST', '/api/bills', {
        draftId: f.draftId, payerId: document.querySelector<HTMLSelectElement>('#payer')?.value || payers[0].id, clinicId: val('#clinic'),
        patientName: val('#patient').trim(), billNumber: val('#billNo').trim(), billDate: val('#date'),
        currency: val('#cur'), items, total: Number(val('#total')) || undefined,
      });
      app.innerHTML = `<div class="card center"><h1>${bill.status === 'review' ? '🔎' : '✅'}</h1>
        <h2>${bill.status === 'review' ? t('family.sentReview') : t('family.sentClinic')}</h2>
        <p class="muted">${t('family.nextSteps')}</p>${billCard(bill)}<button class="block" id="home">${t('family.done')}</button></div>`;
      wireDetails(app);
      $('#home').onclick = renderFamily;
    });
  };
  drawPhoto();
}

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
    <div class="card"><h2>${t('history')}</h2>${rest.length ? rest.map((b) => billCard(b, { actions: b.payout && b.status === 'paid' ? `<p class="notice info">${t('payoutSent', { ref: esc(b.payout.ref), account: esc(b.payout.account || '') })}</p>` : '' })).join('') : `<p class="empty">${t('noHistory')}</p>`}</div>`;
  wireDetails(app);
  $$('[data-ok]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('clinic.confirmQ'), t('clinic.confirm')))) return;
    try { await api('POST', `/api/bills/${b.dataset.ok}/confirm`, {}); toast(t('clinic.confirmed')); renderClinic(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
  $$('[data-no]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('clinic.rejectQ'), t('clinic.reject'), true))) return;
    try { await api('POST', `/api/bills/${b.dataset.no}/reject`, {}); renderClinic(); } catch (e) { reportUnexpected(e); toast(errText(e)); }
  }));
}

// ---------- admin ----------
const ADMIN_TABS: AdminTab[] = ['overview', 'bills', 'clinics', 'prices', 'settings', 'messages', 'payments'];
async function renderAdmin(): Promise<void> {
  app.innerHTML = `<h1>${t('admin.title')}</h1>
    <nav class="tabs">${ADMIN_TABS.map((k) => `<button data-tab="${k}" class="${state.adminTab === k ? 'on' : ''}">${t('admin.tab.' + k)}</button>`).join('')}</nav>
    <div id="adminBody"><p class="center"><span class="spinner"></span></p></div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { state.adminTab = b.dataset.tab as AdminTab; renderAdmin(); }));
  const body = $('#adminBody');
  try { await ADMIN[state.adminTab](body); } catch (e) { reportUnexpected(e); body.innerHTML = `<p class="notice">${esc(errText(e))}</p>`; }
}

const ADMIN: Record<AdminTab, (el: HTMLElement) => Promise<void>> = {
  async overview(el) {
    const [ov, { bills }] = await Promise.all([
      api<{ paidUsd: number; feesUsd: number; stoppedUsd: number; avgRisk: number }>('GET', '/api/admin/overview'),
      api<{ bills: Bill[] }>('GET', '/api/bills'),
    ]);
    const review = bills.filter((b) => b.status === 'review');
    const stuck = bills.filter((b) => b.status === 'payout_failed');
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
    $$('[data-reject]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('POST', `/api/bills/${b.dataset.reject}/review`, { approve: false }); renderAdmin(); })));
    $$('[data-retry]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('POST', `/api/bills/${b.dataset.retry}/retry-payout`, {}); renderAdmin(); })));
  },
  async bills(el) {
    const { bills } = await api<{ bills: Bill[] }>('GET', '/api/bills');
    el.innerHTML = `<div class="card scroll"><table><thead><tr><th>${t('ref')}</th><th>${t('family.patient')}</th><th>${t('family.clinic')}</th><th class="num">${t('total')}</th><th>${t('risk')}</th><th>${t('status')}</th></tr></thead><tbody>
      ${bills.map((b) => `<tr data-detail="${b.id}"><td><button class="link" data-detail="${b.id}">${esc(b.ref)}</button></td><td>${esc(b.patientName)}</td><td>${esc(b.clinic?.name || '')}</td><td class="num">${usd(b.totalUsd)}</td><td>${riskPill(b.risk)}</td><td class="small">${t('status.' + b.status)}</td></tr>`).join('')}
    </tbody></table></div>`;
    $$('button[data-detail]', el).forEach((b) => b.addEventListener('click', () => showBill(b.dataset.detail!)));
  },
  async clinics(el) {
    const { clinics } = await api<{ clinics: AdminClinic[] }>('GET', '/api/admin/clinics');
    el.innerHTML = `
      <div class="card scroll"><h2>${t('admin.network')}</h2><table><thead><tr><th>${t('family.clinic')}</th><th>${t('admin.whatsapp')}</th><th>${t('admin.payoutAccount')}</th><th class="num">${t('admin.trust')}</th><th></th></tr></thead><tbody>
        ${clinics.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted small">${t('cat.' + c.category)} · ${esc(c.commune)}, ${esc(c.city)}</div></td><td class="small">${esc(c.whatsapp_phone)}</td><td class="small">${esc(c.payout_method)} · ${esc(c.payout_account)}</td><td class="num"><span class="pill ${c.trust >= 80 ? 'low' : c.trust >= 65 ? 'med' : 'high'}">${c.trust}</span></td><td><button class="link" data-toggle="${c.id}" data-active="${c.active}">${c.active ? t('admin.deactivate') : t('admin.activate')}</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="card"><h2>${t('admin.addClinic')}</h2>
        <div class="grid2">
          <div><label>${t('admin.clinicName')}</label><input id="cName"></div>
          <div><label>${t('admin.category')}</label><select id="cCat">${CATEGORIES.map((k) => `<option value="${k}" ${k === 'clinic' ? 'selected' : ''}>${t('cat.' + k)}</option>`).join('')}</select></div>
          <div><label>${t('admin.commune')}</label><input id="cCommune"></div>
          <div><label>${t('admin.city')}</label><input id="cCity" value="Kinshasa"></div>
          <div><label>${t('admin.whatsapp')}</label><input id="cWa" type="tel" placeholder="+243…"></div>
          <div><label>${t('admin.payoutMethod')}</label><select id="cMethod"><option value="bank">Bank</option><option value="mpesa">M-Pesa</option><option value="orange">Orange Money</option><option value="airtel">Airtel Money</option></select></div>
          <div><label>${t('admin.payoutAccount')}</label><input id="cAcct"></div>
        </div>
        <button class="block" id="addClinic">${t('admin.addClinic')}</button>
      </div>
      <div class="card"><h2>${t('admin.addStaff')}</h2><p class="muted small">${t('admin.addStaffHint')}</p>
        <div class="grid2">
          <div><label>${t('login.name')}</label><input id="sName"></div>
          <div><label>${t('login.phone')}</label><input id="sPhone" type="tel" placeholder="+243…"></div>
          <div><label>${t('admin.role')}</label><select id="sRole"><option value="clinic">${t('admin.roleClinic')}</option><option value="admin">${t('admin.roleAdmin')}</option></select></div>
          <div><label>${t('family.clinic')}</label><select id="sClinic">${clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <button class="block" id="addStaff">${t('admin.addStaff')}</button>
      </div>`;
    $$('[data-toggle]', el).forEach((b) => (b.onclick = (e) => busy(btn(e), async () => { await api('PATCH', `/api/admin/clinics/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }); renderAdmin(); })));
    $('#addClinic', el).onclick = (e) => busy(btn(e), async () => {
      await api('POST', '/api/admin/clinics', { name: val('#cName'), commune: val('#cCommune'), city: val('#cCity'), whatsappPhone: val('#cWa').replace(/\s/g, ''), payoutMethod: val('#cMethod'), payoutAccount: val('#cAcct'), category: val('#cCat') });
      toast(t('saved')); renderAdmin();
    });
    $('#addStaff', el).onclick = (e) => busy(btn(e), async () => {
      await api('POST', '/api/admin/users', { name: val('#sName'), phone: val('#sPhone').replace(/\s/g, ''), role: val('#sRole'), clinicId: val('#sClinic') });
      toast(t('saved')); renderAdmin();
    });
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
      <p class="muted small">${t('admin.integrations', { partner, messaging, ai: ai ? 'on' : 'off' })}</p>
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
  async messages(el) {
    const { messages } = await api<{ messages: { to_phone: string; channel: string; status: string; created_at: string; body: string; payload: string | null; error?: string | null }[] }>('GET', '/api/admin/messages');
    el.innerHTML = `<div class="card"><h2>${t('admin.tab.messages')}</h2><p class="muted small">${t('admin.messagesHint')}</p>
      ${messages.length ? messages.map((m) => `<div class="bill"><div class="row between"><b class="small">→ ${esc(m.to_phone)}</b><span class="muted small">${esc(m.channel)} · ${esc(m.status)} · ${fmtDate(m.created_at)}</span></div><p class="small">${esc(m.body).replace(/\n/g, '<br>')}</p>${m.error ? `<p class="notice">${esc(m.error)}</p>` : ''}${((JSON.parse(m.payload || '{}').buttons || []) as { title: string }[]).map((b) => `<span class="pill st">${esc(b.title)}</span> `).join('')}</div>`).join('') : `<p class="empty">—</p>`}</div>`;
  },
  async payments(el) {
    const { payments } = await api<{ payments: { bill_ref: string; kind: string; amount_usd: number; partner: string; partner_ref: string | null; status: string; failure_reason: string | null }[] }>('GET', '/api/admin/payments');
    el.innerHTML = `<div class="card scroll"><h2>${t('admin.tab.payments')}</h2><table><thead><tr><th>${t('ref')}</th><th>${t('admin.kind')}</th><th class="num">USD</th><th>${t('admin.partnerRef')}</th><th>${t('status')}</th></tr></thead><tbody>
      ${payments.map((p) => `<tr><td>${esc(p.bill_ref)}</td><td>${esc(p.kind)}</td><td class="num">${usd(p.amount_usd)}</td><td class="small">${esc(p.partner)} · ${esc(p.partner_ref || '')}</td><td><span class="pill ${p.status === 'succeeded' ? 'low' : p.status === 'failed' ? 'high' : 'med'}">${esc(p.status)}</span>${p.failure_reason ? `<div class="muted small">${esc(p.failure_reason)}</div>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  },
};

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
  if (state.me) api('PATCH', '/api/me', { lang: state.lang }).catch(() => {});
  route();
});
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  state.me = null; setUser(null); document.getElementById('logoutBtn')!.classList.add('hidden'); route();
});

(async function init() {
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
})();
