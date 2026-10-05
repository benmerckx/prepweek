import { createRoot } from 'react-dom/client';
import { store } from './data/store.ts';
import { startSync } from './data/sync.ts';
import { TimelineModel } from './timeline/model.ts';
import { Timeline } from './timeline/Timeline.tsx';

// One sheet per URL: /s/<sheetId>. Each sheet is its own store, IndexedDB
// database, broadcast channel and (server-side) Durable Object.
const sheetId = location.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? 'demo';

await startSync(sheetId);
const model = new TimelineModel(store);
createRoot(document.getElementById('root')!).render(<Timeline model={model} />);
