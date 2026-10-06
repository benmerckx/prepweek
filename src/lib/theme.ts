// Light/dark: follows the system until toggled, then remembered per device.
// index.html applies the saved choice before first paint.

export type Theme = 'light' | 'dark';
const KEY = 'prepweek:theme';
const listeners = new Set<() => void>();

const system = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The theme in effect right now. */
export const getTheme = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? system();

export const onThemeChange = (fn: () => void) => {
  listeners.add(fn);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', fn);
  return () => {
    listeners.delete(fn);
    mq.removeEventListener('change', fn);
  };
};

export const toggleTheme = () => {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  // Back to "follow the system" when the choice matches it again.
  if (next === system()) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === system()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]')) m.content = next === 'dark' ? '#111318' : '#ffffff';
  listeners.forEach((l) => l());
};
