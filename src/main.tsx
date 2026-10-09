import { APPSUMO_LIVE } from './lib/plans.ts';
import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts.ts';
import { loadMe } from './data/account.ts';
import { setupInstall } from './lib/install.ts';
import { loadChunk } from './lib/chunks.ts';
import { trackErrors, trackView } from './lib/stats.ts';

loadFonts();
setupInstall();
trackErrors();
// The admin dashboard doesn't count itself.
if (!location.pathname.startsWith('/admin')) trackView();
const root = createRoot(document.getElementById('root')!);

// Who's signed in (when the app is served by the worker). The planner
// doesn't wait for it to open a sheet from this device's cache.
const me = loadMe();

// The home page lives at / (and /welcome), the planner everywhere else:
// /app opens your last sheet, /s/<id> a given one. Each is its own chunk,
// so the home page doesn't load the planner.
const path = location.pathname;
// The AppSumo page waits until the deal is live (see lib/plans.ts).
const landing = path === '/' || path === '/welcome' || (!APPSUMO_LIVE && /^\/appsumo\/?$/.test(path));
const page = ({ ...(APPSUMO_LIVE ? { '/appsumo': 'AppSumoPage' } : {}), '/help': 'HelpPage', '/daily': 'DailyPage', '/roadmap': 'RoadmapPage', '/privacy': 'PrivacyPage', '/terms': 'TermsPage' } as const)[path.replace(/\/$/, '') as '/help'];
if (path.replace(/\/$/, '') === '/admin') {
  const [{ AdminPage }] = await Promise.all([loadChunk(() => import('./landing/Admin.tsx')), me]);
  root.render(<AdminPage />);
} else if (page) {
  const [pages] = await Promise.all([loadChunk(() => import('./landing/Pages.tsx')), me]);
  const Page = pages[page];
  root.render(<Page />);
} else if (landing) {
  const [{ Landing }] = await Promise.all([loadChunk(() => import('./landing/Landing.tsx')), me]);
  root.render(<Landing />);
} else {
  const { startApp } = await loadChunk(() => import('./app.tsx'));
  await startApp(root, me);
}
