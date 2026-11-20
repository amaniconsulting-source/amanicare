// Sandbox checkout page (only used while PAYMENT_PARTNER=sandbox).
import { initMonitoring, report } from './monitoring.js';

initMonitoring();

const id = new URLSearchParams(location.search).get('p') || '';
const info = document.getElementById('info')!;
const usd = (n: unknown) => '$' + Number(n).toFixed(2);
const buttons = () => document.querySelectorAll<HTMLButtonElement>('button');

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'error');
  return data as T;
}

interface SandboxPayment { id: string; amount_usd: number; status: string; method: string | null; wallet_phone: string | null; ref: string; patient_name: string; clinic: string }
const WALLET_NAMES: Record<string, string> = { mpesa: 'M-Pesa', orange: 'Orange Money', airtel: 'Airtel Money' };
let mobile = false;

async function load(): Promise<void> {
  try {
    const { payment: p } = await call<{ payment: SandboxPayment }>('GET', `/api/sandbox/payments/${encodeURIComponent(id)}`);
    info.innerHTML = '';
    mobile = !!p.method && p.method !== 'card';
    if (mobile) {
      // Mobile money: the partner pushes a request to the wallet phone; this page plays that phone.
      const wallet = WALLET_NAMES[p.method!] || p.method!;
      document.getElementById('title')!.textContent = `${wallet} request`;
      document.getElementById('explain')!.textContent = `In production, ${wallet} sends a payment request to ${p.wallet_phone}, and the payer approves it on that phone with their PIN. This page stands in for the phone.`;
      document.getElementById('cardBox')!.hidden = true;
      document.getElementById('pay')!.textContent = 'Approve on the phone (PIN)';
      document.getElementById('fail')!.textContent = 'Simulate a refusal on the phone';
    }
    const rows: [string, string][] = [['Amount', usd(p.amount_usd)], ['Clinic', p.clinic], ['Patient', p.patient_name], ['Bill', p.ref],
      ['Paid with', mobile ? `${WALLET_NAMES[p.method!] || p.method} · ${p.wallet_phone}` : 'Bank card'], ['Status', p.status]];
    const table = document.createElement('table');
    for (const [k, v] of rows) { const tr = table.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
    info.appendChild(table);
    if (p.status !== 'pending') buttons().forEach((b) => (b.disabled = true));
  } catch { info.textContent = 'Payment not found.'; }
}

async function complete(outcome: 'succeed' | 'fail'): Promise<void> {
  buttons().forEach((b) => (b.disabled = true));
  try { await call('POST', `/api/sandbox/payments/${encodeURIComponent(id)}/complete`, { outcome }); }
  catch (e) { report(e); info.textContent = 'Could not complete: ' + (e as Error).message; return; }
  setTimeout(() => (location.href = '/'), outcome === 'fail' ? 300 : 1800);
  info.textContent = outcome === 'fail' ? (mobile ? 'Payment refused on the phone (sandbox). Returning…' : 'Card declined (sandbox). Returning…') : 'Payment accepted. Paying the hospital… Returning to AmaniCare.';
}

document.getElementById('pay')!.onclick = () => complete('succeed');
document.getElementById('fail')!.onclick = () => complete('fail');
load();
