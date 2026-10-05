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
  ASSETS: Fetcher;
}
