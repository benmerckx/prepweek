import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts.ts';
import { loadMe } from './data/account.ts';
import { setupInstall } from './lib/install.ts';
import { loadChunk } from './lib/chunks.ts';

loadFonts();
setupInstall();
const root = createRoot(document.getElementById('root')!);

// Who's signed in (when the app is served by the worker); never blocks long.
await loadMe();

// The home page lives at / (and /welcome), the planner everywhere else:
// /app opens your last sheet, /s/<id> a given one. Each is its own chunk,
// so the home page doesn't load the planner.
const path = location.pathname;
const landing = path === '/' || path === '/welcome';
if (landing) {
  const { Landing } = await loadChunk(() => import('./landing/Landing.tsx'));
  root.render(<Landing />);
} else {
  const { startApp } = await loadChunk(() => import('./app.tsx'));
  await startApp(root);
}
