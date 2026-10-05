import type { MergeableStore } from 'tinybase';
import { packLanes, type Cluster, type PackItem } from '../lib/layout.ts';
import type { TaskRow, UserRow } from '../data/store.ts';

// The TimelineModel is a derived, render-ready index over the TinyBase store:
// users in order, each with its tasks sorted by start and packed into lanes,
// plus cumulative row offsets for vertical hit-testing/virtualization.
//
// It recomputes incrementally: only rows whose tasks changed are re-packed,
// and each RowLayout is an immutable object, so React.memo'd rows re-render
// only when their own content changed.

export const LANE_H = 30; // block height + gap
export const BLOCK_H = 26;
export const ROW_PAD = 6;
export const MIN_LANES = 2;
/** Days per render tile. A multiple of 7, so tiles start on Mondays. */
export const CHUNK = 28;

export interface TaskView {
  id: string;
  userId: string;
  start: number;
  end: number;
  title: string;
  color: string;
  notes: string;
  lane: number;
}

export interface RowLayout {
  userId: string;
  name: string;
  color: string;
  tasks: TaskView[]; // sorted by start
  /** Longest task duration in days; bounds the binary search window. */
  maxSpan: number;
  /** Lanes needed by the busiest cluster anywhere in time. */
  laneCount: number;
  /** Overlap clusters in time order, to size the row for a given window. */
  clusters: Cluster[];
  /** Height for the current height window (see setHeightWindow). */
  height: number;
}

/** A transient position for one task (drag/resize/create preview). */
export interface Preview {
  id: string;
  userId: string;
  start: number;
  end: number;
  lane?: number;
  title?: string;
  color?: string;
}

export const rowHeight = (lanes: number) => ROW_PAD * 2 + Math.max(lanes, MIN_LANES) * LANE_H;

/** Max lanes among clusters intersecting [d0, d1]. */
export const lanesIn = (clusters: Cluster[], d0: number, d1: number): number => {
  let lo = 0;
  let hi = clusters.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clusters[mid]!.end < d0) lo = mid + 1;
    else hi = mid;
  }
  let max = 0;
  for (let i = lo; i < clusters.length && clusters[i]!.start <= d1; i++) if (clusters[i]!.lanes > max) max = clusters[i]!.lanes;
  return max;
};

export class TimelineModel {
  rows: RowLayout[] = [];
  rowTops: number[] = [0];
  totalHeight = 0;
  version = 0;

  private rowIndex = new Map<string, number>();
  private byUser = new Map<string, Map<string, TaskView>>();
  private taskUser = new Map<string, string>();
  /** Lane each task had in the last layout (or its stored hint). */
  private prevLane = new Map<string, number>();
  private storedLane = new Map<string, number>();
  private preview: Preview | null = null;
  /**
   * Rows are sized for the lanes needed in this day range (the rendered
   * window), not for the busiest week in all of history. Otherwise one hectic
   * week two years ago would make a row tall everywhere.
   */
  private heightWindow: [number, number] = [-Infinity, Infinity];
  private dirtyUsers = new Set<string>();
  private usersDirty = true;
  private listeners = new Set<() => void>();

  constructor(private store: MergeableStore) {
    for (const id of store.getRowIds('tasks')) this.ingestTask(id);
    this.flush();
    store.addDidFinishTransactionListener(() => {
      const [tables] = store.getTransactionChanges();
      const tasks = tables.tasks;
      if (tasks) for (const id of Object.keys(tasks)) this.ingestTask(id);
      if (tables.users) this.usersDirty = true;
      if (tasks || tables.users) this.flush();
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  getPreview = () => this.preview;

  setPreview(p: Preview | null) {
    const old = this.preview;
    if (old) {
      this.dirtyUsers.add(old.userId);
      const real = this.findTask(old.id);
      if (real) {
        this.dirtyUsers.add(real.userId);
        // A cancelled (or duplicated) drag puts the block back in its lane.
        if (real.lane >= 0 && !p) this.prevLane.set(old.id, real.lane);
      }
    }
    this.preview = p;
    if (p) {
      this.dirtyUsers.add(p.userId);
      const realUser = this.taskUser.get(p.id);
      if (realUser) this.dirtyUsers.add(realUser);
    }
    this.flush();
  }

  /** Called right before committing a drop so the block stays where it landed. */
  rememberLane(taskId: string, lane: number) {
    this.prevLane.set(taskId, lane);
  }

  findTask(id: string): TaskView | undefined {
    const u = this.taskUser.get(id);
    return u ? this.byUser.get(u)?.get(id) : undefined;
  }

  /** Lane of a task in the current layout (including previews). */
  laneOf(id: string): number | undefined {
    return this.prevLane.get(id);
  }

  rowAt(y: number): number {
    // Binary search the cumulative offsets.
    let lo = 0;
    let hi = this.rows.length - 1;
    if (hi < 0) return -1;
    if (y < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rowTops[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  indexOfUser(userId: string) {
    return this.rowIndex.get(userId) ?? -1;
  }

  /** Inclusive day range covered by any task (for the minimap/scroll range). */
  dataExtent(): [number, number] | null {
    let min = Infinity;
    let max = -Infinity;
    for (const row of this.rows) {
      if (row.tasks.length === 0) continue;
      min = Math.min(min, row.tasks[0]!.start);
      for (const t of row.tasks) if (t.end > max) max = t.end;
    }
    return min === Infinity ? null : [min, max];
  }

  private ingestTask(id: string) {
    const oldUser = this.taskUser.get(id);
    if (oldUser) {
      this.byUser.get(oldUser)?.delete(id);
      this.dirtyUsers.add(oldUser);
    }
    if (!this.store.hasRow('tasks', id)) {
      this.taskUser.delete(id);
      this.prevLane.delete(id);
      this.storedLane.delete(id);
      return;
    }
    const r = this.store.getRow('tasks', id) as TaskRow;
    const view: TaskView = {
      id,
      userId: r.userId,
      start: Math.min(r.start, r.end),
      end: Math.max(r.start, r.end),
      title: r.title,
      color: r.color,
      notes: r.notes,
      lane: -1,
    };
    // A changed stored lane hint (local drop or remote collaborator) wins
    // over the previous layout.
    if (r.lane >= 0 && this.storedLane.get(id) !== r.lane) this.prevLane.set(id, r.lane);
    this.storedLane.set(id, r.lane);
    this.taskUser.set(id, r.userId);
    let m = this.byUser.get(r.userId);
    if (!m) this.byUser.set(r.userId, (m = new Map()));
    m.set(id, view);
    this.dirtyUsers.add(r.userId);
  }

  private layoutRow(userId: string, user: UserRow): RowLayout {
    const items: PackItem[] = [];
    const views: TaskView[] = [];
    const p = this.preview;
    for (const t of this.byUser.get(userId)?.values() ?? []) {
      if (p && p.id === t.id) continue;
      views.push(t);
      items.push({ id: t.id, start: t.start, end: t.end, lane: this.prevLane.get(t.id) });
    }
    if (p && p.userId === userId) {
      const base = this.findTask(p.id);
      const v: TaskView = {
        id: p.id,
        userId,
        start: p.start,
        end: p.end,
        title: p.title ?? base?.title ?? '',
        color: p.color ?? base?.color ?? user.color,
        notes: base?.notes ?? '',
        lane: -1,
      };
      views.push(v);
      items.push({ id: v.id, start: v.start, end: v.end, lane: p.lane ?? this.prevLane.get(p.id) });
    }
    const { lanes, laneCount, clusters } = packLanes(items);
    let maxSpan = 0;
    const tasks = views.map((v) => {
      const lane = lanes.get(v.id)!;
      this.prevLane.set(v.id, lane);
      if (v.end - v.start + 1 > maxSpan) maxSpan = v.end - v.start + 1;
      return v.lane === lane ? v : { ...v, lane };
    });
    tasks.sort((a, b) => a.start - b.start || a.lane - b.lane);
    // Keep the canonical view objects in sync so findTask() reports lanes.
    const m = this.byUser.get(userId);
    if (m) for (const t of tasks) if (m.has(t.id) && !(p && p.id === t.id)) m.set(t.id, t);
    const height = rowHeight(lanesIn(clusters, this.heightWindow[0], this.heightWindow[1]));
    return { userId, name: user.name, color: user.color, tasks, maxSpan, laneCount, clusters, height };
  }

  setHeightWindow(d0: number, d1: number) {
    const [a, b] = this.heightWindow;
    if (a === d0 && b === d1) return;
    this.heightWindow = [d0, d1];
    let changed = false;
    this.rows = this.rows.map((r) => {
      const height = rowHeight(lanesIn(r.clusters, d0, d1));
      if (height === r.height) return r;
      changed = true;
      return { ...r, height };
    });
    if (changed) this.finish();
  }

  private flush() {
    let changed = false;
    if (this.usersDirty) {
      this.usersDirty = false;
      const ids = this.store.getRowIds('users');
      const users = ids
        .map((id) => [id, this.store.getRow('users', id) as UserRow] as const)
        .sort((a, b) => a[1].order - b[1].order || a[1].name.localeCompare(b[1].name));
      const old = new Map(this.rows.map((r) => [r.userId, r]));
      this.rows = users.map(([id, u]) => {
        const prev = old.get(id);
        if (prev && !this.dirtyUsers.has(id)) {
          return prev.name === u.name && prev.color === u.color ? prev : { ...prev, name: u.name, color: u.color };
        }
        return this.layoutRow(id, u);
      });
      this.dirtyUsers.clear();
      changed = true;
    } else if (this.dirtyUsers.size) {
      for (const id of this.dirtyUsers) {
        const i = this.rowIndex.get(id);
        if (i === undefined) continue;
        this.rows[i] = this.layoutRow(id, this.store.getRow('users', id) as UserRow);
      }
      this.dirtyUsers.clear();
      changed = true;
    }
    if (changed) this.finish();
  }

  private finish() {
    this.rowIndex = new Map(this.rows.map((r, i) => [r.userId, i]));
    const tops = [0];
    let y = 0;
    for (const r of this.rows) tops.push((y += r.height));
    this.rowTops = tops;
    this.totalHeight = y;
    this.rows = this.rows.slice(); // new identity for subscribers
    this.version++;
    this.listeners.forEach((l) => l());
  }
}

/** Indices [from, to) of tasks in a row that may intersect [d0, d1]. */
export const visibleTasks = (row: RowLayout, d0: number, d1: number): TaskView[] => {
  const ts = row.tasks;
  let lo = 0;
  let hi = ts.length;
  const minStart = d0 - row.maxSpan;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]!.start < minStart) lo = mid + 1;
    else hi = mid;
  }
  const out: TaskView[] = [];
  for (let i = lo; i < ts.length && ts[i]!.start <= d1; i++) if (ts[i]!.end >= d0) out.push(ts[i]!);
  return out;
};
