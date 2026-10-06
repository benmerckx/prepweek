// The planner: everything needed to open a sheet (store, sync, timeline).
// Loaded on demand by main.tsx, so the landing page doesn't download it.

import type { Root } from 'react-dom/client';
import { migrateClients, store } from './data/store.ts';
import { getServerHttp, startSync } from './data/sync.ts';
import { seed } from './data/seed.ts';
import { loadMe as loadIdentity } from './data/identity.ts';
import { initAccess, loadAccess } from './data/access.ts';
import { getMe, lastSheet, newSheetId, rememberLastSheet, rememberMySheet, type Me } from './data/account.ts';
import { TimelineModel } from './timeline/model.ts';
import { Timeline } from './timeline/Timeline.tsx';
import { InviteScreen } from './timeline/Account.tsx';

/** `account`: who's signed in, still loading; only awaited where it matters. */
export const startApp = async (root: Root, account: Promise<Me | null>) => {
  // /invite/<token>: join a workspace.
  const invite = location.pathname.match(/^\/invite\/([^/]+)/)?.[1];
  if (invite) {
    await account;
    root.render(<InviteScreen token={decodeURIComponent(invite)} />);
  } else {
    // One sheet per URL: /s/<sheetId>. Each sheet is its own store, IndexedDB
    // database, broadcast channel and (server-side) Durable Object.
    // /app (or any other path): your last sheet, else the first you can open,
    // else a new one.
    let sheetId = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
    if (!sheetId) {
      // Which sheet to open depends on the account.
      await account;
      const me = getMe();
      const known = me?.workspaces.flatMap((w) => w.sheets.map((s) => s.id)) ?? [];
      const last = lastSheet();
      if (me?.user) {
        // Signed in: back to the last sheet, else the first one you can open.
        sheetId = last && known.includes(last) ? last : known[0];
      }
      if (!sheetId) {
        // Without an account: your last sheet on this device, or a brand-new
        // one with its own address, so you can come back to it and share it.
        sheetId = last ?? newSheetId();
        if (!last) rememberMySheet(sheetId);
      }
      history.replaceState(history.state, '', `/s/${encodeURIComponent(sheetId)}${location.search}`);
    }
    sheetId = decodeURIComponent(sheetId);
    rememberLastSheet(sheetId);

    initAccess(sheetId);
    try {
      // Whether the worker serves us only matters on localhost (see syncUrl);
      // elsewhere, open the sheet from this device without waiting for it.
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      await startSync(sheetId, local ? (await account) !== null : true);
    } catch (e) {
      // Storage can be unavailable (some private modes, quota). Run in memory
      // rather than staying on the boot screen.
      console.error('Local storage unavailable, changes will not be kept', e);
      if (sheetId === 'demo' && store.getRowCount('users') === 0) seed();
    }
    // Client names on projects become client rows (also when a device on an
    // older version adds one later).
    migrateClients();
    let migrating = 0;
    store.addTableListener('projects', () => {
      clearTimeout(migrating);
      migrating = setTimeout(migrateClients, 1000) as unknown as number;
    });
    loadIdentity();
    // What we may do here (view-only, or locked out); never blocks first paint.
    void loadAccess(getServerHttp());
    const model = new TimelineModel(store);
    root.render(<Timeline model={model} />);
  }
};
