// Configuration from environment variables (and an optional .env file).
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const pkgVersion = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || ''); }
  catch { return ''; }
})();
const bool = (v: string | undefined, d = false): boolean =>
  v === undefined ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase());

// The browser SDK loads Sentry's official CDN bundle (no bundler in this project). Keep the version
// in step with the @sentry/browser dev dependency (used for types) and update the SRI hash with it:
// https://docs.sentry.io/platforms/javascript/install/loader/#cdn
const SENTRY_BROWSER_VERSION = '11.12.0';
const SENTRY_BROWSER_SRI = 'sha384-fpjRzLWxkdRneAxDGo5pt5gKsjCWYV5ksPD+S1lx80QHBhs6Oe58hf8sKUKubCES';

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
  production: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || 'postgres://localhost:5432/amanicare',
  // Optional: run in a separate Postgres schema (used by the tests to stay isolated).
  databaseSchema: env.DATABASE_SCHEMA || '',
  databaseSsl: bool(env.DATABASE_SSL, false),
  databasePoolMax: Number(env.DATABASE_POOL_MAX || 10),
  uploadDir: env.UPLOAD_DIR || 'data/uploads',
  sessionDays: Number(env.SESSION_DAYS || 30),

  // Shows the OTP code in the API response. NEVER enable in production.
  otpDev: bool(env.OTP_DEV, env.NODE_ENV !== 'production'),
  adminPhone: env.ADMIN_PHONE || '',

  // AI bill reading (Anthropic Claude). Leave empty to disable; families then type details by hand.
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',

  // Payment partner: 'sandbox' until a licensed partner (e.g. Equity BCDC) provides API credentials.
  paymentPartner: env.PAYMENT_PARTNER || 'sandbox',
  paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET || 'dev-webhook-secret',
  sandboxAutoComplete: bool(env.SANDBOX_AUTO_COMPLETE, false),
  equity: {
    apiBase: env.EQUITY_API_BASE || '',
    clientId: env.EQUITY_CLIENT_ID || '',
    clientSecret: env.EQUITY_CLIENT_SECRET || '',
  },

  // Messaging: 'sandbox' stores messages in the outbox (visible to admins); 'whatsapp' uses the WhatsApp Cloud API.
  messaging: env.MESSAGING || 'sandbox',
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
  },

  // Error monitoring. Leave SENTRY_DSN empty to turn Sentry off (server and browser).
  sentry: {
    dsn: env.SENTRY_DSN || '',
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    release: env.SENTRY_RELEASE || (pkgVersion ? `amanicare@${pkgVersion}` : ''),
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || 0),
    browser: bool(env.SENTRY_BROWSER, true),
    browserBundleUrl: env.SENTRY_BROWSER_BUNDLE_URL || `https://browser.sentry-cdn.com/${SENTRY_BROWSER_VERSION}/bundle.min.js`,
    browserBundleSri: env.SENTRY_BROWSER_BUNDLE_SRI ?? SENTRY_BROWSER_SRI,
  },
};

export type Config = typeof config;
