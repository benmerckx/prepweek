// Usage statistics for the admin dashboard, in Workers Analytics Engine
// (the EVENTS binding; dataset prepweek_events). Cookieless and anonymous:
// a visitor is a daily code made from their address and browser, which
// changes every day and can't be turned back into either. Cloudflare keeps
// the points for three months.
//
// Every point: index1 = its kind, blob1..4 = labels, double1..3 = numbers.
//
//   req     blob1 route, blob2 method, blob3 status class (2xx…5xx)   double1 1, double2 status, double3 ms
//   view    blob1 page, blob2 referrer host, blob3 visitor (daily)    double1 1
//   error   blob1 where (client|worker), blob2 message, blob3 page/route
//   event   blob1 name (signup, sheet_load, digest, daily_play, daily_solve, …), blob2 detail
//   active  blob1 person (daily code)
//
// Read back through the SQL API (admin.ts), with CF_ACCOUNT_ID and CF_API_TOKEN.

import type { Env } from './env.ts';

export type Kind = 'req' | 'view' | 'error' | 'event' | 'active';

/** Write a point; never lets statistics break a request. */
export const track = (env: Env, kind: Kind, blobs: string[], doubles: number[] = [1]) => {
  try {
    env.EVENTS?.writeDataPoint({ indexes: [kind], blobs: blobs.map((b) => b.slice(0, 256)), doubles });
  } catch (e) {
    console.error('stats', e);
  }
};

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const today = () => new Date().toISOString().slice(0, 10);
/** A code for today only: the same visitor (or person) counts once a day. */
export const dailyCode = async (env: Env, ...parts: string[]) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([env.STATS_SALT ?? 'prepweek', today(), ...parts].join('|')))).slice(0, 16);

/** Which part of the app a request is for (no ids, so it groups). */
export const routeOf = (path: string) => {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'api' || seg[0] === 'auth') return `/${seg[0]}/${seg[1] ?? ''}`;
  return `/${seg[0] ?? ''}`;
};

const PAGES: [RegExp, string][] = [
  [/^\/$/, 'home'],
  [/^\/s\/demo\/?$/, 'demo'],
  [/^\/(app|s\/.+)$/, 'app'],
  [/^\/(daily|help|roadmap|privacy|terms|welcome|invite)\b/, ''],
];
const pageOf = (path: string) => {
  for (const [re, name] of PAGES) if (re.test(path)) return name || path.split('/')[1]!;
  return 'other';
};
const refHost = (ref: string, self: string) => {
  try {
    const h = new URL(ref).host.replace(/^www\./, '');
    return h === self ? '' : h;
  } catch {
    return '';
  }
};

/** Product events the browser may report (anything else is ignored). */
const CLIENT_EVENTS = new Set(['daily_play', 'daily_solve', 'daily_share', 'daily_reveal', 'daily_practice']);

/**
 * From the browser: POST /api/stats {t: 'view', p: path, r: referrer}
 * | {t: 'error', m: message, w: where} | {t: 'event', n: name, d: detail}.
 * Sent with sendBeacon; always answers 204.
 */
export const statsApi = async (req: Request, env: Env, url: URL): Promise<Response> => {
  const done = new Response(null, { status: 204 });
  if (req.method !== 'POST') return done;
  const body = (await req.json().catch(() => null)) as { t?: string; p?: string; r?: string; m?: string; w?: string; n?: string; d?: string } | null;
  if (!body) return done;
  // Bots don't count as visitors.
  const ua = req.headers.get('user-agent') ?? '';
  if (/bot|crawl|spider|preview|headless/i.test(ua)) return done;
  const path = String(body.p ?? '/').slice(0, 200);
  if (body.t === 'view') {
    const who = await dailyCode(env, req.headers.get('cf-connecting-ip') ?? '', ua);
    track(env, 'view', [pageOf(path), refHost(String(body.r ?? ''), url.host), who]);
  } else if (body.t === 'error' && body.m) {
    track(env, 'error', ['client', String(body.m).slice(0, 200), pageOf(path) + (body.w ? ` · ${String(body.w).slice(0, 80)}` : '')]);
  } else if (body.t === 'event' && body.n && CLIENT_EVENTS.has(body.n)) {
    track(env, 'event', [body.n, String(body.d ?? '').slice(0, 40)]);
  }
  return done;
};
