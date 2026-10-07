// AppSumo licensing (Licensing API v2).
//
//   GET  /auth/appsumo/callback?code=…  AppSumo's "Activate" button lands here: the
//                                       code is exchanged for the buyer's licence key,
//                                       kept in a cookie, and the redeem page opens.
//   GET  /api/appsumo/pending           that licence and the workspaces it can go to
//   POST /api/appsumo/redeem {workspaceId}
//   POST /api/appsumo/webhook           purchase / activate / upgrade / downgrade /
//                                       deactivate, signed with the API key
//
// Set in the Partner Portal: OAuth redirect URL https://<app>/auth/appsumo/callback
// and webhook URL https://<app>/api/appsumo/webhook. Secrets: APPSUMO_CLIENT_SECRET,
// APPSUMO_API_KEY; var APPSUMO_CLIENT_ID.

import { cookie, cookies, directory, fail, json, page, sessionUser } from './auth.ts';
import type { LicenseEvent } from './directory.ts';
import type { Env } from './env.ts';

const COOKIE = 'pw_appsumo';
const base = (env: Env) => (env.APPSUMO_BASE || 'https://appsumo.com').replace(/\/$/, '');

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** HMAC-SHA256(key, timestamp + body) as hex, AppSumo's webhook signature. */
export const appsumoSignature = async (key: string, timestamp: string, body: string) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(timestamp + body)));
};
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function appsumoWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return fail('Method not allowed', 405);
  if (!env.APPSUMO_API_KEY) return fail('AppSumo isn’t configured', 501);
  const body = await req.text();
  const ts = req.headers.get('x-appsumo-timestamp') ?? '';
  const sig = (req.headers.get('x-appsumo-signature') ?? '').toLowerCase();
  if (!ts || !sameText(sig, await appsumoSignature(env.APPSUMO_API_KEY, ts, body))) return fail('Bad signature', 401);
  let e: LicenseEvent & { test?: boolean };
  try {
    e = JSON.parse(body);
  } catch {
    return fail('Bad JSON');
  }
  // The Partner Portal's "test" webhooks only check that we answer.
  if (!e.test) await directory(env).licenseEvent(e);
  return json({ success: true, event: e.event ?? '' });
}

/** AppSumo's "Activate" lands here with a one-time code. */
export async function appsumoCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  if (!env.APPSUMO_CLIENT_ID || !env.APPSUMO_CLIENT_SECRET) return page('AppSumo isn’t set up yet', 'Please try again in a little while, or write to us.', url.origin);
  if (!code) return page('Something went missing', 'The link from AppSumo had no code. Please press “Activate” on AppSumo again.', url.origin);
  try {
    const tok = await fetch(`${base(env)}/openid/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.APPSUMO_CLIENT_ID,
        client_secret: env.APPSUMO_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/auth/appsumo/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const { access_token } = (await tok.json().catch(() => ({}))) as { access_token?: string };
    if (!tok.ok || !access_token) throw new Error(`token ${tok.status}`);
    const lic = await fetch(`${base(env)}/openid/license_key/?access_token=${encodeURIComponent(access_token)}`);
    const { license_key } = (await lic.json().catch(() => ({}))) as { license_key?: string };
    if (!lic.ok || !license_key) throw new Error(`license ${lic.status}`);
    // Usually the webhook told us first; if not, AppSumo just vouched for it.
    const dir = directory(env);
    if (!(await dir.license(license_key))) await dir.licenseEvent({ event: 'activate', license_key, license_status: 'active' });
    return new Response(null, {
      status: 302,
      headers: { location: '/appsumo', 'set-cookie': cookie(url, COOKIE, license_key, 7 * 86400), 'cache-control': 'no-store' },
    });
  } catch (e) {
    console.error('appsumo oauth', e);
    return page('We couldn’t reach AppSumo', 'Please press “Activate” on AppSumo once more. If it keeps failing, write to us and we’ll sort it out by hand.', url.origin);
  }
}

/** The redeem page's API (signed-in parts check the session). */
export async function appsumoApi(req: Request, env: Env, url: URL, seg: string[]): Promise<Response> {
  const key = cookies(req)[COOKIE] ?? '';
  const dir = directory(env);
  const lic = key ? await dir.license(key) : null;
  const user = await sessionUser(req, env);
  if (seg[1] === 'pending' && req.method === 'GET') {
    const workspaces = user ? (await dir.workspaces(user.id, env.PLAN_LIMITS === 'on')).filter((w) => w.role === 'admin') : [];
    return json({
      license: lic ? { key: `${lic.key.slice(0, 4)}…${lic.key.slice(-4)}`, tier: lic.tier, status: lic.status, workspace: lic.workspace_id ? { id: lic.workspace_id, name: lic.workspace ?? '' } : null } : null,
      signedIn: !!user,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, plan: w.plan })),
    });
  }
  if (seg[1] === 'redeem' && req.method === 'POST') {
    if (req.headers.get('origin') && req.headers.get('origin') !== url.origin) return fail('Bad origin', 403);
    if (!user) return fail('Sign in first', 401);
    if (!lic) return fail('No AppSumo licence here. Press “Activate” on AppSumo first.', 404);
    const { workspaceId } = (await req.json().catch(() => ({}))) as { workspaceId?: string };
    try {
      await dir.redeemLicense(user.id, key, workspaceId ?? '');
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), 403);
    }
    return json({ ok: true, plan: await dir.workspacePlan(user.id, workspaceId!, env.PLAN_LIMITS === 'on') }, 200, {
      'set-cookie': cookie(url, COOKIE, '', 0),
    });
  }
  return fail('Not found', 404);
}

