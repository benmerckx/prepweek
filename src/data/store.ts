import { createMergeableStore, type Row } from 'tinybase';
import { isRule, occurrenceStart, parseSkip, splitOccurrence } from '../lib/recur.ts';
import { isWeekend } from '../lib/dates.ts';

// One MergeableStore per "sheet". It is a CRDT (hybrid logical clocks per
// cell), so local edits, other tabs and a Cloudflare Durable Object can all
// merge deterministically. See ./sync.ts for the wiring.

// Ten hues spread around the wheel, clear but not loud. Blocks draw them at
// one depth under white text (see .task in styles.css).
export const PALETTE = [
  '#3b6fd4', '#2a9a6a', '#d9473f', '#d69a1f', '#8452d6',
  '#1d98ab', '#d2448d', '#737089', '#6e9b26', '#e2692a',
] as const;
/** Earlier palettes, in the same order (sheets get the current colors). */
const OLD_PALETTES = [
  ['#4f7cff', '#22a06b', '#e5484d', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b', '#84cc16', '#f97316'],
  ['#3b7bff', '#20b55c', '#f04438', '#f5b301', '#9b5cff', '#0fc2d8', '#f72585', '#6b7c93', '#8ccf12', '#ff7b1c'],
  ['#3f6fb5', '#3a8a5f', '#c4513a', '#c9952f', '#7d5bb5', '#2b8a96', '#c2527d', '#7a7268', '#6f8f2f', '#cf6a2e'],
];

export type UserRow = { name: string; color: string; order: number; email: string; team?: string; avatar?: string };
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
  /** Recurrence rule ('' = none), see lib/recur.ts. */
  repeat?: string;
  /** Fill pattern ('' = solid), see PATTERNS. */
  pattern?: string;
  /** Finished. */
  done?: boolean;
  /** Time of day for short tasks, e.g. "10:30–11:00" ('' = all day). */
  time?: string;
  /** Last day an occurrence may start on (0 = open-ended). */
  repeatUntil?: number;
  /** Comma-separated occurrence numbers that were deleted or detached. */
  skip?: string;
  /**
   * One task for several people is a row per person, linked by this id (the
   * first row's): content and dates are shared, comments and files too.
   */
  group?: string;
  /** '' = work, 'off' = time off (holiday, leave, sick): not counted as booked. */
  kind?: string;
};

export const store = createMergeableStore();

store.setTablesSchema({
  users: {
    name: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    order: { type: 'number', default: 0 },
    email: { type: 'string', default: '' },
    team: { type: 'string', default: '' },
    /** Profile picture URL, from the account tied to this row (see identity.ts). */
    avatar: { type: 'string', default: '' },
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
    repeat: { type: 'string', default: '' },
    pattern: { type: 'string', default: '' },
    done: { type: 'boolean', default: false },
    time: { type: 'string', default: '' },
    repeatUntil: { type: 'number', default: 0 },
    skip: { type: 'string', default: '' },
    group: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },
  },
  // Projects group tasks across people; a client groups projects.
  // `client` is the client's name as text (from before clients were their
  // own rows); `clientId` wins when set, see migrateClients.
  projects: {
    name: { type: 'string', default: '' },
    client: { type: 'string', default: '' },
    clientId: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    archived: { type: 'boolean', default: false },
    /** Markdown, like task notes. */
    notes: { type: 'string', default: '' },
    /** Block pattern for its tasks ('' = solid). */
    pattern: { type: 'string', default: '' },
  },
  clients: {
    name: { type: 'string', default: '' },
    color: { type: 'string', default: PALETTE[0] },
    archived: { type: 'boolean', default: false },
    notes: { type: 'string', default: '' },
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
    color: { type: 'string', default: '#9b5cff' },
    /** A day off for everyone (a public holiday): nobody is booked on it. */
    off: { type: 'boolean', default: false },
  },
  // "B waits for A": `to` can't start before `from` ends. Both are threads
  // (a task for several people is one thread), see threadOf.
  links: {
    from: { type: 'string', default: '' },
    to: { type: 'string', default: '' },
  },
  // Checklist items on a task (its thread).
  checks: {
    taskId: { type: 'string', default: '' },
    text: { type: 'string', default: '' },
    done: { type: 'boolean', default: false },
    order: { type: 'number', default: 0 },
  },
  // Who changed what, newest last. Written with each local command.
  activity: {
    at: { type: 'number', default: 0 },
    by: { type: 'string', default: '' }, // display name
    byId: { type: 'string', default: '' }, // person on this sheet, if linked
    label: { type: 'string', default: '' }, // "Move task"
    taskId: { type: 'string', default: '' },
    title: { type: 'string', default: '' }, // task title at the time
    owner: { type: 'string', default: '' }, // person the task belongs to
  },
  // Comments on a task (series id for recurring tasks).
  comments: {
    taskId: { type: 'string', default: '' },
    at: { type: 'number', default: 0 },
    by: { type: 'string', default: '' },
    byId: { type: 'string', default: '' },
    text: { type: 'string', default: '' },
    mentions: { type: 'string', default: '' }, // comma-separated person ids
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

export type ProjectRow = { name: string; client: string; clientId: string; color: string; archived: boolean; notes: string; pattern: string };
export type ClientRow = { name: string; color: string; archived: boolean; notes: string };
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

export type MilestoneRow = { day: number; title: string; color: string; off?: boolean };
export type LinkRow = { from: string; to: string };
export type CheckRow = { taskId: string; text: string; done: boolean; order: number };
export type AttachmentRow = {
  taskId: string;
  kind: 'file' | 'link';
  name: string;
  url: string;
  mime: string;
  size: number;
  created: number;
};

/** Optional fills for blocks, drawn in the block's own color. */
export const PATTERNS = ['dots', 'stripes', 'zigzag', 'waves', 'triangles', 'rings'] as const;

/** First is the default; not red, so milestones don't read as "today". */
export const MILESTONE_COLORS = ['#8452d6', '#3b6fd4', '#1d98ab', '#2a9a6a', '#d69a1f', '#d9473f', '#d2448d', '#737089'] as const;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 16 random base62 chars (~95 bits); works outside secure contexts too. */
export const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % 62];
  return id;
};

const NOT_RECURRING = { repeat: '', repeatUntil: 0, skip: '' };

/**
 * A task by id. For an occurrence of a recurring task (`id~n`) this is the
 * series' content on that occurrence's dates, as a one-off task.
 */
export const getTask = (id: string): TaskRow | undefined => {
  const { base, n } = splitOccurrence(id);
  if (!store.hasRow('tasks', base)) return undefined;
  const row = store.getRow('tasks', base) as TaskRow;
  if (n === 0) return row;
  if (!isRule(row.repeat)) return undefined;
  const start = occurrenceStart(row.start, row.repeat, n);
  return { ...row, ...NOT_RECURRING, start, end: start + (row.end - row.start) };
};

/** The rows of a task assigned to several people (just itself otherwise). */
export const groupMembers = (id: string): string[] => {
  const { base } = splitOccurrence(id);
  if (!store.hasRow('tasks', base)) return [];
  const g = store.getCell('tasks', base, 'group') as string;
  return g ? store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'group') === g) : [base];
};
/** Where a task's comments and files live: shared by everyone it's assigned to. */
export const threadOf = (id: string): string => {
  const { base } = splitOccurrence(id);
  return (store.getCell('tasks', base, 'group') as string) || base;
};

/** True for an occurrence id (`id~n`, n > 0). */
export const isOccurrence = (id: string) => splitOccurrence(id).n > 0;

export const getUser = (id: string): UserRow | undefined =>
  store.hasRow('users', id) ? (store.getRow('users', id) as UserRow) : undefined;

// --- Who is editing, and the activity log -------------------------------------

/** The local editor: a display name, optionally linked to a person row. */
let actor = { name: '', id: '' };
export const setActor = (a: { name: string; id: string }) => (actor = a);
export const getActor = () => actor;

// The log is a ring per device: entries reuse ids (`<device>~<n % SLOTS>`),
// so it stays bounded without deleting rows. A deleted row isn't gone in a
// mergeable store (it stays as a tombstone, synced and stored for good), and
// trimming the oldest entries used to cost writes and free nothing.
const ACTIVITY_SLOTS = 400;
const nextActivityId = (() => {
  let device = '';
  let n = Math.floor(Math.random() * ACTIVITY_SLOTS);
  try {
    device = localStorage.getItem('prepweek:device') ?? '';
    if (!device) localStorage.setItem('prepweek:device', (device = newId()));
  } catch {}
  device ||= newId();
  return () => {
    try {
      // Read each time: other tabs on this device share the counter.
      n = Number(localStorage.getItem('prepweek:activity-n')) || n;
    } catch {}
    n = (n + 1) % ACTIVITY_SLOTS;
    try {
      localStorage.setItem('prepweek:activity-n', String(n));
    } catch {}
    return `${device}~${n}`;
  };
})();
const MERGE_MS = 2 * 60_000;
let lastLog: { id: string; key: string; at: number } | null = null;

/**
 * Record a command in the activity table. Repeats of the same command on the
 * same task by the same person within two minutes (nudging a block around)
 * update one entry instead of adding many.
 */
function logActivity(label: string, before: Snap[], after: Snap[]) {
  const i = after.findIndex((s) => s.table === 'tasks');
  const j = i >= 0 ? i : after.findIndex((s) => s.table === 'comments');
  let taskId = '';
  let row: Row | null = null;
  if (i >= 0 && after.filter((s) => s.table === 'tasks').length === 1) {
    taskId = after[i]!.id;
    row = after[i]!.row ?? before[i]!.row;
  } else if (j >= 0) {
    taskId = ((after[j]!.row ?? before[j]!.row)?.taskId as string) ?? '';
    row = taskId && store.hasRow('tasks', taskId) ? store.getRow('tasks', taskId) : null;
  }
  const now = Date.now();
  const key = `${label}|${taskId}|${actor.name}`;
  if (lastLog && lastLog.key === key && now - lastLog.at < MERGE_MS && store.hasRow('activity', lastLog.id)) {
    store.setCell('activity', lastLog.id, 'at', now);
    lastLog.at = now;
    return;
  }
  const id = nextActivityId();
  store.setRow('activity', id, {
    at: now,
    by: actor.name,
    byId: actor.id,
    label,
    taskId,
    title: (row?.title as string) ?? '',
    owner: (row?.userId as string) ?? '',
  });
  lastLog = { id, key, at: now };
}

// --- Comments ---

export type CommentRow = { taskId: string; at: number; by: string; byId: string; text: string; mentions: string };

/** People @mentioned in a comment, by matching "@Full Name" (longest first). */
export const findMentions = (text: string): string[] => {
  const lower = text.toLowerCase();
  const out: string[] = [];
  const users = store.getRowIds('users').map((id) => ({ id, name: (store.getCell('users', id, 'name') as string).toLowerCase() }));
  users.sort((a, b) => b.name.length - a.name.length);
  for (const u of users) if (u.name && lower.includes(`@${u.name}`)) out.push(u.id);
  return out;
};

export const addComment = (taskId: string, text: string): string => {
  const id = newId();
  commit('Comment', [['comments', id]], () =>
    store.setRow('comments', id, { taskId, at: Date.now(), by: actor.name, byId: actor.id, text, mentions: findMentions(text).join(',') }),
  );
  return id;
};
export const deleteComment = (id: string) => commit('Delete comment', [['comments', id]], () => store.delRow('comments', id));

// --- Undo / redo -----------------------------------------------------------
//
// We deliberately don't use TinyBase Checkpoints here: those would also undo
// changes that arrived from other collaborators. Instead each local command
// records the cells it changed, and undo only restores those cells.

type TableId = 'users' | 'tasks' | 'milestones' | 'attachments' | 'projects' | 'clients' | 'views' | 'comments' | 'links' | 'checks';
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
/** View-only sheets: every local command is refused here, in one place. */
let readOnly = false;
export const setReadOnly = (v: boolean) => (readOnly = v);
export const isReadOnly = () => readOnly;

export const commit = (label: string, touches: [TableId, string][], mutate: () => void) => {
  if (readOnly) return;
  const before = touches.map(([t, id]) => snap(t, id));
  let after: Snap[] = [];
  let changed = false;
  // The change and its activity entry sync as one transaction.
  store.transaction(() => {
    mutate();
    after = touches.map(([t, id]) => snap(t, id));
    changed = before.some((b, i) => JSON.stringify(b.row) !== JSON.stringify(after[i]!.row));
    // A blank new task isn't news yet: its first edit is.
    const blank = label === 'Create task' && after[0]?.row?.title === '';
    if (changed && !blank) logActivity(label, before, after);
  });
  if (!changed) return;
  undoStack.push({ label, before, after });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  emitHistory();
};

/**
 * Take back a task made by a click that was then left as it was (a stray
 * click on empty space), with its undo step: as if it never happened.
 */
export const discardNewTask = (id: string) => {
  const top = undoStack.at(-1);
  if (top?.label !== 'Create task' || top.after[0]?.id !== id || !store.hasRow('tasks', id)) return;
  if (JSON.stringify(store.getRow('tasks', id)) !== JSON.stringify(top.after[0].row)) return;
  if (attachmentsOf(id).length || store.getRowIds('comments').some((c) => store.getCell('comments', c, 'taskId') === id)) return;
  undoStack.pop();
  store.delRow('tasks', id);
  emitHistory();
};

/** Let the browser paint (and handle input) between chunks of work. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

/**
 * Like `commit`, for big changes (imports): the mutation runs as several
 * transactions with a frame in between, so the page stays responsive and can
 * show progress. It is still one undo step and one activity entry.
 */
export const commitInChunks = async (
  label: string,
  touches: [TableId, string][],
  steps: (() => void)[],
  onProgress?: (done: number) => void,
) => {
  if (readOnly) return;
  const before = touches.map(([t, id]) => snap(t, id));
  for (let i = 0; i < steps.length; i++) {
    store.transaction(steps[i]!);
    onProgress?.((i + 1) / steps.length);
    await nextFrame();
  }
  const after = touches.map(([t, id]) => snap(t, id));
  if (!before.some((b, i) => JSON.stringify(b.row) !== JSON.stringify(after[i]!.row))) return;
  store.transaction(() => logActivity(label, before, after));
  undoStack.push({ label, before, after });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  emitHistory();
};

/** Rows written per transaction by chunked commands (~0.2 ms each). */
const CHUNK_ROWS = 250;
const chunks = <T,>(items: T[], size = CHUNK_ROWS): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** A big undo/redo is running in chunks; further ones wait for it. */
let historyBusy = false;
export const isHistoryBusy = () => historyBusy;

const replay = async (snaps: Snap[], other: Snap[], label: string) => {
  if (snaps.length <= CHUNK_ROWS) {
    store.transaction(() => {
      restore(snaps, other);
      logActivity(label, other, snaps);
    });
    return;
  }
  // Large (an import): restore in chunks so the page keeps responding.
  historyBusy = true;
  emitHistory();
  try {
    for (let i = 0; i < snaps.length; i += CHUNK_ROWS) {
      restore(snaps.slice(i, i + CHUNK_ROWS), other.slice(i, i + CHUNK_ROWS));
      await nextFrame();
    }
    store.transaction(() => logActivity(label, other, snaps));
  } finally {
    historyBusy = false;
  }
};

export const undo = async () => {
  if (readOnly || historyBusy) return;
  const e = undoStack.pop();
  if (!e) return;
  await replay(e.before, e.after, `Undo: ${e.label}`);
  redoStack.push(e);
  emitHistory();
};

export const redo = async () => {
  if (readOnly || historyBusy) return;
  const e = redoStack.pop();
  if (!e) return;
  await replay(e.after, e.before, `Redo: ${e.label}`);
  undoStack.push(e);
  emitHistory();
};

// --- Commands ---------------------------------------------------------------

const PLACEMENT = ['start', 'end', 'userId', 'lane'] as const;

/**
 * Edit a task; returns the id the edited task has afterwards.
 *
 * On an occurrence of a series, content edits (title, color, project…)
 * apply to the whole series, while moving or resizing it detaches it: it
 * becomes a task of its own and the series skips that date.
 */
export const updateTask = (id: string, patch: Partial<TaskRow>, label = 'Edit task'): string => {
  const { base, n } = splitOccurrence(id);
  if (n > 0) {
    if (!PLACEMENT.some((k) => k in patch)) return updateTask(base, patch, label), id;
    const occ = getTask(id);
    if (!occ) return id;
    const nid = newId();
    const placed: Partial<TaskRow> = {};
    for (const k of PLACEMENT) if (k in patch) (placed as Record<string, unknown>)[k] = patch[k];
    commit(label, [['tasks', base], ['tasks', nid]], () => {
      const skip = parseSkip(store.getCell('tasks', base, 'skip') as string);
      skip.add(n);
      store.setCell('tasks', base, 'skip', [...skip].sort((a, b) => a - b).join(','));
      store.setRow('tasks', nid, { ...occ, ...patch, ...placed, ...NOT_RECURRING } as Row);
    });
    return nid;
  }
  // Assigned to several people: everything but whose row it is (and where
  // in that row) applies to all of them.
  const shared = Object.entries(patch).filter(([k]) => k !== 'userId' && k !== 'lane' && k !== 'group');
  const others = shared.length ? groupMembers(id).filter((t) => t !== id) : [];
  // Work that waits for this task moves along when it would now start too early.
  const moves = new Map<string, { start: number; end: number }>();
  if ('start' in patch || 'end' in patch) {
    const end = Math.max(patch.start ?? (store.getCell('tasks', id, 'start') as number), patch.end ?? (store.getCell('tasks', id, 'end') as number));
    pushDependents(threadOf(id), end, moves);
  }
  const moved = [...moves.keys()].filter((t) => t !== id && !others.includes(t));
  commit(label, [id, ...others, ...moved].map((t) => ['tasks', t] as [TableId, string]), () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('tasks', id, k, v as string | number);
    for (const t of others) for (const [k, v] of shared) store.setCell('tasks', t, k, v as string | number);
    for (const t of moved) {
      store.setCell('tasks', t, 'start', moves.get(t)!.start);
      store.setCell('tasks', t, 'end', moves.get(t)!.end);
    }
  });
  return id;
};

// --- Dependencies ---------------------------------------------------------------

/** Link rows as {id, from, to}. */
export const allLinks = (): (LinkRow & { id: string })[] =>
  store.getRowIds('links').map((id) => ({ id, ...(store.getRow('links', id) as LinkRow) }));

/** Threads `thread` waits for, and threads waiting for it. */
export const linksOf = (thread: string) => {
  const links = allLinks();
  return { waitsFor: links.filter((l) => l.to === thread), blocking: links.filter((l) => l.from === thread) };
};

const rowDates = (t: string) => {
  const a = store.getCell('tasks', t, 'start') as number;
  const b = store.getCell('tasks', t, 'end') as number;
  return { start: Math.min(a, b), end: Math.max(a, b) };
};

/**
 * Plan the moves that keep "waits for" true once `thread` ends on `end`:
 * every task waiting for it that starts on or before that day moves to the
 * next day (the next workday, for work that starts on workdays), keeping its
 * length, and so on down the chain.
 */
const pushDependents = (thread: string, end: number, moves: Map<string, { start: number; end: number }>, depth = 0) => {
  if (depth > 50) return;
  for (const l of allLinks()) {
    if (l.from !== thread) continue;
    let latest = -Infinity;
    for (const t of groupMembers(l.to)) {
      const cur = moves.get(t) ?? rowDates(t);
      if (cur.start > end) continue;
      let start = end + 1;
      if (!isWeekend(cur.start)) while (isWeekend(start)) start++;
      const next = { start, end: cur.end + (start - cur.start) };
      moves.set(t, next);
      latest = Math.max(latest, next.end);
    }
    if (latest > -Infinity) pushDependents(l.to, latest, moves, depth + 1);
  }
};

/** Would `from` → `to` close a loop (to already leads back to from)? */
const leadsTo = (a: string, b: string, seen = new Set<string>()): boolean => {
  if (a === b) return true;
  if (seen.has(a)) return false;
  seen.add(a);
  return allLinks().some((l) => l.from === a && leadsTo(l.to, b, seen));
};

/**
 * `to` waits for `from` (both task ids; links are kept between threads).
 * The waiting task moves after the other one if it starts too early.
 * Returns why it can't be linked, or ''.
 */
export const addLink = (fromId: string, toId: string): string => {
  const from = threadOf(fromId);
  const to = threadOf(toId);
  if (from === to) return 'A task can’t wait for itself';
  if (allLinks().some((l) => l.from === from && l.to === to)) return '';
  if (leadsTo(to, from)) return 'That would make them wait for each other';
  const id = newId();
  const moves = new Map<string, { start: number; end: number }>();
  const end = Math.max(...groupMembers(from).map((t) => rowDates(t).end));
  // The waiting task (and what waits for it in turn) moves if it starts too early.
  for (const t of groupMembers(to)) {
    const cur = rowDates(t);
    if (cur.start > end) continue;
    let start = end + 1;
    if (!isWeekend(cur.start)) while (isWeekend(start)) start++;
    moves.set(t, { start, end: cur.end + (start - cur.start) });
  }
  if (moves.size) pushDependents(to, Math.max(...[...moves.values()].map((m) => m.end)), moves);
  commit('Add dependency', [['links', id], ...[...moves.keys()].map((t) => ['tasks', t] as [TableId, string])], () => {
    store.setRow('links', id, { from, to });
    for (const [t, m] of moves) {
      store.setCell('tasks', t, 'start', m.start);
      store.setCell('tasks', t, 'end', m.end);
    }
  });
  return '';
};

export const removeLink = (id: string) => commit('Remove dependency', [['links', id]], () => store.delRow('links', id));

// --- Checklists ---------------------------------------------------------------------

export const checksOf = (thread: string): (CheckRow & { id: string })[] =>
  store
    .getRowIds('checks')
    .filter((c) => store.getCell('checks', c, 'taskId') === thread)
    .map((id) => ({ id, ...(store.getRow('checks', id) as CheckRow) }))
    .sort((a, b) => a.order - b.order);

export const addCheck = (thread: string, text: string): string => {
  const id = newId();
  const order = Math.max(0, ...checksOf(thread).map((c) => c.order + 1));
  commit('Add checklist item', [['checks', id]], () => store.setRow('checks', id, { taskId: thread, text: text.trim(), done: false, order }));
  return id;
};
export const updateCheck = (id: string, patch: Partial<CheckRow>, label = 'Edit checklist item') =>
  commit(label, [['checks', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('checks', id, k, v as string | number | boolean);
  });
export const deleteCheck = (id: string) => commit('Delete checklist item', [['checks', id]], () => store.delRow('checks', id));

/** A new task stands alone (a duplicate doesn't join the original's people). */
export const createTask = (task: TaskRow, id = newId()): string => {
  commit('Create task', [['tasks', id]], () => store.setRow('tasks', id, { ...task, group: '' } as Row));
  return id;
};

/**
 * Who a task is assigned to: a row per person, linked as one task. Returns
 * the id to keep showing (the given one, unless its person was removed).
 */
export const setAssignees = (id: string, userIds: string[]): string => {
  const { base } = splitOccurrence(id);
  const want = [...new Set(userIds.filter(Boolean))];
  if (!store.hasRow('tasks', base) || !want.length) return id;
  const row = store.getRow('tasks', base) as TaskRow;
  const lead = row.group || base;
  const members = groupMembers(base);
  const byUser = new Map(members.map((t) => [store.getCell('tasks', t, 'userId') as string, t]));
  const drop = members.filter((t) => !want.includes(store.getCell('tasks', t, 'userId') as string));
  const added = want.filter((u) => !byUser.has(u)).map((u) => [u, newId()] as const);
  const kept = members.filter((t) => !drop.includes(t)).concat(added.map(([, t]) => t));
  if (!drop.length && !added.length) return id;
  const label = added.length && !drop.length ? 'Add person' : drop.length && !added.length ? 'Remove person' : 'Change people';
  commit(label, [...members, ...added.map(([, t]) => t)].map((t) => ['tasks', t] as [TableId, string]), () => {
    for (const t of drop) store.delRow('tasks', t);
    for (const [u, t] of added) store.setRow('tasks', t, { ...row, userId: u, lane: -1, group: lead } as Row);
    for (const t of kept) store.setCell('tasks', t, 'group', lead);
  });
  return kept.includes(base) ? id : kept[0]!;
};

export const attachmentsOf = (taskId: string): string[] =>
  store.getRowIds('attachments').filter((a) => store.getCell('attachments', a, 'taskId') === taskId);

/**
 * Deleting a task also removes its attachments (one undo step). For a
 * recurring task, 'one' removes just this occurrence (the series skips it)
 * and 'series' removes them all.
 */
export const deleteTask = (id: string, scope: 'one' | 'series' = 'one') => {
  const { base, n } = splitOccurrence(id);
  const row = store.hasRow('tasks', base) ? (store.getRow('tasks', base) as TaskRow) : undefined;
  // A task for several people goes for all of them.
  const members = groupMembers(base);
  if (row && isRule(row.repeat) && scope === 'one') {
    commit('Delete occurrence', members.map((t) => ['tasks', t] as [TableId, string]), () => {
      for (const t of members) {
        const skip = parseSkip(store.getCell('tasks', t, 'skip') as string);
        skip.add(n);
        store.setCell('tasks', t, 'skip', [...skip].sort((a, b) => a - b).join(','));
      }
    });
    return;
  }
  const thread = threadOf(base);
  const atts = attachmentsOf(thread);
  const links = allLinks().filter((l) => l.from === thread || l.to === thread).map((l) => l.id);
  const checks = checksOf(thread).map((c) => c.id);
  const touched = [
    ...members.map((t) => ['tasks', t] as [TableId, string]),
    ...atts.map((a) => ['attachments', a] as [TableId, string]),
    ...links.map((l) => ['links', l] as [TableId, string]),
    ...checks.map((c) => ['checks', c] as [TableId, string]),
  ];
  commit('Delete task', touched, () => {
    for (const t of members) store.delRow('tasks', t);
    for (const a of atts) store.delRow('attachments', a);
    for (const l of links) store.delRow('links', l);
    for (const c of checks) store.delRow('checks', c);
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
  const { client = '', ...rest } = p;
  const cid = client.trim() ? clientIdFor(client) : '';
  // A pattern of its own, so projects of the same color still tell apart.
  const pattern = p.pattern ?? PATTERNS[Math.floor(Math.random() * PATTERNS.length)]!;
  commit('Add project', [['projects', id], ...(cid ? [['clients', cid] as [TableId, string]] : [])], () => {
    if (cid) ensureClient(cid, client.trim());
    store.setRow('projects', id, { client: client.trim(), clientId: cid, archived: false, notes: '', ...rest, color, pattern });
  });
  return id;
};
export const updateProject = (id: string, patch: Partial<ProjectRow>, label = 'Edit project') =>
  commit(label, [['projects', id]], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('projects', id, k, v as string | number | boolean);
  });
/** Give a project a client by name (created when new); '' removes it. */
export const setProjectClient = (projectId: string, name: string) => {
  name = name.trim();
  const cid = name ? clientIdFor(name) : '';
  commit(name ? 'Set client' : 'Remove client', [['projects', projectId], ...(cid ? [['clients', cid] as [TableId, string]] : [])], () => {
    if (cid) ensureClient(cid, name);
    store.setCell('projects', projectId, 'clientId', cid);
    store.setCell('projects', projectId, 'client', cid ? (store.getCell('clients', cid, 'name') as string) : '');
  });
};
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

// --- Clients ---

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
/**
 * The client called `name`: an existing one (case-insensitive), else an id
 * derived from the name, so two devices adding "Imec" at once agree.
 */
export const clientIdFor = (name: string): string => {
  const n = name.trim().toLowerCase();
  for (const id of store.getRowIds('clients')) if ((store.getCell('clients', id, 'name') as string).trim().toLowerCase() === n) return id;
  const id = `c${fnv(n)}`;
  // That id belongs to a client since renamed: don't merge into it.
  return store.hasRow('clients', id) ? newId() : id;
};
/** Inside a transaction: make sure client `id` exists. */
const ensureClient = (id: string, name: string) => {
  if (store.hasRow('clients', id)) return;
  store.setRow('clients', id, { name, color: PALETTE[store.getRowCount('clients') % PALETTE.length]!, archived: false, notes: '' });
};
export const createClient = (name: string): string => {
  const id = clientIdFor(name);
  commit('Add client', [['clients', id]], () => ensureClient(id, name.trim()));
  return id;
};
export const updateClient = (id: string, patch: Partial<ClientRow>, label = 'Edit client') => {
  const projects = patch.name !== undefined ? store.getRowIds('projects').filter((p) => store.getCell('projects', p, 'clientId') === id) : [];
  commit(label, [['clients', id], ...projects.map((p) => ['projects', p] as [TableId, string])], () => {
    for (const [k, v] of Object.entries(patch)) store.setCell('clients', id, k, v as string | number | boolean);
    // Keep the text copy on projects in step (older versions read it).
    for (const p of projects) store.setCell('projects', p, 'client', patch.name!);
  });
};
/** Deleting a client keeps its projects, just without a client. */
export const deleteClient = (id: string) => {
  const projects = store.getRowIds('projects').filter((p) => store.getCell('projects', p, 'clientId') === id);
  commit('Delete client', [['clients', id], ...projects.map((p) => ['projects', p] as [TableId, string])], () => {
    store.delRow('clients', id);
    for (const p of projects) {
      store.setCell('projects', p, 'clientId', '');
      store.setCell('projects', p, 'client', '');
    }
  });
};
/**
 * Projects from before clients were rows name their client as text: give
 * each such name a client row and link it. Idempotent and not an undo step.
 */
export const migrateClients = () => {
  const todo = store.getRowIds('projects').filter((p) => !store.getCell('projects', p, 'clientId') && (store.getCell('projects', p, 'client') as string)?.trim());
  if (!todo.length) return;
  store.transaction(() => {
    for (const p of todo) {
      const name = (store.getCell('projects', p, 'client') as string).trim();
      const id = clientIdFor(name);
      ensureClient(id, name);
      store.setCell('projects', p, 'clientId', id);
    }
  });
};

/**
 * Colors from the previous palette become their new counterpart: now for
 * what's on this device, and later for whatever an older version (or the
 * server) still brings in. Not an undo step or an activity entry.
 */
export const migrateColors = () => {
  const next = new Map(OLD_PALETTES.flatMap((old) => old.map((c, i) => [c, PALETTE[i]!] as const)));
  // The old milestone indigo.
  next.set('#4f5bd5', PALETTE[0]);
  const fix = (table: 'tasks' | 'projects' | 'users' | 'milestones', id: string) => {
    const c = store.getCell(table, id, 'color');
    const to = typeof c === 'string' ? next.get(c.toLowerCase()) : undefined;
    if (to) store.setCell(table, id, 'color', to);
  };
  const tables = ['tasks', 'projects', 'users', 'milestones'] as const;
  store.transaction(() => {
    for (const t of tables) for (const id of store.getRowIds(t)) fix(t, id);
  });
  // Fixed after the change that brought them in (not inside its transaction).
  const pending: [(typeof tables)[number], string][] = [];
  const flush = () =>
    store.transaction(() => {
      for (const [t, id] of pending.splice(0)) fix(t, id);
    });
  for (const t of tables)
    store.addCellListener(t, null, 'color', (_, __, rowId, ___, color) => {
      if (typeof color !== 'string' || !next.has(color.toLowerCase())) return;
      if (!pending.length) setTimeout(flush);
      pending.push([t, rowId]);
    });
};

/** Give a project and every task in it a pattern, in one step. */
export const repatternProject = (id: string, pattern: string) => {
  const tasks = store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'projectId') === id);
  commit(pattern ? 'Set project pattern' : 'Remove project pattern', [['projects', id], ...tasks.map((t) => ['tasks', t] as [TableId, string])], () => {
    store.setCell('projects', id, 'pattern', pattern);
    for (const t of tasks) store.setCell('tasks', t, 'pattern', pattern);
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
export const applyImport = async (
  plan: {
    people: { key: string; name: string; email: string; existingId?: string }[];
    tasks: {
      id: string;
      personKey: string;
      start: number;
      end: number;
      title: string;
      color: string;
      notes: string;
      project?: string;
      client?: string;
      tags?: string;
      done?: boolean;
      time?: string;
      links?: string[];
      repeat?: string;
      repeatUntil?: number;
      group?: string;
      kind?: string;
    }[];
  },
  mode: ImportMode = 'add',
  onProgress?: (done: number) => void,
) => {
  const ids = new Map<string, string>();
  const replace = mode === 'replace';
  // Rows the file brings again are overwritten, not deleted and re-added
  // (that wrote each one twice, and leaves a tombstone).
  const kept = new Set([
    ...plan.people.flatMap((p) => (p.existingId ? [`users/${p.existingId}`] : [])),
    ...plan.tasks.map((t) => `tasks/${t.id}`),
    ...plan.tasks.flatMap((t) => (t.links ?? []).map((_, i) => `attachments/${t.id}-a${i}`)),
  ]);
  const removed: [TableId, string][] = replace
    ? (['users', 'tasks', 'attachments'] as const).flatMap((table) =>
        store
          .getRowIds(table)
          .filter((id) => !kept.has(`${table}/${id}`))
          .map((id) => [table, id] as [TableId, string]),
      )
    : [];
  // Projects are matched by name (case-insensitive) and created if missing.
  // They are never removed by 'replace', like milestones.
  const projectIds = new Map<string, string>();
  for (const id of store.getRowIds('projects')) projectIds.set((store.getCell('projects', id, 'name') as string).toLowerCase(), id);
  const newProjects: { id: string; name: string; color: string; client: string }[] = [];
  /** Existing projects that get a client from the file. */
  const clientFor = new Map<string, string>();
  for (const t of plan.tasks) {
    const name = t.project?.trim();
    if (!name) continue;
    const known = projectIds.get(name.toLowerCase());
    if (known) {
      if (t.client && !store.getCell('projects', known, 'client') && !store.getCell('projects', known, 'clientId')) clientFor.set(known, t.client);
      continue;
    }
    const id = newId();
    projectIds.set(name.toLowerCase(), id);
    newProjects.push({ id, name, color: t.color, client: t.client ?? '' });
  }
  // Attachment links become link attachments (ids derived from the task, so
  // a re-import doesn't add them twice).
  const links = plan.tasks.flatMap((t) =>
    (t.links ?? []).map((url, i) => ({ id: `${t.id}-a${i}`, taskId: t.id, url, name: decodeURIComponent(url.split('/').pop() || url) })),
  );
  let order = replace ? 0 : Math.max(-1, ...store.getRowIds('users').map((u) => getUser(u)!.order)) + 1;
  const touches: [TableId, string][] = [...removed];
  for (const p of plan.people) {
    const id = p.existingId ?? newId();
    ids.set(p.key, id);
    touches.push(['users', id]);
  }
  for (const t of plan.tasks) touches.push(['tasks', t.id]);
  for (const p of newProjects) touches.push(['projects', p.id]);
  for (const id of clientFor.keys()) touches.push(['projects', id]);
  // Clients by name, created when missing.
  const clientIds = new Map<string, string>();
  for (const name of [...newProjects.map((p) => p.client), ...clientFor.values()]) {
    const k = name.trim().toLowerCase();
    if (!k || clientIds.has(k)) continue;
    const id = clientIdFor(name);
    clientIds.set(k, id);
    touches.push(['clients', id]);
  }
  const clientId = (name: string) => clientIds.get(name.trim().toLowerCase()) ?? '';
  for (const a of links) touches.push(['attachments', a.id]);
  // Big imports take seconds to write (TinyBase's mergeable store does real
  // work per cell), so they go in chunks with progress instead of freezing.
  const steps: (() => void)[] = [
    ...chunks(removed).map((part) => () => {
      for (const [table, id] of part) store.delRow(table, id);
    }),
    () => {
      for (const [k, id] of clientIds) {
        const name = [...newProjects.map((p) => p.client), ...clientFor.values()].find((n) => n.trim().toLowerCase() === k)!.trim();
        ensureClient(id, name);
      }
      for (const p of newProjects) store.setRow('projects', p.id, { name: p.name, color: p.color, client: p.client, clientId: clientId(p.client), archived: false, notes: '' });
      for (const [id, client] of clientFor) {
        store.setCell('projects', id, 'client', client);
        store.setCell('projects', id, 'clientId', clientId(client));
      }
      for (const p of plan.people) {
        const id = ids.get(p.key)!;
        if (p.existingId) {
          if (p.email && !getUser(id)!.email) store.setCell('users', id, 'email', p.email);
        } else {
          store.setRow('users', id, { name: p.name, email: p.email, color: PALETTE[order % PALETTE.length]!, order });
          order++;
        }
      }
    },
    ...chunks(plan.tasks).map((part) => () => {
      for (const t of part) {
        // Adding again: keep what was done to the task here (its lane,
        // pattern, skipped occurrences). Replacing: the file wins.
        const set = !replace && store.hasRow('tasks', t.id) ? store.setPartialRow : store.setRow;
        set('tasks', t.id, {
          userId: ids.get(t.personKey)!,
          start: t.start,
          end: t.end,
          title: t.title,
          color: t.color,
          notes: t.notes,
          ...(set === store.setRow ? { lane: -1 } : {}),
          projectId: t.project ? (projectIds.get(t.project.trim().toLowerCase()) ?? '') : '',
          tags: joinTags(parseTags(t.tags)),
          done: !!t.done,
          time: t.time ?? '',
          repeat: t.repeat ?? '',
          repeatUntil: t.repeatUntil ?? 0,
          group: t.group ?? '',
          kind: t.kind ?? '',
        });
      }
    }),
    ...chunks(links).map((part) => () => {
      for (const a of part)
        store.setRow('attachments', a.id, {
          taskId: a.taskId,
          kind: 'link',
          name: a.name,
          url: a.url,
          mime: '',
          size: 0,
          created: (store.getCell('attachments', a.id, 'created') as number | undefined) ?? Date.now(),
        });
    }),
  ];
  await commitInChunks(`${replace ? 'Replace with' : 'Import'} ${plan.tasks.length} tasks`, touches, steps, onProgress);
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
