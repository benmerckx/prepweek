import { createMergeableStore, type Row } from 'tinybase';

// One MergeableStore per "sheet". It is a CRDT (hybrid logical clocks per
// cell), so local edits, other tabs and a Cloudflare Durable Object can all
// merge deterministically. See ./sync.ts for the wiring.

export const PALETTE = [
  '#4f7cff', '#22a06b', '#e5484d', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#64748b', '#84cc16', '#f97316',
] as const;

export type UserRow = { name: string; color: string; order: number; email: string; team?: string };
export type TaskRow = {
  userId: string;
  start: number; // day number, inclusive
  end: number; // day number, inclusive
  title: string;
  color: string;
  /** Preferred lane inside the user's row; -1 = no preference. */
  lane: number;
  notes: string;
  /** Project row id, or '' for none. */
  projectId?: string;
  /** Comma-separated labels, e.g. "Design,Urgent". */
  tags?: string;
};

export const store = createMergeableStore();

store.setTablesSchema({
  users: {
    name: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    order: { type: 'number', default: 0 },
    email: { type: 'string', default: '' },
    team: { type: 'string', default: '' },
  },
  tasks: {
    userId: { type: 'string', default: '' },
    start: { type: 'number', default: 0 },
    end: { type: 'number', default: 0 },
    title: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    lane: { type: 'number', default: -1 },
    notes: { type: 'string', default: '' },
    projectId: { type: 'string', default: '' },
    tags: { type: 'string', default: '' },
  },
  // Projects group tasks across people; a client groups projects.
  projects: {
    name: { type: 'string', default: '' },
    client: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    archived: { type: 'boolean', default: false },
  },
  // Saved views, shared with everyone on the sheet. `config` is JSON (see
  // ViewConfig), so new view options don't need a schema change.
  views: {
    name: { type: 'string', default: '' },
    order: { type: 'number', default: 0 },
    config: { type: 'string', default: '{}' },
  },
  // Sheet-wide dated markers (launches, deadlines, holidays).
  milestones: {
    day: { type: 'number', default: 0 },
    title: { type: 'string', default: '' },
    color: { type: 'string', default: '#8b5cf6' },
  },
  // Files and links on a task. File bytes live outside the CRDT (see
  // data/files.ts); this row is the shared metadata.
  attachments: {
    taskId: { type: 'string', default: '' },
    kind: { type: 'string', default: 'file' }, // 'file' | 'link'
    name: { type: 'string', default: '' },
    url: { type: 'string', default: '' },
    mime: { type: 'string', default: '' },
    size: { type: 'number', default: 0 },
    created: { type: 'number', default: 0 },
  },
});

export type ProjectRow = { name: string; client: string; color: string; archived: boolean };
export type ViewRow = { name: string; order: number; config: string };

/** What a saved view restores. Missing fields leave that setting alone. */
export interface ViewConfig {
  focus?: string[];
  query?: string;
  projects?: string[];
  tags?: string[];
  hideWeekends?: boolean;
  dense?: boolean;
  colW?: number;
}

/** Tags are stored comma-joined; this is the one place that parses them. */
export const parseTags = (s: string | undefined): string[] =>
  s ? s.split(',').map((t) => t.trim()).filter(Boolean) : [];
export const joinTags = (tags: string[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const v = t.replace(/,/g, ' ').trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.join(',');
};

export type MilestoneRow = { day: number; title: string; color: string };
export type AttachmentRow = {
  taskId: string;
  kind: 'file' | 'link';
  name: string;
  url: string;
  mime: string;
  size: number;
  created: number;
};

/** First is the default; not red, so milestones don't read as "today". */
export const MILESTONE_COLORS = ['#8b5cf6', '#4f5bd5', '#06b6d4', '#22a06b', '#f59e0b', '#ef4444', '#ec4899', '#64748b'] as const;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 16 random base62 chars (~95 bits); works outside secure contexts too. */
export const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % 62];
  return id;
};

export const getTask = (id: string): TaskRow | undefined =>
  store.hasRow('tasks', id) ? (store.getRow('tasks', id) as TaskRow) : undefined;

export const getUser = (id: string): UserRow | undefined =>
  store.hasRow('users', id) ? (store.getRow('users', id) as UserRow) : undefined;

// --- Undo / redo -----------------------------------------------------------
//
// We deliberately don't use TinyBase Checkpoints here: those would also undo
// changes that arrived from other collaborators. Instead each local command
// records the cells it changed, and undo only restores those cells.

type TableId = 'users' | 'tasks' | 'milestones' | 'attachments' | 'projects' | 'views';
type Snap = { table: TableId; id: string; row: Row | null };
type Entry = { label: string; before: Snap[]; after: Snap[] };

const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
const historyListeners = new Set<() => void>();
const emitHistory = () => historyListeners.forEach((l) => l());

export const onHistoryChange = (fn: () => void) => {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
};
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

const snap = (table: TableId, id: string): Snap => ({
  table,
  id,
  row: store.hasRow(table, id) ? { ...store.getRow(table, id) } : null,
});

const restore = (snaps: Snap[], other: Snap[]) => {
  store.transaction(() => {
    snaps.forEach((s, i) => {
      const o = other[i]?.row ?? null;
      if (s.row === null) {
        store.delRow(s.table, s.id);
      } else if (o === null) {
        store.setRow(s.table, s.id, s.row);
      } else {
        // Only touch the cells this command changed, so concurrent edits by
        // others to other cells survive an undo.
        for (const [cell, value] of Object.entries(s.row))
          if (o[cell] !== value) store.setCell(s.table, s.id, cell, value);
      }
    });
  });
};

/**
 * Run a local, undoable mutation. `touches` lists the rows that may change.
 */
export const commit = (label: string, touches: [TableId, string][], mutate: () => void) => {
  const before = touches.map(([t, id]) => snap(t, id));
  store.transaction(mutate);
  const after = touches.map(([t, id]) => snap(t, id));
  const changed = before.some((b, i) => JSON.stringify(b.row) !== JSON.stringify(after[i]!.row));
  if (!changed) return;
  undoStack.push({ label, before, after });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  emitHistory();
};

export const undo = () => {
  const e = undoStack.pop();
  if (!e) return;
  restore(e.before, e.after);
  redoStack.push(e);
  emitHistory();
};

export const redo = () => {
  const e = redoStack.pop();
  if (!e) return;
  restore(e.after, e.before);
  undoStack.push(e);
  emitHistory();
};

// --- Commands ---------------------------------------------------------------

export const updateTask = (id: string, patch: Partial<TaskRow>, label = 'Edit task') =>
  commit(label, [['tasks', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('tasks', id, k, v as string | number);
  });

export const createTask = (task: TaskRow, id = newId()): string => {
  commit('Create task', [['tasks', id]], () => store.setRow('tasks', id, task));
  return id;
};

export const attachmentsOf = (taskId: string): string[] =>
  store.getRowIds('attachments').filter((a) => store.getCell('attachments', a, 'taskId') === taskId);

/** Deleting a task also removes its attachments (one undo step). */
export const deleteTask = (id: string) => {
  const atts = attachmentsOf(id);
  commit('Delete task', [['tasks', id], ...atts.map((a) => ['attachments', a] as [TableId, string])], () => {
    store.delRow('tasks', id);
    for (const a of atts) store.delRow('attachments', a);
  });
};

// --- Milestones ---

export const createMilestone = (m: MilestoneRow): string => {
  const id = newId();
  commit('Add milestone', [['milestones', id]], () => store.setRow('milestones', id, m));
  return id;
};
export const updateMilestone = (id: string, patch: Partial<MilestoneRow>, label = 'Edit milestone') =>
  commit(label, [['milestones', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('milestones', id, k, v as string | number);
  });
export const deleteMilestone = (id: string) => commit('Delete milestone', [['milestones', id]], () => store.delRow('milestones', id));

// --- Projects ---

export const getProject = (id: string): ProjectRow | undefined =>
  id && store.hasRow('projects', id) ? (store.getRow('projects', id) as ProjectRow) : undefined;

export const createProject = (p: Partial<ProjectRow> & { name: string }): string => {
  const id = newId();
  const color = p.color ?? PALETTE[store.getRowCount('projects') % PALETTE.length]!;
  commit('Add project', [['projects', id]], () => store.setRow('projects', id, { client: '', archived: false, ...p, color }));
  return id;
};
export const updateProject = (id: string, patch: Partial<ProjectRow>, label = 'Edit project') =>
  commit(label, [['projects', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('projects', id, k, v as string | number | boolean);
  });
/** Deleting a project keeps its tasks, just without a project. */
export const deleteProject = (id: string) => {
  const tasks = store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'projectId') === id);
  commit('Delete project', [['projects', id], ...tasks.map((t) => ['tasks', t] as [TableId, string])], () => {
    store.delRow('projects', id);
    for (const t of tasks) store.setCell('tasks', t, 'projectId', '');
  });
};
/** Recolor a project and every task in it, in one step. */
export const recolorProject = (id: string, color: string) => {
  const tasks = store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'projectId') === id);
  commit('Recolor project', [['projects', id], ...tasks.map((t) => ['tasks', t] as [TableId, string])], () => {
    store.setCell('projects', id, 'color', color);
    for (const t of tasks) store.setCell('tasks', t, 'color', color);
  });
};

// --- Saved views ---

export const createView = (name: string, config: ViewConfig): string => {
  const id = newId();
  const order = Math.max(-1, ...store.getRowIds('views').map((v) => store.getCell('views', v, 'order') as number)) + 1;
  commit('Save view', [['views', id]], () => store.setRow('views', id, { name, order, config: JSON.stringify(config) }));
  return id;
};
export const updateView = (id: string, patch: { name?: string; config?: ViewConfig }) =>
  commit('Edit view', [['views', id]], () => {
    if (patch.name !== undefined) store.setCell('views', id, 'name', patch.name);
    if (patch.config) store.setCell('views', id, 'config', JSON.stringify(patch.config));
  });
export const deleteView = (id: string) => commit('Delete view', [['views', id]], () => store.delRow('views', id));
export const readView = (id: string): ViewConfig => {
  try {
    return JSON.parse(store.getCell('views', id, 'config') as string) as ViewConfig;
  } catch {
    return {};
  }
};

// --- Attachments ---

export const addAttachment = (a: Omit<AttachmentRow, 'created'>, id = newId()): string => {
  commit(a.kind === 'link' ? 'Add link' : 'Attach file', [['attachments', id]], () =>
    store.setRow('attachments', id, { ...a, created: Date.now() }),
  );
  return id;
};
export const removeAttachment = (id: string) => commit('Remove attachment', [['attachments', id]], () => store.delRow('attachments', id));

export const createUser = (name: string): string => {
  const id = newId();
  const order = Math.max(-1, ...store.getRowIds('users').map((u) => getUser(u)!.order)) + 1;
  const color = PALETTE[order % PALETTE.length]!;
  commit('Add person', [['users', id]], () => store.setRow('users', id, { name, color, order }));
  return id;
};

/** Apply an import plan as one undoable command. */
export type ImportMode = 'add' | 'replace';

/**
 * Apply an import plan as one undoable command. 'replace' first removes all
 * people, tasks and their attachments (milestones stay).
 */
export const applyImport = (
  plan: {
    people: { key: string; name: string; email: string; existingId?: string }[];
    tasks: { id: string; personKey: string; start: number; end: number; title: string; color: string; notes: string; project?: string; tags?: string }[];
  },
  mode: ImportMode = 'add',
) => {
  const ids = new Map<string, string>();
  const replace = mode === 'replace';
  const removed: [TableId, string][] = replace
    ? [
        ...store.getRowIds('users').map((id) => ['users', id] as [TableId, string]),
        ...store.getRowIds('tasks').map((id) => ['tasks', id] as [TableId, string]),
        ...store.getRowIds('attachments').map((id) => ['attachments', id] as [TableId, string]),
      ]
    : [];
  // Projects are matched by name (case-insensitive) and created if missing.
  // They are never removed by 'replace', like milestones.
  const projectIds = new Map<string, string>();
  for (const id of store.getRowIds('projects')) projectIds.set((store.getCell('projects', id, 'name') as string).toLowerCase(), id);
  const newProjects: { id: string; name: string; color: string }[] = [];
  for (const t of plan.tasks) {
    const name = t.project?.trim();
    if (!name || projectIds.has(name.toLowerCase())) continue;
    const id = newId();
    projectIds.set(name.toLowerCase(), id);
    newProjects.push({ id, name, color: t.color });
  }
  let order = replace ? 0 : Math.max(-1, ...store.getRowIds('users').map((u) => getUser(u)!.order)) + 1;
  const touches: [TableId, string][] = [...removed];
  for (const p of plan.people) {
    const id = p.existingId ?? newId();
    ids.set(p.key, id);
    touches.push(['users', id]);
  }
  for (const t of plan.tasks) touches.push(['tasks', t.id]);
  for (const p of newProjects) touches.push(['projects', p.id]);
  commit(`${replace ? 'Replace with' : 'Import'} ${plan.tasks.length} tasks`, touches, () => {
    for (const [table, id] of removed) store.delRow(table, id);
    for (const p of newProjects) store.setRow('projects', p.id, { name: p.name, color: p.color, client: '', archived: false });
    for (const p of plan.people) {
      const id = ids.get(p.key)!;
      if (p.existingId) {
        if (p.email && !getUser(id)!.email) store.setCell('users', id, 'email', p.email);
      } else {
        store.setRow('users', id, { name: p.name, email: p.email, color: PALETTE[order % PALETTE.length]!, order });
        order++;
      }
    }
    for (const t of plan.tasks) {
      store.setRow('tasks', t.id, {
        userId: ids.get(t.personKey)!,
        start: t.start,
        end: t.end,
        title: t.title,
        color: t.color,
        notes: t.notes,
        lane: -1,
        projectId: t.project ? (projectIds.get(t.project.trim().toLowerCase()) ?? '') : '',
        tags: joinTags(parseTags(t.tags)),
      });
    }
  });
  return { people: plan.people.filter((p) => !p.existingId).length, tasks: plan.tasks.length };
};

export const updateUser = (id: string, patch: Partial<UserRow>, label = 'Edit person') =>
  commit(label, [['users', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('users', id, k, v as string | number);
  });

/** Remove a person with their tasks and those tasks' attachments. */
export const deleteUser = (id: string) => {
  const tasks = store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'userId') === id);
  const taskSet = new Set(tasks);
  const atts = store.getRowIds('attachments').filter((a) => taskSet.has(store.getCell('attachments', a, 'taskId') as string));
  commit(
    'Remove person',
    [['users', id], ...tasks.map((t) => ['tasks', t] as [TableId, string]), ...atts.map((a) => ['attachments', a] as [TableId, string])],
    () => {
      for (const a of atts) store.delRow('attachments', a);
      for (const t of tasks) store.delRow('tasks', t);
      store.delRow('users', id);
    },
  );
};

/**
 * Put people in this order (and optionally move one into another team).
 * Only rows whose order actually changes are written.
 */
export const reorderUsers = (ids: string[], moved?: { id: string; team: string }) => {
  const changed = ids.filter((id, i) => store.getCell('users', id, 'order') !== i);
  if (moved && !changed.includes(moved.id)) changed.push(moved.id);
  commit(moved && getUser(moved.id)?.team !== moved.team ? 'Move to team' : 'Reorder people', changed.map((id) => ['users', id] as [TableId, string]), () => {
    ids.forEach((id, i) => store.getCell('users', id, 'order') !== i && store.setCell('users', id, 'order', i));
    if (moved) store.setCell('users', moved.id, 'team', moved.team);
  });
};

/** Rename a team: every member moves to the new name in one step. */
export const renameTeam = (from: string, to: string) => {
  const ids = store.getRowIds('users').filter((u) => store.getCell('users', u, 'team') === from);
  commit('Rename team', ids.map((u) => ['users', u] as [TableId, string]), () => {
    for (const u of ids) store.setCell('users', u, 'team', to);
  });
};

export const renameUser = (id: string, name: string) =>
  commit('Rename person', [['users', id]], () => store.setCell('users', id, 'name', name));
