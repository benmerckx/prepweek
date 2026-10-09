// Usage statistics (see worker/stats.ts): a page view per page load, errors,
// and a few product events, sent with sendBeacon. No cookies, nothing about
// who you are; the worker turns your address and browser into a code that
// changes every day.

const send = (body: Record<string, string>) => {
  try {
    navigator.sendBeacon?.('/api/stats', new Blob([JSON.stringify(body)], { type: 'application/json' }));
  } catch {}
};

export const trackView = () => send({ t: 'view', p: location.pathname, r: document.referrer });
export const trackEvent = (n: string, d = '') => send({ t: 'event', n, d });

/** Uncaught errors, a handful per page load (the same one once). */
export const trackErrors = () => {
  const seen = new Set<string>();
  const report = (message: string, where: string) => {
    // Browser extensions and benign browser noise aren't ours to fix.
    if (!message || /ResizeObserver loop|extension:\/\/|Script error\.?$/i.test(message + where)) return;
    if (seen.has(message) || seen.size >= 5) return;
    seen.add(message);
    send({ t: 'error', m: message, w: where, p: location.pathname });
  };
  window.addEventListener('error', (e: ErrorEvent) => report(e.message || String(e.error), e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : ''));
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as { message?: string } | string | undefined;
    report(typeof r === 'string' ? r : (r?.message ?? 'Unhandled rejection'), 'promise');
  });
};
