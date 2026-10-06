import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts.ts';
import { migrateClients, store } from './data/store.ts';
import { getServerHttp, startSync } from './data/sync.ts';
import { seed } from './data/seed.ts';
import { loadMe as loadIdentity } from './data/identity.ts';
import { initAccess, loadAccess } from './data/access.ts';
import { getMe, lastSheet, loadMe, newSheetId, rememberLastSheet, rememberMySheet } from './data/account.ts';
import { setupInstall } from './lib/install.ts';
import { TimelineModel } from './timeline/model.ts';
import { Timeline } from './timeline/Timeline.tsx';
import { InviteScreen } from './timeline/Account.tsx';

loadFonts();
setupInstall();
const root = createRoot(document.getElementById('root')!);

// Who's signed in (when the app is served by the worker); never blocks long.
await loadMe();

// /invite/<token>: join a workspace.
const invite = location.pathname.match(/^\/invite\/([^/]+)/)?.[1];
if (invite) {
  root.render(<InviteScreen token={decodeURIComponent(invite)} />);
} else {
  // One sheet per URL: /s/<sheetId>. Each sheet is its own store, IndexedDB
  // database, broadcast channel and (server-side) Durable Object.
  let sheetId = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
  if (!sheetId) {
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
    await startSync(sheetId, getMe() !== null);
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
