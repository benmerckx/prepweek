// Sign-in and the account API.
//
//   POST /auth/email            {email, next}  → sends a magic link
//   GET  /auth/verify?token=…   (the magic link) → session cookie, redirect
//   GET  /auth/google?next=…    → Google sign-in (when configured)
//   GET  /auth/google/callback
//   POST /auth/logout
//   GET  /auth/config           → which sign-in methods are available
//
//   GET    /api/me
//   PATCH  /api/me                         {name}
//   POST   /api/workspaces                 {name}
//   PATCH  /api/workspaces/:id             {name}
//   GET    /api/workspaces/:id/people
//   PATCH  /api/workspaces/:id/members/:u  {role}
//   DELETE /api/workspaces/:id/members/:u
//   POST   /api/workspaces/:id/invites     {email, role}
//   DELETE /api/invites/:token
//   GET    /api/invites/:token
//   POST   /api/invites/:token/accept
//   POST   /api/sheets                     {workspaceId, name, id?}
//   PATCH  /api/sheets/:id                 {name?, workspaceId?}
//   DELETE /api/sheets/:id
//
// Sessions are an HttpOnly cookie holding a random token; the directory
// stores only its hash.

import type { Env } from './env.ts';
import type { User, WorkspaceRole } from './directory.ts';

const COOKIE = 'pw_session';
const OAUTH_COOKIE = 'pw_oauth';

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));

const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.get('cookie') ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v!)]),
  );

const cookie = (url: URL, name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

export const sessionUser = async (req: Request, env: Env): Promise<User | null> => {
  const token = cookies(req)[COOKIE];
  return token ? directory(env).session(token) : null;
};

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (message: string, status = 400) => json({ error: message }, status);

/** Only same-site paths after sign-in (no open redirects). */
const safeNext = (next: unknown) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isLocal = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

const sendEmail = async (env: Env, to: string, subject: string, html: string) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM ?? 'prepweek <onboarding@resend.dev>', to, subject, html }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status})`);
};

const button = (href: string, label: string) =>
  `<p><a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f5bd5;color:#fff;text-decoration:none;font-weight:600">${label}</a></p>`;

const signedIn = async (env: Env, url: URL, email: string, next: string, profile?: { name?: string; avatar?: string }) => {
  const { token } = await directory(env).signIn(email, profile);
  return new Response(null, {
    status: 302,
    headers: { location: next, 'set-cookie': cookie(url, COOKIE, token, 60 * 86400), 'cache-control': 'no-store' },
  });
};

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  // State-changing requests must come from our own pages.
  if (req.method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== url.origin) return fail('Bad origin', 403);

  if (path === '/auth/config') {
    return json({ email: !!env.RESEND_API_KEY || isLocal(url), google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), devLinks: !env.RESEND_API_KEY && isLocal(url) });
  }

  if (path === '/auth/email' && req.method === 'POST') {
    const { email, next } = (await req.json().catch(() => ({}))) as { email?: string; next?: string };
    if (!email || !EMAIL.test(email)) return fail('That doesn’t look like an email address');
    const token = await directory(env).createLogin(email, safeNext(next));
    const link = `${url.origin}/auth/verify?token=${encodeURIComponent(token)}`;
    if (env.RESEND_API_KEY) {
      await sendEmail(env, email, 'Your prepweek sign-in link', `<p>Click to sign in to prepweek:</p>${button(link, 'Sign in')}<p style="color:#888">The link works once, for 20 minutes. If you didn’t ask for it, ignore this email.</p>`);
      return json({ sent: true });
    }
    // No mail provider: only for local development, show the link instead.
    if (isLocal(url)) return json({ sent: false, devLink: link });
    return fail('Email sign-in isn’t configured on this server yet', 501);
  }

  if (path === '/auth/verify') {
    const login = await directory(env).consumeLogin(url.searchParams.get('token') ?? '');
    if (!login) return Response.redirect(`${url.origin}/?signin=expired`, 302);
    return signedIn(env, url, login.email, login.next);
  }

  if (path === '/auth/google') {
    if (!env.GOOGLE_CLIENT_ID) return fail('Google sign-in isn’t configured', 501);
    const state = crypto.randomUUID();
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    }).toString();
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), 'set-cookie': cookie(url, OAUTH_COOKIE, `${state}|${safeNext(url.searchParams.get('next'))}`, 600) },
    });
  }

  if (path === '/auth/google/callback') {
    const [state, next] = (cookies(req)[OAUTH_COOKIE] ?? '').split('|');
    if (!state || state !== url.searchParams.get('state') || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail('Sign-in expired, try again', 400);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code') ?? '',
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) return fail('Google sign-in failed', 400);
    const { id_token } = (await res.json()) as { id_token?: string };
    // Received straight from Google over TLS, so its claims can be read as-is.
    const claims = JSON.parse(atob((id_token ?? '').split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!claims.email || !claims.email_verified) return fail('Your Google account has no verified email', 400);
    const response = await signedIn(env, url, claims.email, safeNext(next), { name: claims.name, avatar: claims.picture });
    response.headers.append('set-cookie', cookie(url, OAUTH_COOKIE, '', 0));
    return response;
  }

  if (path === '/auth/logout' && req.method === 'POST') {
    const token = cookies(req)[COOKIE];
    if (token) await directory(env).signOut(token);
    return json({ ok: true }, 200, { 'set-cookie': cookie(url, COOKIE, '', 0) });
  }

  return fail('Not found', 404);
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== url.origin) return fail('Bad origin', 403);
  const user = await sessionUser(req, env);
  const dir = directory(env);
  const seg = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api/
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : ((await req.json().catch(() => ({}))) as Record<string, string>);

  // Invite details are public (shown before signing in).
  if (seg[0] === 'invites' && seg.length === 2 && req.method === 'GET') {
    const info = await dir.inviteInfo(seg[1]!);
    return info ? json(info) : fail('This invite has expired or was revoked', 404);
  }

  if (seg[0] === 'me' && req.method === 'GET') {
    return json(user ? { user, workspaces: await dir.workspaces(user.id) } : { user: null, workspaces: [] });
  }
  if (!user) return fail('Sign in first', 401);

  try {
    if (seg[0] === 'me' && req.method === 'PATCH') {
      await dir.rename(user.id, body.name ?? '');
      return json({ ok: true });
    }
    if (seg[0] === 'workspaces') {
      const ws = seg[1];
      if (!ws && req.method === 'POST') return json({ id: await dir.createWorkspace(user.id, body.name ?? '') });
      if (ws && seg.length === 2 && req.method === 'PATCH') {
        await dir.renameWorkspace(user.id, ws, body.name ?? '');
        return json({ ok: true });
      }
      if (ws && seg[2] === 'people') return json(await dir.people(user.id, ws));
      if (ws && seg[2] === 'members' && seg[3]) {
        if (req.method === 'PATCH') await dir.setRole(user.id, ws, seg[3], body.role === 'admin' ? 'admin' : 'member');
        else if (req.method === 'DELETE') await dir.removeMember(user.id, ws, seg[3]);
        return json({ ok: true });
      }
      if (ws && seg[2] === 'invites' && req.method === 'POST') {
        const email = (body.email ?? '').trim();
        if (!EMAIL.test(email)) return fail('That doesn’t look like an email address');
        const role: WorkspaceRole = body.role === 'admin' ? 'admin' : 'member';
        const token = await dir.invite(user.id, ws, email, role);
        const link = `${url.origin}/invite/${token}`;
        let sent = false;
        if (env.RESEND_API_KEY) {
          const info = await dir.inviteInfo(token);
          await sendEmail(env, email, `${user.name} invited you to ${info?.workspace ?? 'a workspace'} on prepweek`, `<p>${user.name} invited you to plan together in <b>${info?.workspace ?? 'their workspace'}</b>.</p>${button(link, 'Join')}`);
          sent = true;
        }
        return json({ token, link, sent });
      }
    }
    if (seg[0] === 'invites' && seg[1]) {
      if (seg[2] === 'accept' && req.method === 'POST') return json({ workspaceId: await dir.acceptInvite(user.id, seg[1]) });
      if (req.method === 'DELETE') {
        await dir.revokeInvite(user.id, seg[1]);
        return json({ ok: true });
      }
    }
    if (seg[0] === 'sheets') {
      if (!seg[1] && req.method === 'POST') {
        const id = body.id && /^[A-Za-z0-9_-]{6,40}$/.test(body.id) ? body.id : undefined;
        return json({ id: await dir.addSheet(user.id, body.workspaceId ?? '', body.name ?? '', id) });
      }
      if (seg[1] && req.method === 'PATCH') {
        await dir.updateSheet(user.id, seg[1], { name: body.name, workspaceId: body.workspaceId });
        return json({ ok: true });
      }
      if (seg[1] && req.method === 'DELETE') {
        await dir.removeSheet(user.id, seg[1]);
        return json({ ok: true });
      }
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 403);
  }
  return fail('Not found', 404);
}
