// AmaniCare server: API + static PWA. Build with `npm run build`, run with `npm start`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';
import { config } from './config.js';
import { openDb } from './db.js';
import { migrate } from './migrate.js';
import { router } from './api.js';
import { readBody, sendJson, parseCookies, HttpError, type Body, type Ctx } from './http.js';
import { currentUser } from './auth.js';
import { seedIfEmpty } from './seed.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Compiled browser code (tsc output) first, then the static assets (HTML, CSS, i18n, icons).
const STATIC_DIRS = [join(ROOT, 'dist', 'public'), join(ROOT, 'public')];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };

/** Browser Sentry is on when a DSN is set (and SENTRY_BROWSER isn't 0). */
function browserSentry() {
  const s = config.sentry;
  if (!s.dsn || !s.browser) return null;
  return { dsn: s.dsn, ingest: originOf(s.dsn), cdn: originOf(s.browserBundleUrl) };
}

function securityHeaders(): Record<string, string> {
  const s = browserSentry();
  const csp = [
    "default-src 'self'",
    s ? `script-src 'self' ${s.cdn}` : '',
    "img-src 'self' blob: data:",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `connect-src 'self'${s ? ' ' + s.ingest : ''}`,
    "frame-ancestors 'none'",
  ].filter(Boolean).join('; ');
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': csp,
  };
}

const meta = (name: string, value: string) => (value ? `<meta name="${name}" content="${esc(value)}">` : '');

// HTML pages carry a <!--sentry--> marker; it becomes the support contact (for Help) and,
// when Sentry is on, the Sentry config and SDK tag.
function headExtras(): string {
  return meta('support-email', config.supportEmail) + meta('support-whatsapp', config.supportWhatsApp) + sentryHead();
}
function sentryHead(): string {
  const s = browserSentry();
  if (!s) return '';
  const sri = config.sentry.browserBundleSri;
  return meta('sentry-dsn', s.dsn) + meta('sentry-environment', config.sentry.environment) + meta('sentry-release', config.sentry.release)
    + `<script id="sentry-sdk" async src="${esc(config.sentry.browserBundleUrl)}"${sri ? ` integrity="${esc(sri)}"` : ''} crossorigin="anonymous"></script>`;
}

async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
  if (path === '/favicon.ico') path = '/icon-192.png';
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  for (const dir of STATIC_DIRS) {
    const file = join(dir, rel);
    if (!file.startsWith(dir + sep)) return false;
    let data: Buffer;
    try { data = await readFile(file); } catch { continue; }
    const ext = extname(file);
    const body = ext === '.html' ? data.toString('utf8').replace('<!--sentry-->', headExtras()) : data;
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': rel.endsWith('sw.js') || ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...securityHeaders(),
    });
    res.end(body);
    return true;
  }
  return false;
}

// With SITE_PASSWORD set, everything except these paths asks for the password first.
// sw.js and the manifest are fetched by the browser without the password; neither holds private data.
const PUBLIC_PATHS = new Set(['/healthz', '/privacy.html', '/styles.css', '/icon.svg', '/icon-192.png', '/favicon.ico', '/sw.js', '/manifest.webmanifest']);
const isPublic = (path: string) => PUBLIC_PATHS.has(path) || path.startsWith('/api/webhooks/');
const SITE_COOKIE = 'amc_site';
const SITE_LOGIN_PATH = '/__site-login';
const sha = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));
// The cookie holds a value derived from the password: changing SITE_PASSWORD logs everyone out.
const siteToken = () => createHmac('sha256', config.sitePassword).update('amanicare-site-access').digest('base64url');

function siteAccessOk(req: IncomingMessage): boolean {
  const cookie = parseCookies(req)[SITE_COOKIE];
  if (cookie && same(cookie, siteToken())) return true;
  // Also accepts the browser's own password box / https://user:password@host (scripts, curl).
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return same(decoded.slice(decoded.indexOf(':') + 1), config.sitePassword);
}

/** Only same-site paths, so the form can't be used to send people elsewhere. */
const safeNext = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/');

function sitePasswordPage(res: ServerResponse, next: string, wrong = false): void {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders() });
  res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0f6b5c">
<title>AmaniCare</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/styles.css"></head><body>
<header class="bar"><div class="brand"><img src="/icon.svg" alt="" width="28" height="28"><span>AmaniCare</span></div></header>
<main><form class="card" method="post" action="${SITE_LOGIN_PATH}">
<h1>Site de test</h1>
<p class="muted">AmaniCare est en test. Entrez le mot de passe qui vous a été donné.<br>
<span lang="en">AmaniCare is being tested. Enter the password you were given.</span></p>
${wrong ? '<p class="notice">Mot de passe incorrect. · <span lang="en">Wrong password.</span></p>' : ''}
<label for="pw">Mot de passe · <span lang="en">Password</span></label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${esc(next)}">
<button class="block" type="submit">Continuer · <span lang="en">Continue</span></button>
</form>
<p class="muted small center"><a href="/privacy.html">Politique de confidentialité · Privacy policy</a></p></main>
</body></html>`);
}

async function handleSiteLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = new URLSearchParams((await readBody(req, 10_000)).toString('utf8'));
  const next = safeNext(form.get('next'));
  if (!same(form.get('password') || '', config.sitePassword)) return sitePasswordPage(res, next, true);
  res.writeHead(303, {
    location: next,
    'set-cookie': `${SITE_COOKIE}=${siteToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${config.production ? '; Secure' : ''}`,
    'cache-control': 'no-store',
  });
  res.end();
}

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (config.sitePassword) {
        if (url.pathname === SITE_LOGIN_PATH && req.method === 'POST') return await handleSiteLogin(req, res);
        if (!isPublic(url.pathname) && !siteAccessOk(req)) {
          if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'site_password_required' });
          // Keeps the full address (e.g. an invitation link ?invite=…) to come back to after the password.
          return sitePasswordPage(res, url.pathname + url.search);
        }
      }
      if (url.pathname.startsWith('/api/')) {
        const match = router.match(req.method, url.pathname);
        if (!match) throw new HttpError(404, 'not_found');
        // Basic CSRF protection: state-changing requests from browsers must be same-origin JSON.
        if (req.method !== 'GET' && !url.pathname.startsWith('/api/webhooks/')) {
          if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'json_required');
        }
        const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
        let body: Body = {};
        if (raw.length && !url.pathname.startsWith('/api/webhooks/')) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
          if (!body || typeof body !== 'object') body = {};
        }
        const user = await currentUser(req);
        if (user) Sentry.setUser({ id: user.id }); // id only: no phone numbers or names in Sentry
        Sentry.setTag('role', user?.role ?? 'anonymous');
        const ctx: Ctx = { req, res, url, params: match.params, raw, body, user };
        let result: unknown;
        for (const h of match.handlers) result = await h(ctx);
        if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
        return;
      }
      if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
      if (req.method === 'GET' && !extname(url.pathname) && (await serveStatic('/index.html', res))) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500) Sentry.captureException(e, { tags: { code: e.code } });
        return sendJson(res, e.status, { error: e.code, message: e.message !== e.code ? e.message : undefined });
      }
      console.error(e);
      Sentry.captureException(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  openDb();
  try {
    await migrate();
    await seedIfEmpty();
  } catch (e) {
    console.error('[startup]', (e as Error).message);
    Sentry.captureException(e);
    await Sentry.flush(2000);
    process.exit(1);
  }
  createApp().listen(config.port, () => {
    console.log(`AmaniCare running on ${config.baseUrl}`);
    console.log(`Payments: ${config.paymentPartner} · Messaging: ${config.messaging} · AI: ${config.anthropicKey ? 'on' : 'off (manual entry)'} · Sentry: ${config.sentry.dsn ? 'on' : 'off'}`);
    if (config.otpDev) console.log('OTP_DEV is on: login codes are shown in the app. Turn it off in production.');
  });
}
