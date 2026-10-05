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
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/sync/')) {
      // TODO(auth): verify the user may open this sheet before upgrading,
      // e.g. a session cookie / JWT checked here.
      return sync(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Env {
  SHEETS: DurableObjectNamespace<SheetDurableObject>;
  ASSETS: Fetcher;
}
