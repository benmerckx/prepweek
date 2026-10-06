// Cloudflare backend: one Durable Object per sheet.
//
// Each sheet is a TinyBase MergeableStore living in its own Durable Object,
// persisted to that object's private SQLite database. The object is also the
// realtime room: every client of the sheet holds a WebSocket to it, and it
// relays/merges CRDT changes between them. So "one database per sheet" comes
// for free, colocated with the sockets, with no cross-request DB round trips.
//
// Routing (all take ?k=<share key> once a sheet has private links):
//   wss://<host>/sync/<sheetId>      → Durable Object named "sync/<sheetId>"
//   wss://<host>/presence/<sheetId>  → presence relay for the sheet
//   /files/<sheetId>/<id>            → attachment bytes in R2
//   /share/<sheetId>                 → GET sharing state, POST enable/rotate/disable
//   /auth/*, /api/*                  → accounts, workspaces, sheets (auth.ts)
// Everything else is served from ../dist (the Bun-built app).
import { DurableObject } from 'cloudflare:workers';
import { createMergeableStore } from 'tinybase';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { directory, handleApi, handleAuth, sessionUser } from './auth.ts';
import type { Env } from './env.ts';

export { DirectoryDurableObject } from './directory.ts';

export type Role = 'edit' | 'view' | 'none';
interface Share {
  edit: string;
  view: string;
}

/** TinyBase sync messages a view-only client may send: requests to read. */
const READ_MESSAGES = new Set([1 /* GetContentHashes */, 4, 5, 6, 7 /* Get…Diff */]);

const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
};

export class SheetDurableObject extends WsServerDurableObject {
  // Stored "fragmented": a row per table/row/value. The default JSON mode
  // keeps the whole sheet in one row, and Cloudflare caps a row at 2 MB, so a
  // big sheet (a Teamweek import) silently stopped being saved: it lived in
  // memory only and was gone for whoever connected after the object restarted.
  override async createPersister() {
    const sql = this.ctx.storage.sql;
    const store = createMergeableStore();
    const persister = createDurableObjectSqlStoragePersister(store, sql, { mode: 'fragmented' });
    // Sheets saved before the switch: carry the JSON copy over, once.
    const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    const migrated = tables.has('tinybase_tables') && sql.exec('SELECT 1 FROM tinybase_tables LIMIT 1').toArray().length > 0;
    if (tables.has('tinybase') && !migrated) {
      const old = createMergeableStore();
      await createDurableObjectSqlStoragePersister(old, sql).load();
      store.setMergeableContent(old.getMergeableContent());
      await persister.save();
    }
    return persister;
  }

  // A big sheet (a Teamweek import: thousands of tasks) syncs in payloads of
  // many megabytes, but Cloudflare drops WebSocket messages over 1 MiB. So
  // payloads go in fragments (see SYNC_FRAGMENT in src/data/sync.ts), and
  // replies that big may take longer than TinyBase's 1 second default.
  override getFragmentSize() {
    return 768 * 1024;
  }
  override getRequestTimeoutSeconds() {
    return 30;
  }

  // --- Link sharing ---
  //
  // A sheet starts open: anyone who knows its URL can edit (like the demo).
  // Turning on private links mints two secret keys; from then on the edit
  // link or the view link is needed. Resetting replaces both and drops
  // everyone connected, so old links stop working at once.

  /** What a share key allows; 'open' when private links are off. */
  async keyRole(key: string): Promise<Role | 'open'> {
    const share = await this.ctx.storage.get<Share>('share');
    if (!share) return 'open';
    if (key && key === share.edit) return 'edit';
    if (key && key === share.view) return 'view';
    return 'none';
  }

  async shareKeys(): Promise<Share | null> {
    return (await this.ctx.storage.get<Share>('share')) ?? null;
  }

  /** The worker has already checked the caller may edit. */
  async setSharing(action: 'enable' | 'rotate' | 'disable'): Promise<Share | null> {
    if (action === 'disable') {
      await this.ctx.storage.delete('share');
      return null;
    }
    const share = { edit: newToken(), view: newToken() };
    await this.ctx.storage.put<Share>('share', share);
    // Everyone reconnects and is checked against the new links.
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'Sharing links changed');
    return share;
  }

  override async fetch(request: Request) {
    const role = request.headers.get('x-prepweek-role');
    const response = await super.fetch!(request);
    // Mark view-only sockets; the mark lives on the socket (survives hibernation).
    const id = request.headers.get('sec-websocket-key');
    if (role === 'view' && id) for (const ws of this.ctx.getWebSockets(id)) ws.serializeAttachment({ view: true });
    return response;
  }

  override webSocketMessage(client: WebSocket, message: string | ArrayBuffer) {
    if ((client.deserializeAttachment() as { view?: boolean } | null)?.view) {
      // Payload: "<toClientId>\n[requestId, messageType, body]". Fragments
      // (large messages) and anything that carries content are dropped.
      const raw = message.toString();
      const body = raw.slice(raw.indexOf('\n') + 1);
      if (!body.startsWith('[')) return;
      try {
        if (!READ_MESSAGES.has(JSON.parse(body)[1])) return;
      } catch {
        return;
      }
    }
    return super.webSocketMessage!(client, message);
  }
}

/**
 * Live presence for one sheet: who is here, where they look, what they have
 * selected. Pure relay, nothing is stored: each socket's latest state rides
 * on the socket itself (survives hibernation) so newcomers get a snapshot.
 */
export class PresenceDurableObject extends DurableObject {
  override async fetch(request: Request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // Snapshot of everyone already here.
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment();
      if (ws !== server && state) server.send(JSON.stringify(state));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 4096) return;
    let msg: { t?: string; id?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof msg.id !== 'string') return;
    if (msg.t === 'bye') ws.serializeAttachment(null);
    else ws.serializeAttachment(msg);
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(message);
  }

  override async webSocketClose(ws: WebSocket) {
    this.leave(ws);
  }
  override async webSocketError(ws: WebSocket) {
    this.leave(ws);
  }
  private leave(ws: WebSocket) {
    const state = ws.deserializeAttachment() as { id?: string } | null;
    if (!state?.id) return;
    const bye = JSON.stringify({ t: 'bye', id: state.id });
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(bye);
  }
}

/** The sheet's Durable Object (TinyBase names it after the sync path). */
const sheetStub = (env: Env, sheet: string) => env.SHEETS.get(env.SHEETS.idFromName(`sync/${sheet}`));
const forbidden = () => new Response('This sheet needs a share link', { status: 403 });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * The caller's role on a sheet. A sheet in a workspace is open to its
 * members; anyone else needs a private link. A sheet not (yet) in a
 * workspace, e.g. one started without an account, is open to whoever has
 * its unguessable address unless private links are on.
 */
const sheetAccess = async (request: Request, env: Env, sheet: string, key: string) => {
  const user = await sessionUser(request, env);
  const [info, byKey] = await Promise.all([directory(env).sheet(sheet, user?.id ?? null), sheetStub(env, sheet).keyRole(key)]);
  let role: Role;
  if (info.deleted) role = 'none';
  else if (info.workspace) role = info.role ? 'edit' : byKey === 'open' ? 'none' : byKey;
  else role = byKey === 'open' ? 'edit' : byKey;
  return { role, user, info, isPrivate: byKey !== 'open' };
};

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) return handleAuth(request, env, url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    const route = /^\/(sync|files|presence|share)\/([^/]+)/.exec(url.pathname);
    if (!route) return env.ASSETS.fetch(request);
    const kind = route[1]!;
    const sheet = decodeURIComponent(route[2]!);
    const key = url.searchParams.get('k') ?? '';
    const stub = sheetStub(env, sheet);
    const { role, user, info, isPrivate } = await sheetAccess(request, env, sheet, key);

    if (kind === 'share') {
      if (request.method === 'GET') {
        const keys = role === 'edit' && isPrivate ? await stub.shareKeys() : null;
        return json({ role, private: isPrivate, ...keys, name: info.name, workspace: info.workspace, signedIn: !!user, deleted: info.deleted });
      }
      if (request.method === 'POST') {
        if (role !== 'edit') return forbidden();
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return forbidden();
        const { action } = (await request.json().catch(() => ({}))) as { action?: string };
        if (action !== 'enable' && action !== 'rotate' && action !== 'disable') return json({ error: 'Unknown action' }, 400);
        const keys = await stub.setSharing(action);
        return json({ role, private: !!keys, ...keys, name: info.name, workspace: info.workspace, signedIn: !!user });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (role === 'none') return forbidden();
    if (kind === 'sync') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
      // The role is decided here, never by the client.
      const headers = new Headers(request.headers);
      headers.set('x-prepweek-role', role);
      return stub.fetch(new Request(request, { headers }));
    }
    if (kind === 'files') {
      if (request.method !== 'GET' && role !== 'edit') return forbidden();
      return files(request, env, url);
    }
    // Presence: viewers are present too.
    return env.PRESENCE.get(env.PRESENCE.idFromName(sheet)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Attachment bytes: PUT/GET /files/<sheet>/<id>, stored in R2 under
 * <sheet>/<id>. Optional: without an R2 binding named FILES this returns 501
 * and the app keeps attachments in each browser only.
 */
async function files(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.FILES) return new Response('File storage is not configured', { status: 501 });
  const m = /^\/files\/([^/]+)\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) return new Response('Not found', { status: 404 });
  const key = `${decodeURIComponent(m[1]!)}/${m[2]}`;
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) return new Response('Too large', { status: 413 });
    await env.FILES.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === 'GET') {
    const obj = await env.FILES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, max-age=31536000, immutable' });
    obj.writeHttpMetadata(headers);
    return new Response(obj.body, { headers });
  }
  return new Response('Method not allowed', { status: 405 });
}
