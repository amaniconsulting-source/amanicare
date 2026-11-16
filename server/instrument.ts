// Sentry for Node. Loaded before the app with `node --import ./dist/server/instrument.js`
// so Sentry can instrument http and pg. Does nothing when SENTRY_DSN is empty.
//
// AmaniCare handles health and payment data, so events are scrubbed: no request bodies
// (bill photos, patient names, login codes), no cookies, no signatures, no query strings.
import * as Sentry from '@sentry/node';
import { config } from './config.js';

const SECRET_HEADERS = ['cookie', 'authorization', 'x-signature', 'x-hub-signature-256', 'x-api-key'];

export function scrubEvent<E extends Sentry.Event>(event: E): E {
  const req = event.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    if (req.query_string) req.query_string = '[filtered]';
    if (req.url) req.url = req.url.split('?')[0];
    if (req.headers) for (const h of Object.keys(req.headers)) if (SECRET_HEADERS.includes(h.toLowerCase())) delete req.headers[h];
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  return event;
}

if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release || undefined,
    tracesSampleRate: config.sentry.tracesSampleRate,
    // Sentry collects request bodies, query parameters, SQL parameters and local variables by default.
    // Here those can hold bill photos, patient names, phone numbers and login codes, so all are off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'content-type', 'accept-language'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => {
      // Outgoing calls to WhatsApp/Anthropic carry tokens in URLs or bodies; keep only the host and path.
      if (crumb.data?.url && typeof crumb.data.url === 'string') crumb.data.url = crumb.data.url.split('?')[0];
      return crumb;
    },
  });
}
