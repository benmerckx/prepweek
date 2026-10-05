import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts.ts';
import { store } from './data/store.ts';
import { startSync } from './data/sync.ts';
import { seed } from './data/seed.ts';
import { loadMe } from './data/identity.ts';
import { TimelineModel } from './timeline/model.ts';
import { Timeline } from './timeline/Timeline.tsx';

// One sheet per URL: /s/<sheetId>. Each sheet is its own store, IndexedDB
// database, broadcast channel and (server-side) Durable Object.
const sheetId = location.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? 'demo';

loadFonts();
try {
  await startSync(sheetId);
} catch (e) {
  // Storage can be unavailable (some private modes, quota). Run in memory
  // rather than staying on the boot screen.
  console.error('Local storage unavailable, changes will not be kept', e);
  if (store.getRowCount('users') === 0) seed();
}
loadMe();
const model = new TimelineModel(store);
createRoot(document.getElementById('root')!).render(<Timeline model={model} />);
