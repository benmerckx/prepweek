// The admin dashboard's data: GET /api/admin/overview?days=30, for the
// addresses in ADMIN_EMAILS (comma separated) only.
//
// Two sources: the directory (people, workspaces, plans, subscriptions)
// and the usage statistics in Workers Analytics Engine (stats.ts), read
// through Cloudflare's SQL API with CF_ACCOUNT_ID and CF_API_TOKEN (an API
// token with "Account Analytics: Read"). Without those, the dashboard shows
// the directory's numbers and says what to set.

import { directory, json, sessionUser } from './auth.ts';
import { PAID_PLANS } from '../src/lib/plans.ts';
import type { Env } from './env.ts';

const DATASET = 'prepweek_events';

export const isAdmin = (env: Env, email: string) =>
  (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());

type Row = Record<string, string | number>;
const sql = async (env: Env, query: string): Promise<Row[]> => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: query,
  });
  if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { data?: Row[] };
  return out.data ?? [];
};

/** Usage statistics for the last `days` days (see stats.ts for what's in each point). */
const analytics = async (env: Env, days: number) => {
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const day = 'toStartOfDay(timestamp) AS day';
  const [totals, views, pages, referrers, requests, routes, errors, events, active] = await Promise.all([
    sql(env, `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS visits FROM ${DATASET} WHERE index1 = 'view' AND ${since}`),
    sql(env, `SELECT ${day}, SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS visitors FROM ${DATASET} WHERE index1 = 'view' AND ${since} GROUP BY day ORDER BY day`),
    sql(env, `SELECT blob1 AS page, SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS visitors FROM ${DATASET} WHERE index1 = 'view' AND ${since} GROUP BY page ORDER BY views DESC LIMIT 12`),
    sql(env, `SELECT blob2 AS host, SUM(_sample_interval) AS views FROM ${DATASET} WHERE index1 = 'view' AND blob2 != '' AND ${since} GROUP BY host ORDER BY views DESC LIMIT 12`),
    sql(env, `SELECT ${day}, blob3 AS class, SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'req' AND ${since} GROUP BY day, class ORDER BY day`),
    sql(
      env,
      `SELECT blob1 AS route, blob3 AS class, SUM(_sample_interval) AS n, SUM(_sample_interval * double3) AS ms, MAX(double3) AS slowest FROM ${DATASET} WHERE index1 = 'req' AND ${since} GROUP BY route, class`,
    ),
    sql(env, `SELECT blob1 AS source, blob2 AS message, blob3 AS place, SUM(_sample_interval) AS n, MAX(timestamp) AS last FROM ${DATASET} WHERE index1 = 'error' AND ${since} GROUP BY source, message, place ORDER BY n DESC LIMIT 25`),
    sql(env, `SELECT ${day}, blob1 AS name, SUM(_sample_interval) AS n FROM ${DATASET} WHERE index1 = 'event' AND ${since} GROUP BY day, name ORDER BY day`),
    sql(env, `SELECT ${day}, COUNT(DISTINCT blob1) AS people FROM ${DATASET} WHERE index1 = 'active' AND ${since} GROUP BY day ORDER BY day`),
  ]);
  return { totals, views, pages, referrers, requests, routes, errors, events, active };
};

export async function adminApi(req: Request, env: Env, url: URL): Promise<Response> {
  const user = await sessionUser(req, env);
  if (!user) return json({ error: 'Log in first' }, 401);
  if (!isAdmin(env, user.email)) return json({ error: 'This account isn’t an admin' }, 403);
  if (url.pathname !== '/api/admin/overview' || req.method !== 'GET') return json({ error: 'Not found' }, 404);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const dir = await directory(env).adminStats(days);
  // Monthly revenue from subscriptions in good standing, at monthly prices
  // (a yearly plan is billed at ten months, so this runs a little high).
  const mrr = dir.subscriptions
    .filter((s) => ['active', 'trialing', 'past_due'].includes(s.status))
    .reduce((sum, s) => {
      const p = PAID_PLANS.find((x) => x.id === s.plan);
      return sum + (p ? p.month : 0) * s.n;
    }, 0);
  let usage: Awaited<ReturnType<typeof analytics>> | null = null;
  let usageError = '';
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) usageError = 'not-configured';
  else
    usage = await analytics(env, days).catch((e) => {
      usageError = e instanceof Error ? e.message : String(e);
      return null;
    });
  return json({ days, now: Date.now(), directory: dir, mrr, usage, usageError, recording: !!env.EVENTS });
}
