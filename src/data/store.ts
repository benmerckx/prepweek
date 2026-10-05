import { createMergeableStore, type Row } from 'tinybase';

// One MergeableStore per "sheet". It is a CRDT (hybrid logical clocks per
// cell), so local edits, other tabs and a Cloudflare Durable Object can all
// merge deterministically. See ./sync.ts for the wiring.

export const PALETTE = [
  '#4f7cff', '#22a06b', '#e5484d', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#64748b', '#84cc16', '#f97316',
] as const;

export type UserRow = { name: string; color: string; order: number; email: string };
export type TaskRow = {
  userId: string;
  start: number; // day number, inclusive
  end: number; // day number, inclusive
  title: string;
  color: string;
  /** Preferred lane inside the user's row; -1 = no preference. */
  lane: number;
  notes: string;
};

export const store = createMergeableStore();

store.setTablesSchema({
  users: {
    name: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    order: { type: 'number', default: 0 },
    email: { type: 'string', default: '' },
  },
  tasks: {
    userId: { type: 'string', default: '' },
    start: { type: 'number', default: 0 },
    end: { type: 'number', default: 0 },
    title: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    lane: { type: 'number', default: -1 },
    notes: { type: 'string', default: '' },
  },
});

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

type TableId = 'users' | 'tasks';
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

export const deleteTask = (id: string) => commit('Delete task', [['tasks', id]], () => store.delRow('tasks', id));

export const createUser = (name: string): string => {
  const id = newId();
  const order = Math.max(-1, ...store.getRowIds('users').map((u) => getUser(u)!.order)) + 1;
  const color = PALETTE[order % PALETTE.length]!;
  commit('Add person', [['users', id]], () => store.setRow('users', id, { name, color, order }));
  return id;
};

/** Apply an import plan as one undoable command. */
export const applyImport = (plan: {
  people: { key: string; name: string; email: string; existingId?: string }[];
  tasks: { id: string; personKey: string; start: number; end: number; title: string; color: string; notes: string }[];
}) => {
  const ids = new Map<string, string>();
  let order = Math.max(-1, ...store.getRowIds('users').map((u) => getUser(u)!.order)) + 1;
  const touches: [TableId, string][] = [];
  for (const p of plan.people) {
    const id = p.existingId ?? newId();
    ids.set(p.key, id);
    touches.push(['users', id]);
  }
  for (const t of plan.tasks) touches.push(['tasks', t.id]);
  commit(`Import ${plan.tasks.length} tasks`, touches, () => {
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
      });
    }
  });
  return { people: plan.people.filter((p) => !p.existingId).length, tasks: plan.tasks.length };
};

export const renameUser = (id: string, name: string) =>
  commit('Rename person', [['users', id]], () => store.setCell('users', id, 'name', name));
