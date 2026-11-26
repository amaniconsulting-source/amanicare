// Simple in-memory rate limits (one server). They bound abuse and cost (login codes, assistant
// calls, invitation-code guessing); a restart resets them.
import type { IncomingMessage } from 'node:http';
import { HttpError } from './http.js';

const hits = new Map<string, number[]>();

/** Refuses with 429 when `key` was used `max` times within `windowMs`. */
export function limit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((x) => x > now - windowMs);
  if (list.length >= max) throw new HttpError(429, 'too_many_requests');
  list.push(now); hits.set(key, list);
  if (hits.size > 20_000) for (const [k, v] of hits) if (!v.some((x) => x > now - windowMs)) hits.delete(k);
}
export function resetLimits(): void { hits.clear(); }

/** The visitor's address. Behind Cloudflare its own header; else the first X-Forwarded-For entry (Render).
 *  Both can be faked by a client talking to the server directly, so every per-address limit is paired
 *  with an overall limit that faking can't get around. */
export function clientIp(req: IncomingMessage): string {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
