// Minimal HTTP helpers and router (no framework dependencies).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserRow } from './types.js';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
export const bad = (code: string, msg?: string) => new HttpError(400, code, msg);
export const forbidden = () => new HttpError(403, 'forbidden');
export const notFound = () => new HttpError(404, 'not_found');

export type Body = Record<string, unknown>;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  raw: Buffer;
  body: Body;
  user: UserRow | null;
}
/** Logged-in context (after requireRole). */
export type AuthCtx = Ctx & { user: UserRow };
// Method-style signature so a handler placed after requireRole() can declare ctx as AuthCtx.
export type Handler = { bivarianceHack(ctx: Ctx): unknown }['bivarianceHack'];

export function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

interface Route { method: string; re: RegExp; keys: string[]; handlers: Handler[] }

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, ...handlers: Handler[]): void {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p: string, ...h: Handler[]) { this.add('GET', p, ...h); }
  post(p: string, ...h: Handler[]) { this.add('POST', p, ...h); }
  put(p: string, ...h: Handler[]) { this.add('PUT', p, ...h); }
  patch(p: string, ...h: Handler[]) { this.add('PATCH', p, ...h); }
  delete(p: string, ...h: Handler[]) { this.add('DELETE', p, ...h); }
  match(method: string | undefined, path: string): { handlers: Handler[]; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

// Small validation helpers
export const str = (v: unknown, { min = 0, max = 200, name = 'field' } = {}): string => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw bad('invalid_' + name);
  return s;
};
export const num = (v: unknown, { min = 0, max = 1e9, name = 'number' } = {}): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad('invalid_' + name);
  return n;
};
export const oneOf = <T extends string>(v: unknown, list: readonly T[], name = 'value'): T => {
  if (!list.includes(v as T)) throw bad('invalid_' + name);
  return v as T;
};
/**
 * Phone numbers are stored in international format (+243812345678). People often forget the country code,
 * so the common Congolese ways of writing a number are completed automatically:
 *   0812345678 / 812345678 / 243812345678 / 00243… / +243 0812… → +243812345678
 * Any other number without a country code is refused with phone_country_code.
 */
export const normalizePhone = (v: unknown): string => {
  let p = String(v ?? '').trim().replace(/[\s\-().\/]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    if (/^0[89]\d{8}$/.test(p)) p = '+243' + p.slice(1);
    else if (/^[89]\d{8}$/.test(p)) p = '+243' + p;
    else if (/^243[89]\d{8}$/.test(p)) p = '+' + p;
    else if (p) throw bad('phone_country_code', 'Add the country code, e.g. +243 81 234 5678 or +1 214 555 0100');
  }
  p = p.replace(/^\+2430(\d{9})$/, '+243$1'); // "+243 0812…": the trunk 0 is not dialled after +243
  return p;
};

export const phone = (v: unknown): string => {
  const p = normalizePhone(v);
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw bad('invalid_phone', 'Use international format, e.g. +243 81 234 5678');
  if (p.startsWith('+243') && p.length !== 13) throw bad('invalid_phone', 'A DRC number has 9 digits after +243');
  return p;
};

/** Page of a list: ?offset=…&limit=… (limit 50 by default, at most 100). */
export function pageOf(url: URL, def = 50): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || def)));
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
  return { limit, offset };
}
