// "Connect Toggl Plan" (formerly Teamweek): OAuth 2 authorization-code flow
// plus a read-only API proxy.
//
//   GET  /oauth/toggl/start?return=/s/team   → redirect to Toggl Plan login
//   GET  /oauth/toggl/callback?code&state    → exchange code, set cookie
//   POST /oauth/toggl/logout                 → forget the token
//   GET  /api/toggl/status                   → { configured, connected }
//   GET  /api/toggl/<path>                   → GET api/v5/<path> as the user
//
// The client secret never reaches the browser, and the access token lives in
// an HttpOnly cookie so page scripts can't read it. The proxy only forwards
// GETs to an allowlist of read endpoints; the browser does the mapping into
// the same import plan as a CSV upload.
//
// Setup (once): register an app at developers.plan.toggl.com with redirect
// URI https://<your host>/oauth/toggl/callback, then
//   wrangler secret put TOGGL_PLAN_CLIENT_ID
//   wrangler secret put TOGGL_PLAN_CLIENT_SECRET

export interface TogglEnv {
  TOGGL_PLAN_CLIENT_ID?: string;
  TOGGL_PLAN_CLIENT_SECRET?: string;
  /** Overrides for testing against a mock. */
  TOGGL_PLAN_AUTH_URL?: string;
  TOGGL_PLAN_API_URL?: string;
}

const AUTH_URL = 'https://plan.toggl.com/oauth/login';
const API_URL = 'https://api.plan.toggl.com/api/v5/';
const TOKEN_COOKIE = 'tp_token';
const STATE_COOKIE = 'tp_state';

/** Read endpoints the proxy will forward (relative to api/v5/). */
const ALLOWED = [/^me$/, /^\d+\/(members|projects|groups|milestones)$/, /^\d+\/tasks(\/timeline)?$/];

interface Token {
  a: string; // access token
  r?: string; // refresh token
  e?: number; // expiry (ms since epoch)
}

const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.get('cookie') ?? '')
      .split(/;\s*/)
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const configured = (env: TogglEnv) => !!(env.TOGGL_PLAN_CLIENT_ID && env.TOGGL_PLAN_CLIENT_SECRET);

const readToken = (req: Request): Token | null => {
  try {
    const raw = cookies(req)[TOKEN_COOKIE];
    return raw ? (JSON.parse(atob(raw)) as Token) : null;
  } catch {
    return null;
  }
};

const tokenCookie = (t: Token) => setCookie(TOKEN_COOKIE, btoa(JSON.stringify(t)), 60 * 60 * 24 * 30);

/** Only same-site relative paths, so the flow can't be used as an open redirect. */
const safeReturn = (r: string | null) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/');

const requestToken = async (env: TogglEnv, body: Record<string, string>): Promise<Token> => {
  const res = await fetch(`${env.TOGGL_PLAN_API_URL ?? API_URL}authenticate/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.TOGGL_PLAN_CLIENT_ID}:${env.TOGGL_PLAN_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return { a: t.access_token, r: t.refresh_token, e: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined };
};

export const handleToggl = async (req: Request, env: TogglEnv): Promise<Response | null> => {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/oauth/toggl/') && !path.startsWith('/api/toggl/')) return null;

  if (path === '/api/toggl/status') {
    return json({ configured: configured(env), connected: !!readToken(req) });
  }
  if (!configured(env)) return json({ error: 'Toggl Plan import is not configured on this server.' }, 501);

  const redirectUri = `${url.origin}/oauth/toggl/callback`;

  if (path === '/oauth/toggl/start') {
    const state = crypto.randomUUID();
    const back = safeReturn(url.searchParams.get('return'));
    const auth = new URL(env.TOGGL_PLAN_AUTH_URL ?? AUTH_URL);
    auth.search = new URLSearchParams({ response_type: 'code', client_id: env.TOGGL_PLAN_CLIENT_ID!, redirect_uri: redirectUri, state }).toString();
    return new Response(null, {
      status: 302,
      headers: { location: auth.toString(), 'set-cookie': setCookie(STATE_COOKIE, `${state}|${back}`, 600) },
    });
  }

  if (path === '/oauth/toggl/callback') {
    const [expected, back] = (cookies(req)[STATE_COOKIE] ?? '').split('|');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const done = (hash: string, extra: string[] = []) => {
      const h = new Headers({ location: `${safeReturn(back ?? '/')}#${hash}` });
      h.append('set-cookie', setCookie(STATE_COOKIE, '', 0));
      for (const c of extra) h.append('set-cookie', c);
      return new Response(null, { status: 302, headers: h });
    };
    if (!code || !state || state !== expected) return done('import=toggl&error=state');
    try {
      const token = await requestToken(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      return done('import=toggl', [tokenCookie(token)]);
    } catch {
      return done('import=toggl&error=token');
    }
  }

  if (path === '/oauth/toggl/logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': setCookie(TOKEN_COOKIE, '', 0) });
  }

  if (path.startsWith('/api/toggl/') && req.method === 'GET') {
    const rel = path.slice('/api/toggl/'.length);
    if (!ALLOWED.some((r) => r.test(rel))) return json({ error: 'Not allowed' }, 403);
    let token = readToken(req);
    if (!token) return json({ error: 'Not connected' }, 401);
    const setCookies: string[] = [];
    const call = (t: Token) =>
      fetch(`${env.TOGGL_PLAN_API_URL ?? API_URL}${rel}${url.search}`, {
        headers: { authorization: `Bearer ${t.a}`, accept: 'application/json' },
      });
    if (token.e && token.e < Date.now() + 30_000 && token.r) {
      try {
        token = await requestToken(env, { grant_type: 'refresh_token', refresh_token: token.r });
        setCookies.push(tokenCookie(token));
      } catch {
        /* fall through: the call below will 401 */
      }
    }
    let res = await call(token);
    if (res.status === 401 && token.r) {
      try {
        token = await requestToken(env, { grant_type: 'refresh_token', refresh_token: token.r });
        setCookies.push(tokenCookie(token));
        res = await call(token);
      } catch {
        /* keep the 401 */
      }
    }
    if (res.status === 401) setCookies.push(setCookie(TOKEN_COOKIE, '', 0));
    const h = new Headers({ 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    for (const c of setCookies) h.append('set-cookie', c);
    return new Response(res.body, { status: res.status, headers: h });
  }

  return json({ error: 'Not found' }, 404);
};
