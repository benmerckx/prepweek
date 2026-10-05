// Cloudflare backend: one Durable Object per sheet.
//
// Each sheet is a TinyBase MergeableStore living in its own Durable Object,
// persisted to that object's private SQLite database. The object is also the
// realtime room: every client of the sheet holds a WebSocket to it, and it
// relays/merges CRDT changes between them. So "one database per sheet" comes
// for free, colocated with the sockets, with no cross-request DB round trips.
//
// Routing: wss://<host>/sync/<sheetId>  → Durable Object named "sync/<sheetId>"
// Everything else is served from ../dist (the Bun-built app).
import { DurableObject } from 'cloudflare:workers';
import { createMergeableStore } from 'tinybase';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import {
  getWsServerDurableObjectFetch,
  WsServerDurableObject,
} from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';

export class SheetDurableObject extends WsServerDurableObject {
  override createPersister() {
    return createDurableObjectSqlStoragePersister(createMergeableStore(), this.ctx.storage.sql);
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

const sync = getWsServerDurableObjectFetch('SHEETS');

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/sync/')) {
      // TODO(auth): verify the user may open this sheet before upgrading,
      // e.g. a session cookie / JWT checked here.
      return sync(request, env);
    }
    if (url.pathname.startsWith('/files/')) return files(request, env, url);
    if (url.pathname.startsWith('/presence/')) {
      const sheet = decodeURIComponent(url.pathname.slice('/presence/'.length));
      return env.PRESENCE.get(env.PRESENCE.idFromName(sheet)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Attachment bytes: PUT/GET /files/<sheet>/<id>, stored in R2 under
 * <sheet>/<id>. Optional: without an R2 binding named FILES this returns 501
 * and the app keeps attachments in each browser only.
 * TODO(auth): same as /sync, check access to <sheet> here.
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

interface Env {
  /** Optional R2 bucket for attachment bytes. */
  FILES?: R2Bucket;
  SHEETS: DurableObjectNamespace<SheetDurableObject>;
  PRESENCE: DurableObjectNamespace<PresenceDurableObject>;
  ASSETS: Fetcher;
}
