// Phone-number login with one-time codes, and server-side sessions (hashed tokens).
import { randomBytes, randomInt, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config.js';
import { one, run, audit } from './db.js';
import { HttpError, bad, parseCookies, type Ctx } from './http.js';
import { send, text } from './messaging/index.js';
import type { OtpRow, Role, SessionRow, UserRow } from './types.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const OTP_TTL = 10 * 60 * 1000;
const OTP_MAX_SENDS_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

export async function requestOtp(phone: string, lang = 'fr'): Promise<{ sent: true; devCode?: string }> {
  const existing = await one<OtpRow>('SELECT * FROM otps WHERE phone = $1', phone);
  const t = now();
  let sentCount = 1; let windowStart = t;
  if (existing && t - existing.window_start < 60 * 60 * 1000) {
    if (existing.sent_count >= OTP_MAX_SENDS_PER_HOUR) throw new HttpError(429, 'too_many_codes');
    sentCount = existing.sent_count + 1; windowStart = existing.window_start;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await run(`INSERT INTO otps(phone, code_hash, expires_at, attempts, sent_count, window_start) VALUES($1,$2,$3,0,$4,$5)
       ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0,
       sent_count=excluded.sent_count, window_start=excluded.window_start`,
  phone, sha(phone + ':' + code), t + OTP_TTL, sentCount, windowStart);
  await send({ to: phone, text: text('otp', lang, { code }), kind: 'otp' });
  return config.otpDev ? { sent: true, devCode: code } : { sent: true };
}

export async function verifyOtp(phone: string, code: string, { consume = true } = {}): Promise<void> {
  const row = await one<OtpRow>('SELECT * FROM otps WHERE phone = $1', phone);
  if (!row || row.expires_at < now()) throw bad('code_expired');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts');
  await run('UPDATE otps SET attempts = attempts + 1 WHERE phone = $1', phone);
  const a = Buffer.from(sha(phone + ':' + String(code).trim()));
  const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw bad('wrong_code');
  if (consume) await run('DELETE FROM otps WHERE phone = $1', phone);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1,$2,$3)', sha(token), userId, now() + config.sessionDays * 864e5);
  await audit(userId, 'login');
  return token;
}

export function sessionCookie(token: string, maxAgeSec = config.sessionDays * 86400): string {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${config.production ? '; Secure' : ''}`;
}

export async function destroySession(req: IncomingMessage): Promise<void> {
  const token = parseCookies(req).sid;
  if (token) await run('DELETE FROM sessions WHERE token_hash = $1', sha(token));
}

export async function currentUser(req: IncomingMessage): Promise<UserRow | null> {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = await one<SessionRow>('SELECT * FROM sessions WHERE token_hash = $1', sha(token));
  if (!s || s.expires_at < now()) return null;
  return (await one<UserRow>('SELECT * FROM users WHERE id = $1', s.user_id)) || null;
}

export async function findOrCreateUser(phone: string, { name, role, lang }: { name: string; role?: unknown; lang?: string }):
  Promise<{ user: UserRow; created: boolean }> {
  const existing = await one<UserRow>('SELECT * FROM users WHERE phone = $1', phone);
  if (existing) return { user: existing, created: false };
  // Only payers and families can sign themselves up. Clinic staff are created by an admin;
  // the first admin is whoever logs in with ADMIN_PHONE.
  let r: Role;
  if (config.adminPhone && phone === config.adminPhone) r = 'admin';
  else if (role === 'payer' || role === 'family') r = role;
  else throw bad('role_required');
  if (!name) throw bad('name_required');
  const id = randomUUID();
  await run('INSERT INTO users(id, phone, name, role, lang) VALUES($1,$2,$3,$4,$5)', id, phone, name, r, lang || 'fr');
  await audit(id, 'signup', r);
  const user = (await one<UserRow>('SELECT * FROM users WHERE id = $1', id))!;
  return { user, created: true };
}

export const requireRole = (...roles: Role[]) => (ctx: Ctx): void => {
  if (!ctx.user) throw new HttpError(401, 'login_required');
  if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, 'forbidden');
};
