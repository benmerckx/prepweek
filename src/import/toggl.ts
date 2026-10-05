// Toggl Plan (Teamweek) API → the same rows the CSV importer understands, so
// both paths share mapping, people matching, preview and idempotent ids.
//
// Field names follow Toggl's own client (github.com/toggl/go-teamweek) and the
// v5 docs: tasks have name, notes, start_date, end_date, estimated_minutes,
// done, color, project / project_id, and assignees as `user_id` (v4) or
// `workspace_members` (v5). Responses are read defensively (bare arrays or
// `{ data: [...] }`, ids or objects) because we can't pin the exact shape.

type Json = Record<string, unknown>;

export interface Workspace {
  id: number;
  name: string;
}

export const TOGGL_HEADER = [
  'Task name',
  'Task status',
  'Project name',
  'Tags',
  'Assignee name',
  'Assignee email',
  'Start date',
  'End date',
  'Estimated time (minutes)',
  'Color',
  'Notes',
];

const list = (v: unknown): Json[] => {
  if (Array.isArray(v)) return v as Json[];
  if (v && typeof v === 'object') {
    for (const k of ['data', 'tasks', 'members', 'projects', 'items', 'results']) {
      const inner = (v as Json)[k];
      if (Array.isArray(inner)) return inner as Json[];
    }
  }
  return [];
};

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const idOf = (v: unknown) => (v && typeof v === 'object' ? str((v as Json).id) : str(v));

export const workspacesFromMe = (me: unknown): Workspace[] => {
  const m = (me ?? {}) as Json;
  const ws = list(m.workspaces ?? m.memberships ?? []);
  return ws
    .map((w) => {
      const inner = (w.workspace ?? w) as Json;
      return { id: Number(inner.id ?? w.workspace_id), name: str(inner.name) || `Workspace ${str(inner.id)}` };
    })
    .filter((w) => Number.isFinite(w.id) && w.id > 0);
};

/** Convert API responses to importer rows (header = TOGGL_HEADER). */
export const togglToRows = (tasksRaw: unknown, membersRaw: unknown, projectsRaw: unknown): string[][] => {
  const members = new Map<string, { name: string; email: string }>();
  for (const m of list(membersRaw)) {
    const user = (m.user ?? {}) as Json;
    const info = { name: str(m.name) || str(user.name), email: str(m.email) || str(user.email) };
    // Tasks may reference the membership id or the underlying user id.
    for (const k of [m.id, m.user_id, user.id]) if (str(k)) members.set(str(k), info);
  }
  const projects = new Map<string, Json>();
  for (const p of list(projectsRaw)) projects.set(str(p.id), p);

  const rows: string[][] = [];
  for (const t of list(tasksRaw)) {
    const project = (t.project && typeof t.project === 'object' ? t.project : projects.get(str(t.project_id))) as Json | undefined;
    const assigneeRefs: unknown[] = [];
    for (const k of ['workspace_members', 'assignees', 'members', 'users', 'user_ids']) {
      const v = t[k];
      if (Array.isArray(v)) assigneeRefs.push(...v);
    }
    if (!assigneeRefs.length && t.user_id != null) assigneeRefs.push(t.user_id);
    if (!assigneeRefs.length && t.workspace_member_id != null) assigneeRefs.push(t.workspace_member_id);
    const people = assigneeRefs.map((ref) => {
      const fromList = members.get(idOf(ref));
      if (fromList) return fromList;
      const o = (ref && typeof ref === 'object' ? ref : {}) as Json;
      return { name: str(o.name), email: str(o.email) };
    });
    const tags = (Array.isArray(t.tags) ? (t.tags as unknown[]) : list(t.tags))
      .map((x) => (typeof x === 'string' ? x : str((x as Json | null)?.name)))
      .filter(Boolean);
    const done = t.done === true || /^(done|completed?)$/i.test(str(t.status));
    rows.push([
      str(t.name) || str(t.title),
      done ? 'Done' : str(t.status),
      project ? str(project.name) : '',
      tags.join(', '),
      people.map((p) => p.name).join('; '),
      people.every((p) => p.email) ? people.map((p) => p.email).join('; ') : '',
      str(t.start_date) || str(t.start),
      str(t.end_date) || str(t.end),
      str(t.estimated_minutes ?? t.estimate_minutes ?? t.estimate),
      str(t.color) || (project ? str(project.color) : ''),
      str(t.notes) || str(t.description),
    ]);
  }
  return rows;
};

// --- Talking to the worker -----------------------------------------------------

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`/api/toggl/${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
};

export const togglStatus = async (): Promise<{ configured: boolean; connected: boolean }> => {
  try {
    const res = await fetch('/api/toggl/status', { credentials: 'same-origin' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return { configured: false, connected: false };
    return await res.json();
  } catch {
    return { configured: false, connected: false };
  }
};

export const connectToggl = () => {
  location.href = `/oauth/toggl/start?return=${encodeURIComponent(location.pathname + location.search)}`;
};

export const disconnectToggl = () => fetch('/oauth/toggl/logout', { method: 'POST', credentials: 'same-origin' });

export const fetchWorkspaces = async () => workspacesFromMe(await get('me'));

const iso = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** Fetch everything needed for a workspace and date range, as importer rows. */
export const fetchTogglRows = async (workspace: number, from: number, to: number): Promise<string[][]> => {
  const range = `since=${iso(from)}&until=${iso(to)}`;
  const [members, projects] = await Promise.all([
    get(`${workspace}/members`),
    get(`${workspace}/projects`).catch(() => []),
  ]);
  // v5 timeline endpoint first; fall back to the plain task list.
  let tasks: unknown;
  try {
    tasks = await get(`${workspace}/tasks/timeline?${range}`);
  } catch (e) {
    if ((e as { status?: number }).status === 401) throw e;
    tasks = await get(`${workspace}/tasks?${range}`);
  }
  return togglToRows(tasks, members, projects);
};
