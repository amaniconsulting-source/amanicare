// AmaniCare server: API + static PWA. Build with `npm run build`, run with `npm start`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';
import { config } from './config.js';
import { openDb } from './db.js';
import { migrate } from './migrate.js';
import { router } from './api.js';
import './support.js'; // adds the customer-service routes
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
const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

/** Pages opened on the old Render address (*.onrender.com) move to the official one in BASE_URL, so
 *  links, logins and cookies all live on one domain. Only that address: behind Render and Cloudflare
 *  the Host header of the custom domain can differ, and redirecting anything else can loop (seen on
 *  22 Nov 2026). www → root is done by Render itself. Only GET/HEAD pages: the API and webhooks answer
 *  on every address, so nothing breaks while Meta and payment partners are moved to the new domain. */
function canonicalRedirect(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const canonical = hostOf(config.baseUrl);
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!config.canonicalRedirect || !canonical || !host || host === canonical) return false;
  if (!host.endsWith('.onrender.com') || canonical.endsWith('.onrender.com')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return false;
  res.writeHead(301, { location: originOf(config.baseUrl) + url.pathname + url.search, 'cache-control': 'no-cache' });
  res.end();
  return true;
}

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
  return meta('app-version', BUILD_ID) + meta('support-email', config.supportEmail) + meta('support-whatsapp', config.supportWhatsApp) + sentryHead();
}
function sentryHead(): string {
  const s = browserSentry();
  if (!s) return '';
  const sri = config.sentry.browserBundleSri;
  return meta('sentry-dsn', s.dsn) + meta('sentry-environment', config.sentry.environment) + meta('sentry-release', config.sentry.release)
    + `<script id="sentry-sdk" async src="${esc(config.sentry.browserBundleUrl)}"${sri ? ` integrity="${esc(sri)}"` : ''} crossorigin="anonymous"></script>`;
}

// Caching: files are downloaded again only when a new version is deployed.
// - App code, styles and translations asked for with this deploy's ?v=… never change under that address:
//   the browser keeps them (immutable) and a reload doesn't even ask the server.
// - The page itself and anything without ?v= is re-checked on each load: a tiny "304 Not Modified" when
//   nothing was deployed, the new file when something was. The page names the deploy's files, so a new
//   deploy changes those addresses and the browser fetches the new code once.
// - Images: kept for a day.
function cachePolicy(ext: string, req?: IncomingMessage): string {
  if (['.png', '.svg', '.ico', '.jpg', '.webp'].includes(ext)) return 'public, max-age=86400';
  const v = new URL(req?.url || '/', 'http://x').searchParams.get('v');
  if (v && v === BUILD_ID && ['.js', '.css', '.json'].includes(ext)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

async function serveStatic(path: string, res: ServerResponse, req?: IncomingMessage): Promise<boolean> {
  if (path === '/favicon.ico') path = '/icon-192.png';
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  for (const dir of STATIC_DIRS) {
    const file = join(dir, rel);
    if (!file.startsWith(dir + sep)) return false;
    let data: Buffer;
    try { data = await readFile(file); } catch { continue; }
    const ext = extname(file);
    // Pages ask for the app code and styles of this exact deploy (?v=…), so a reload can never mix in an old copy.
    const body = ext === '.html' ? Buffer.from(data.toString('utf8').replace('<!--sentry-->', headExtras())
      .replace('href="/styles.css"', `href="/styles.css?v=${BUILD_ID}"`).replace('src="/app.js"', `src="/app.js?v=${BUILD_ID}"`)) : data;
    // App code, styles and translations must always match each other after a deploy, so the browser
    // checks for a newer copy on every load (a quick "304 Not Modified" when nothing changed).
    // Only images are kept for a day without checking.
    const etag = '"' + createHash('sha1').update(body).digest('base64url') + '"';
    const headers = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': cachePolicy(ext, req),
      etag, ...securityHeaders(),
    };
    if (req?.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, headers);
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

// This deploy's identity: Render's commit id, or else a fingerprint of the app files.
const BUILD_ID = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || (() => {
  const h = createHash('sha1');
  for (const f of ['app.js', 'styles.css']) for (const dir of STATIC_DIRS) { try { h.update(readFileSync(join(dir, f))); break; } catch { /* next dir */ } }
  return h.digest('base64url').slice(0, 12);
})();

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('x-app-version', BUILD_ID); // lets open pages notice a new deploy
    res.setHeader('x-content-type-options', 'nosniff');
    // HTTPS only, for a year, once in production (browsers then never try plain http).
    if (config.production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (canonicalRedirect(req, res, url)) return;
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
      if (req.method === 'GET' && (await serveStatic(url.pathname, res, req))) return;
      if (req.method === 'GET' && !extname(url.pathname) && (await serveStatic('/index.html', res, req))) return;
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
