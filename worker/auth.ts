// Sign-in and the account API.
//
//   POST /auth/email            {email, next}  → sends a magic link
//   GET  /auth/verify?token=…   (the magic link) → a Continue button, which
//   POST /auth/verify {token}     → session cookie, redirect
//   GET  /auth/google?next=…    → Google sign-in (when configured)
//   GET  /auth/google/callback
//   POST /auth/logout
//   GET  /auth/config           → which sign-in methods are available
//
//   GET    /api/me
//   PATCH  /api/me                         {name}
//   PATCH  /api/me/digest                  {on?, tz?, origin?}
//   GET    /api/me/digest/preview          today's digest as a page
//   GET    /api/digest/off?t=…             the unsubscribe link (no sign-in)
//   POST   /api/workspaces                 {name}
//   PATCH  /api/workspaces/:id             {name}
//   DELETE /api/workspaces/:id             (admins; deletes its sheets)
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
import { buildDigest, localTime } from './digest.ts';
import { cancelSubscriptions } from './billing.ts';
import { escapeHtml, renderEmail } from './email.ts';

const COOKIE = 'pw_session';
const OAUTH_COOKIE = 'pw_oauth';

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));

/**
 * Access is checked when a connection opens, so after a change close the
 * open ones: they reconnect and are checked again. With `wipe`, the sheets
 * were deleted: free their storage and attachment files too.
 */
const dropConnections = async (env: Env, sheets: string[], wipe = false) => {
  await Promise.all(
    sheets.map(async (id) => {
      const sheet = env.SHEETS.get(env.SHEETS.idFromName(`sync/${id}`));
      await Promise.all([wipe ? sheet.wipe() : sheet.kick(), env.PRESENCE.get(env.PRESENCE.idFromName(id)).kick()]);
      if (!wipe || !env.FILES) return;
      for (let cursor: string | undefined; ; ) {
        const page = await env.FILES.list({ prefix: `${id}/`, cursor });
        if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }),
  );
};

export const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.get('cookie') ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => {
        // Another site's malformed cookie on this domain mustn't break every request.
        try {
          return [k, decodeURIComponent(v!)];
        } catch {
          return [k, v];
        }
      }),
  );

export const cookie = (url: URL, name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

export const sessionUser = async (req: Request, env: Env): Promise<User | null> => {
  const token = cookies(req)[COOKIE];
  return token ? directory(env).session(token) : null;
};

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const fail = (message: string, status = 400) => json({ error: message }, status);

/** Only same-site paths after sign-in (no open redirects). */
const safeNext = (next: unknown) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/app');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isLocal = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

/** Email is on when Mandrill has a key and a sender (a verified domain). */
export const canEmail = (env: Env) => !!(env.MANDRILL_API_KEY && env.EMAIL_FROM);


/** Send through Mandrill (Mailchimp Transactional). */
export const sendEmail = async (env: Env, to: string, subject: string, html: string, headers?: Record<string, string>) => {
  // EMAIL_FROM: "prepweek <login@yourdomain.com>" or just the address.
  const from = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(env.EMAIL_FROM ?? '');
  const res = await fetch('https://mandrillapp.com/api/1.0/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: env.MANDRILL_API_KEY,
      message: {
        from_email: from ? from[2] : env.EMAIL_FROM?.trim(),
        from_name: from?.[1] || 'PrepWeek',
        to: [{ email: to, type: 'to' }],
        subject,
        html,
        auto_text: true,
        headers,
        track_opens: false,
        track_clicks: false, // a rewritten sign-in link would break
      },
    }),
  });
  const out = (await res.json().catch(() => null)) as { status?: string; reject_reason?: string; message?: string }[] | { message?: string } | null;
  if (!res.ok) throw new Error(`Email failed: ${(out as { message?: string } | null)?.message ?? res.status}`);
  // 200 with a per-recipient status; "rejected"/"invalid" didn't go out.
  const r = Array.isArray(out) ? out[0] : undefined;
  if (r && (r.status === 'rejected' || r.status === 'invalid')) throw new Error(`Email not sent (${r.reject_reason ?? r.status})`);
};


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
    return json({ email: canEmail(env) || isLocal(url), google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), devLinks: !canEmail(env) && isLocal(url) });
  }

  if (path === '/auth/email' && req.method === 'POST') {
    const { email, next } = (await req.json().catch(() => ({}))) as { email?: string; next?: string };
    if (!email || !EMAIL.test(email)) return fail('That doesn’t look like an email address');
    const token = await directory(env).createLogin(email, safeNext(next));
    if (!token) return fail('A link is already on its way. Try again in a minute.', 429);
    const link = `${url.origin}/auth/verify?token=${encodeURIComponent(token)}`;
    if (canEmail(env)) {
      try {
        await sendEmail(
          env,
          email,
          'Your PrepWeek sign-in link',
          renderEmail({
            origin: url.origin,
            preheader: 'Your link to sign in to PrepWeek. It works once, for 20 minutes.',
            heading: 'Sign in to PrepWeek',
            paragraphs: ['Click the button below to sign in. New here? The same link creates your account, no password needed.'],
            button: { href: link, label: 'Sign in to PrepWeek' },
            footer: `This link works once, for 20 minutes, and was requested for ${escapeHtml(email)}.<br>If that wasn’t you, you can safely ignore this email.`,
          }),
        );
      } catch (e) {
        console.error('sign-in email', e);
        return fail(`Couldn’t send the email: ${e instanceof Error ? e.message : e}`, 502);
      }
      return json({ sent: true });
    }
    // No mail provider: only for local development, show the link instead.
    if (isLocal(url)) return json({ sent: false, devLink: link });
    return fail('Email sign-in isn’t configured on this server yet', 501);
  }

  if (path === '/auth/verify' && req.method === 'GET') {
    // Mail scanners (Outlook Safe Links and the like) open links before the
    // person does, which used up the one-time token. Opening the link only
    // shows a button; signing in takes the POST it sends.
    const token = escapeHtml(url.searchParams.get('token') ?? '');
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in to PrepWeek</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3f7;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#221f28}
main{background:#fffeff;border-radius:16px;padding:36px 32px;border:1px solid #e4e1e9;text-align:center;max-width:340px;margin:16px}
img{display:block;margin:0 auto 22px}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 22px;color:#66616f}
button{font:inherit;font-weight:600;color:#fbfafc;background:#26222d;border:0;border-radius:10px;padding:12px 28px;cursor:pointer}button:hover{background:#3a3443}
@media (prefers-color-scheme:dark){body{background:#292c34;color:#e8eaf0}main{background:#2e3139;border-color:#3a3e48}p{color:#aeb3bf}button,a{background:#e8eaf0;color:#1f2128}}</style></head>
<body><main><img src="/icons/icon-192.png" width="56" height="56" alt=""><h1>Sign in to PrepWeek</h1><p>Continue to finish signing in.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token}"><button autofocus>Continue</button></form></main></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' } },
    );
  }

  if (path === '/auth/verify' && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const login = await directory(env).consumeLogin(String(form?.get('token') ?? ''));
    if (!login) return Response.redirect(`${url.origin}/?signin`, 302);
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
    if (!id_token?.includes('.')) return fail('Google sign-in failed', 400);
    // Received straight from Google over TLS, so its claims can be read as-is.
    const claims = JSON.parse(atob(id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
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

/** A small page for links opened from an email. */
export const page = (heading: string, text: string, origin: string, action = `<a href="${origin}/app">Open PrepWeek</a>`) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3f7;color:#221f28;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:420px;margin:24px 16px;background:#fff;border:1px solid #e4e1e9;border-radius:14px;padding:28px}h1{margin:0 0 10px;font-size:20px}p{margin:0 0 20px;color:#66616f}
a,button{display:inline-block;padding:10px 18px;border:0;border-radius:9px;background:#26222d;color:#fbfafc;text-decoration:none;font:inherit;font-weight:600;cursor:pointer}form{margin:0}
@media (prefers-color-scheme:dark){body{background:#292c34;color:#e8eaf0}main{background:#2e3139;border-color:#3a3e48}p{color:#aeb3bf}button,a{background:#e8eaf0;color:#1f2128}}</style></head>
<body><main><h1>${heading}</h1><p>${text}</p>${action}</main></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

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

  // The unsubscribe link, signed in or not. Opening it asks first (mail
  // scanners open links); the POST also serves one-click List-Unsubscribe.
  if (seg[0] === 'digest' && seg[1] === 'off') {
    const t = url.searchParams.get('t') ?? '';
    if (req.method === 'GET')
      return page(
        'Turn off the daily digest?',
        'You’ll stop getting the morning email with your day and what changed. You can turn it back on from your account menu in PrepWeek.',
        url.origin,
        `<form method="post" action="/api/digest/off?t=${encodeURIComponent(t)}"><button>Turn off</button></form>`,
      );
    if (req.method === 'POST') {
      const email = await dir.digestOffByToken(t);
      return page(
        email === null ? 'This link has expired' : 'Daily digest turned off',
        email === null
          ? 'We couldn’t find your digest settings. You can turn the digest off from your account menu in PrepWeek.'
          : `You won’t get the daily digest${email ? ` at ${escapeHtml(email)}` : ''} any more. Changed your mind? Turn it back on from your account menu.`,
        url.origin,
      );
    }
  }

  if (seg[0] === 'me' && seg.length === 1 && req.method === 'GET') {
    return json(user ? { user, workspaces: await dir.workspaces(user.id, env.PLAN_LIMITS === 'on'), digest: await dir.digestSettings(user.id) } : { user: null, workspaces: [] });
  }
  if (!user) return fail('Sign in first', 401);

  try {
    if (seg[0] === 'me' && seg[1] === 'digest') {
      if (req.method === 'PATCH') {
        const b = body as { on?: unknown; tz?: unknown; origin?: unknown };
        return json(
          await dir.setDigest(user.id, {
            on: typeof b.on === 'boolean' ? b.on : undefined,
            tz: typeof b.tz === 'string' ? b.tz : undefined,
            origin: b.origin === url.origin ? url.origin : undefined,
          }),
        );
      }
      // What this morning's email would hold (since yesterday), to check it.
      if (seg[2] === 'preview' && req.method === 'GET') {
        const { tz } = await dir.digestSettings(user.id);
        const t = localTime(Date.now(), tz);
        const ws = await dir.workspaces(user.id);
        const mail = await buildDigest(
          env,
          { userId: user.id, email: user.email, name: user.name, token: '', date: t.date, day: t.day, since: Date.now() - 86_400_000, origin: url.origin, sheets: ws.flatMap((w) => w.sheets) },
          url.origin,
        );
        return mail
          ? new Response(mail.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
          : page('Nothing for today', 'Your digest would be empty today, so it wouldn’t be sent.', url.origin);
      }
    }
    // Export my data: the account, and every sheet of every workspace it's in.
    if (seg[0] === 'me' && seg[1] === 'export' && req.method === 'GET') {
      const acc = await dir.accountExport(user.id);
      const workspaces = await Promise.all(
        acc.workspaces.map(async (w) => ({
          id: w.id,
          name: w.name,
          role: w.role,
          sheets: await Promise.all(
            w.sheets.map(async (s) => ({ id: s.id, name: s.name, ...(JSON.parse(await env.SHEETS.get(env.SHEETS.idFromName(`sync/${s.id}`)).exportTables()) as { tables: unknown; values: unknown }) })),
          ),
        })),
      );
      const day = new Date().toISOString().slice(0, 10);
      return new Response(JSON.stringify({ exported: new Date().toISOString(), account: acc.user, digest: acc.digest, workspaces }, null, 2), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="prepweek-export-${day}.json"`,
          'cache-control': 'no-store',
        },
      });
    }
    // Delete my account (see DirectoryDurableObject.deleteAccount).
    if (seg[0] === 'me' && seg.length === 1 && req.method === 'DELETE') {
      const { sheets, workspaces } = await dir.deleteAccount(user.id);
      // Subscriptions of the workspaces that went with the account stop too.
      await cancelSubscriptions(env, workspaces);
      await dropConnections(env, sheets, true);
      return json({ ok: true }, 200, { 'set-cookie': cookie(url, COOKIE, '', 0) });
    }
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
      if (ws && seg.length === 2 && req.method === 'DELETE') {
        await cancelSubscriptions(env, [ws]);
        await dropConnections(env, await dir.deleteWorkspace(user.id, ws), true);
        return json({ ok: true });
      }
      if (ws && seg[2] === 'people') return json(await dir.people(user.id, ws));
      if (ws && seg[2] === 'members' && seg[3]) {
        if (req.method === 'PATCH') await dir.setRole(user.id, ws, seg[3], body.role === 'admin' ? 'admin' : 'member');
        else if (req.method === 'DELETE') await dropConnections(env, await dir.removeMember(user.id, ws, seg[3]));
        return json({ ok: true });
      }
      if (ws && seg[2] === 'invites' && req.method === 'POST') {
        const email = (body.email ?? '').trim();
        if (!EMAIL.test(email)) return fail('That doesn’t look like an email address');
        const role: WorkspaceRole = body.role === 'admin' ? 'admin' : 'member';
        const token = await dir.invite(user.id, ws, email, role);
        const link = `${url.origin}/invite/${token}`;
        let sent = false;
        if (canEmail(env)) {
          const info = await dir.inviteInfo(token);
          const ws = info?.workspace ?? 'their workspace';
          try {
            await sendEmail(
              env,
              email,
              `${user.name} invited you to ${info?.workspace ?? 'a workspace'} on PrepWeek`,
              renderEmail({
                origin: url.origin,
                preheader: `Join ${ws} on PrepWeek and plan together.`,
                heading: `${escapeHtml(user.name)} invited you to ${escapeHtml(ws)}`,
                paragraphs: [
                  `${escapeHtml(user.name)} uses PrepWeek to plan who works on what, week by week, and would like you to join <b>${escapeHtml(ws)}</b>.`,
                  `You’ll join as ${role === 'admin' ? 'an admin' : 'a member'}. Sign in with this email address (${escapeHtml(email)}) to accept.`,
                ],
                button: { href: link, label: `Join ${escapeHtml(ws)}` },
                footer: 'Not expecting this? You can ignore this email; nothing happens until you accept.',
              }),
            );
            sent = true;
          } catch (e) {
            // The invite exists either way; the dialog shows its link to copy.
            console.error('invite email', e);
          }
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
        // Only someone who may edit the sheet can put it in a workspace (which
        // locks out everyone else without a link).
        if (id) {
          const byKey = await env.SHEETS.get(env.SHEETS.idFromName(`sync/${id}`)).keyRole(body.key ?? '');
          if (byKey !== 'open' && byKey !== 'edit') return fail('Only editors can save this sheet to a workspace', 403);
        }
        const added = await dir.addSheet(user.id, body.workspaceId ?? '', body.name ?? '', id);
        // In a workspace, its members are who may open it: the links from
        // before stop working, and everyone without access is dropped.
        if (id) {
          await env.SHEETS.get(env.SHEETS.idFromName(`sync/${id}`)).setSharing('disable');
          await dropConnections(env, [id]);
        }
        return json({ id: added });
      }
      if (seg[1] && req.method === 'PATCH') {
        await dir.updateSheet(user.id, seg[1], { name: body.name, workspaceId: body.workspaceId });
        if (body.workspaceId) await dropConnections(env, [seg[1]]);
        return json({ ok: true });
      }
      if (seg[1] && req.method === 'DELETE') {
        if (await dir.removeSheet(user.id, seg[1])) await dropConnections(env, [seg[1]], true);
        return json({ ok: true });
      }
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 403);
  }
  return fail('Not found', 404);
}
