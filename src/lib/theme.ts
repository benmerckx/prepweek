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

/** Swap colors in one frame: no transition may animate the change. */
const withoutTransitions = (fn: () => void) => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.appendChild(style);
  fn();
  // Apply the new colors with transitions off, then let them back on.
  void getComputedStyle(document.body).color;
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
};

export const toggleTheme = () => {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  withoutTransitions(() => (document.documentElement.dataset.theme = next));
  try {
    if (next === 'dark') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]')) m.content = next === 'dark' ? '#161513' : '#fbfaf7';
  listeners.forEach((l) => l());
};
