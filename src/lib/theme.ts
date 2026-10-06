// Light/dark: dark by default, a light choice is remembered per device.
// index.html applies the saved choice before first paint.

export type Theme = 'light' | 'dark';
const KEY = 'prepweek:theme';
const listeners = new Set<() => void>();

/** The theme in effect right now. */
export const getTheme = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? 'dark';

export const onThemeChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const toggleTheme = () => {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    if (next === 'dark') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]')) m.content = next === 'dark' ? '#111318' : '#ffffff';
  listeners.forEach((l) => l());
};
