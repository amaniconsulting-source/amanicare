// Sentry for the browser. The server adds the SDK <script id="sentry-sdk"> (Sentry's CDN bundle,
// pinned with SRI) and <meta name="sentry-dsn"> only when SENTRY_DSN is set; otherwise this is a no-op.
// The SDK loads async so a slow connection never delays the app; errors before it loads are not reported.
import type * as SentrySdk from '@sentry/browser';

declare global {
  interface Window { Sentry?: typeof SentrySdk }
}

const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || '';
let started = false;

function start(): void {
  const Sentry = window.Sentry;
  const dsn = meta('sentry-dsn');
  if (started || !Sentry || !dsn) return;
  started = true;
  Sentry.init({
    dsn,
    environment: meta('sentry-environment') || undefined,
    release: meta('sentry-release') || undefined,
    // Health and payment data: collect nothing beyond the error itself.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      if (event.request?.url) event.request.url = event.request.url.split('?')[0];
      return event;
    },
    beforeBreadcrumb(crumb) {
      // Keep navigation and fetch breadcrumbs, but drop query strings (payment ids, codes).
      for (const k of ['url', 'from', 'to'] as const) {
        const v = crumb.data?.[k];
        if (typeof v === 'string') crumb.data![k] = v.split('?')[0];
      }
      // Console output can include API error details; it isn't needed to debug.
      return crumb.category === 'console' ? null : crumb;
    },
  });
}

export function initMonitoring(): void {
  if (!meta('sentry-dsn')) return;
  if (window.Sentry) { start(); return; }
  document.getElementById('sentry-sdk')?.addEventListener('load', start, { once: true });
}

/** Reports an unexpected error (not an API error the user already sees as a message). */
export function report(err: unknown): void {
  if (started) window.Sentry?.captureException(err);
}

export function setUser(id: string | null, role?: string): void {
  if (!started || !window.Sentry) return;
  window.Sentry.setUser(id ? { id } : null);
  window.Sentry.setTag('role', role || 'anonymous');
}
