import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts.ts';
import { getMe, lastSheet, loadMe } from './data/account.ts';
import { setupInstall } from './lib/install.ts';

loadFonts();
setupInstall();
const root = createRoot(document.getElementById('root')!);

// Who's signed in (when the app is served by the worker); never blocks long.
await loadMe();

// New visitors get the landing page (also always at /welcome); anyone with
// an account or a sheet on this device goes straight to planning. Each is
// its own chunk, so the landing page doesn't load the planner.
const path = location.pathname;
const last = lastSheet();
const landing = path === '/welcome' || (path === '/' && !getMe()?.user && (!last || last === 'demo'));
if (landing) {
  const { Landing } = await import('./landing/Landing.tsx');
  root.render(<Landing />);
} else {
  const { startApp } = await import('./app.tsx');
  await startApp(root);
}
