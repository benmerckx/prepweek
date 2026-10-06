// Installable app: register the service worker (offline shell) and keep the
// browser's install prompt so the menu can offer "Install app".

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const canInstall = () => deferred !== null;
export const onInstallChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const install = async () => {
  const e = deferred;
  if (!e) return;
  deferred = null;
  emit();
  await e.prompt();
};

export const setupInstall = () => {
  // Added here rather than in index.html, which the bundler would try to
  // resolve; they are plain files copied from public/.
  for (const [rel, href, type] of [
    ['manifest', '/manifest.webmanifest', ''],
    // The tab icon leaves out the cursor, which is a speck at 16 px.
    ['icon', '/icons/favicon.svg', 'image/svg+xml'],
    ['apple-touch-icon', '/icons/apple-touch-icon.png', ''],
  ]) {
    const link = document.createElement('link');
    link.rel = rel!;
    link.href = href!;
    if (type) link.type = type;
    document.head.append(link);
  }
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    emit();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
  // Not under the Bun dev server: a cached shell would fight hot reloading.
  const dev = location.port === '3000' && ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !dev) {
    addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
};
