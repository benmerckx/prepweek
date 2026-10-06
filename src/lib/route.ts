// Sections of a sheet: the plan (timeline), projects and clients.
//   /s/<sheet>                 plan
//   /s/<sheet>/projects[/<id>] projects, or one project
//   /s/<sheet>/clients[/<id>]  clients, or one client
// Switching happens in the page (no reload): it's the same sheet and data.

import { useSyncExternalStore } from 'react';

export type Section = 'plan' | 'projects' | 'clients';
export interface Route {
  section: Section;
  id?: string;
}

const parse = (path: string): Route => {
  const m = /^\/s\/[^/]+\/(projects|clients)(?:\/([^/]+))?/.exec(path);
  if (!m) return { section: 'plan' };
  return { section: m[1] as Section, id: m[2] ? decodeURIComponent(m[2]) : undefined };
};

let current = parse(location.pathname);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

addEventListener('popstate', () => {
  const next = parse(location.pathname);
  if (next.section === current.section && next.id === current.id) return;
  current = next;
  emit();
});

export const getRoute = () => current;
export const onRoute = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useRoute = () => useSyncExternalStore(onRoute, getRoute);

export const routePath = (r: Route) => {
  const base = /^\/s\/[^/]+/.exec(location.pathname)?.[0] ?? '';
  if (r.section === 'plan') return base;
  return `${base}/${r.section}${r.id ? `/${encodeURIComponent(r.id)}` : ''}`;
};

export const navigate = (r: Route) => {
  if (r.section === current.section && r.id === current.id) return;
  history.pushState(null, '', routePath(r) + location.search);
  current = r;
  emit();
  window.scrollTo(0, 0);
};
