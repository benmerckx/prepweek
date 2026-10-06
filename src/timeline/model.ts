import type { MergeableStore } from 'tinybase';
import { HORIZON_DAYS, isRule, occurrenceId, occurrences, parseSkip } from '../lib/recur.ts';
import { today, workdays } from '../lib/dates.ts';
import { packLanes, type Cluster, type PackItem } from '../lib/layout.ts';
import { parseTags, type ClientRow, type ProjectRow, type TaskRow, type UserRow } from '../data/store.ts';

// The TimelineModel is a derived, render-ready index over the TinyBase store:
// users in order, each with its tasks sorted by start and packed into lanes,
// plus cumulative row offsets for vertical hit-testing/virtualization.
//
// It recomputes incrementally: only rows whose tasks changed are re-packed,
// and each RowLayout is an immutable object, so React.memo'd rows re-render
// only when their own content changed.

/** Row geometry; 'compact' fits many more people on screen. */
export interface Dims {
  laneH: number; // block height + gap
  blockH: number;
  pad: number;
  minLanes: number;
  /** Height of a team header row. */
  teamH: number;
}
export const COMFORTABLE: Dims = { laneH: 48, blockH: 44, pad: 8, minLanes: 3, teamH: 34 };
export const COMPACT: Dims = { laneH: 30, blockH: 26, pad: 5, minLanes: 3, teamH: 28 };
/** Key prefix of team header rows (can't collide with generated ids). */
export const TEAM_ROW = 'team:';
/** People without a team, when others have one. */
export const NO_TEAM = '';
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
  /** Number of attachments (files + links). */
  files: number;
  /** Number of comments. */
  comments: number;
  projectId: string;
  /** Project name ('' when none), shown on the block. */
  project: string;
  tags: string[];
  /** Recurrence rule of the series this belongs to ('' = one-off). */
  repeat: string;
  /** The stored task id (differs from `id` for occurrences n > 0). */
  series: string;
  /** Fill pattern ('' = solid). */
  pattern: string;
  done: boolean;
  /** "10:30–11:00" for timed tasks, else ''. */
  time: string;
}

export interface Project extends ProjectRow {
  id: string;
}
export interface Client extends ClientRow {
  id: string;
}
/** What's planned for a project (stored tasks; a series counts once). */
export interface ProjectStats {
  tasks: number;
  /** Planned workdays (calendar days for weekend-only tasks). */
  days: number;
  /** Tasks not yet over. */
  upcoming: number;
  first: number;
  last: number;
  people: Set<string>;
}

export interface Milestone {
  id: string;
  day: number;
  title: string;
  color: string;
}

export interface RowLayout {
  /** A person, or a team header above its people. */
  kind: 'person' | 'team';
  /** The person's team; for a header, the team it heads. */
  team: string;
  /** Header only: people in the team, and whether they're hidden. */
  count?: number;
  collapsed?: boolean;
  userId: string;
  name: string;
  color: string;
  /** Profile picture URL ('' = initials). */
  avatar?: string;
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

const EMPTY_ROW = { tasks: [], maxSpan: 0, laneCount: 0, clusters: [], color: '' };

export const rowHeight = (lanes: number, d: Dims) => d.pad * 2 + Math.max(lanes, d.minLanes) * d.laneH;

/** Free lanes every row keeps on top of its busiest stretch near today. */
export const FREE_LANES = 2;
/** "Near today": two months either side. */
const AROUND = 61;

/**
 * Lanes a row needs: its busiest moment within ~4 months around today plus
 * two free lanes (so each person's row is sized to their own workload), and
 * never less than what the rendered window needs to show every block.
 */
const lanesFor = (clusters: Cluster[], d0: number, d1: number, today: number) =>
  Math.max(lanesIn(clusters, d0, d1), lanesIn(clusters, today - AROUND, today + AROUND) + FREE_LANES);

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
  dims: Dims = COMFORTABLE;

  setDims(d: Dims) {
    if (d === this.dims) return;
    this.dims = d;
    this.usersDirty = true;
    const [a, b] = this.heightWindow;
    this.heightWindow = [NaN, NaN]; // force setHeightWindow to recompute
    this.setHeightWindow(a, b);
  }
  /** People shown (not counting team headers). */
  personCount = 0;
  /** Team names in display order (empty when not grouped). */
  teams: string[] = [];
  private collapsed = new Set<string>();
  isCollapsed = (team: string) => this.collapsed.has(team);
  setCollapsed(teams: Iterable<string>) {
    this.collapsed = new Set(teams);
    this.usersDirty = true;
    this.flush();
  }

  /** Every person id in display order: grouped by team, collapsed included. */
  displayOrder(): string[] {
    const users = this.allUsers();
    if (!users.some((u) => u.team)) return users.map((u) => u.id);
    const teams = new Map<string, string[]>();
    for (const u of users) {
      const list = teams.get(u.team);
      if (list) list.push(u.id);
      else teams.set(u.team, [u.id]);
    }
    const order = [...teams.keys()].sort((a, b) => (a === NO_TEAM ? 1 : b === NO_TEAM ? -1 : 0));
    return order.flatMap((t) => teams.get(t)!);
  }

  /** The person row at body y; a team header resolves to its first person. */
  personAt(y: number): RowLayout | undefined {
    const i = this.rowAt(y);
    for (let j = i; j < this.rows.length; j++) if (this.rows[j]!.kind === 'person') return this.rows[j];
    for (let j = i - 1; j >= 0; j--) if (this.rows[j]!.kind === 'person') return this.rows[j];
    return undefined;
  }

  /** Focus mode: only these people are shown (null = everyone). */
  private focus: ReadonlySet<string> | null = null;
  private dirtyUsers = new Set<string>();
  private usersDirty = true;
  private listeners = new Set<() => void>();

  constructor(private store: MergeableStore) {
    // Attachments first, so tasks are created with their badge counts.
    for (const id of store.getRowIds('attachments')) this.ingestAttachment(id);
    for (const id of store.getRowIds('comments')) this.ingestComment(id);
    this.readMilestones();
    this.readProjects();
    for (const id of store.getRowIds('tasks')) this.ingestTask(id);
    this.flush();
    store.addDidFinishTransactionListener(() => {
      const [tables] = store.getTransactionChanges();
      const has = (t: string) => t in tables;
      // Changed row ids. A table that was emptied is reported without rows (the
      // whole table deleted), so then every row we knew is affected.
      const ids = (t: string, known: () => Iterable<string>): Iterable<string> =>
        !has(t) ? [] : tables[t] == null ? [...known()] : Object.keys(tables[t]!);
      const touched = new Set(ids('tasks', () => this.storedLane.keys()));
      // Attachment changes re-ingest their task so the block's badge updates.
      for (const id of ids('attachments', () => this.attachmentTask.keys())) for (const t of this.ingestAttachment(id)) touched.add(t);
      for (const id of ids('comments', () => this.commentTask.keys())) for (const t of this.ingestComment(id)) touched.add(t);
      // A renamed project relabels its blocks.
      if (has('projects') || has('clients')) {
        const changed = new Set(ids('projects', () => this.projectById.keys()));
        this.readProjects();
        for (const [id, u] of this.taskUser) if (changed.has(this.byUser.get(u)?.get(id)?.projectId ?? '')) touched.add(this.byUser.get(u)!.get(id)!.series);
      }
      for (const id of touched) this.ingestTask(id);
      if (has('users')) this.usersDirty = true;
      if (has('milestones')) this.readMilestones();
      if (touched.size || has('users')) this.flush();
      else if (has('milestones') || has('projects') || has('clients') || has('views')) this.finish();
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  getPreview = () => this.preview;

  getFocus = () => this.focus;

  /** Show only these people (in sheet order), or everyone with null/empty. */
  setFocus(ids: Iterable<string> | null) {
    const next = ids ? new Set(ids) : null;
    this.focus = next && next.size ? next : null;
    this.usersDirty = true;
    this.flush();
  }

  /** All people on the sheet in order, regardless of focus. */
  allUsers(): { id: string; name: string; color: string; team: string; email: string; order: number }[] {
    return this.store
      .getRowIds('users')
      .map((id) => ({ id, team: '', ...(this.store.getRow('users', id) as UserRow) }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

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

  /** Sheet milestones, sorted by day. */
  milestones: Milestone[] = [];
  private attachmentTask = new Map<string, string>();
  private fileCount = new Map<string, number>();

  /** Projects sorted by client, then name (archived included). */
  projects: Project[] = [];
  private projectById = new Map<string, Project>();
  getProject = (id: string) => this.projectById.get(id);

  clients: Client[] = [];
  private clientById = new Map<string, Client>();
  getClient = (id: string) => this.clientById.get(id);

  private readProjects() {
    this.clients = this.store
      .getRowIds('clients')
      .map((id) => ({ id, ...(this.store.getRow('clients', id) as ClientRow) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.clientById = new Map(this.clients.map((c) => [c.id, c]));
    this.projects = this.store
      .getRowIds('projects')
      .map((id) => {
        const row = this.store.getRow('projects', id) as ProjectRow;
        // The client row's name wins over the older text copy.
        const c = row.clientId ? this.clientById.get(row.clientId) : undefined;
        return { id, ...row, client: c ? c.name : row.clientId ? '' : (row.client ?? '') };
      })
      .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name));
    this.projectById = new Map(this.projects.map((p) => [p.id, p]));
  }

  /** Per project id: tasks, planned days, dates and people. */
  projectStats(): Map<string, ProjectStats> {
    const out = new Map<string, ProjectStats>();
    const now = today();
    for (const id of this.store.getRowIds('tasks')) {
      const t = this.store.getRow('tasks', id) as TaskRow;
      if (!t.projectId) continue;
      let s = out.get(t.projectId);
      if (!s) out.set(t.projectId, (s = { tasks: 0, days: 0, upcoming: 0, first: Infinity, last: -Infinity, people: new Set() }));
      s.tasks++;
      s.days += workdays(t.start, t.end) || t.end - t.start + 1;
      if (t.end >= now) s.upcoming++;
      if (t.start < s.first) s.first = t.start;
      if (t.end > s.last) s.last = t.end;
      if (t.userId) s.people.add(t.userId);
    }
    return out;
  }

  /** Every tag in use, most used first. */
  allTags(): string[] {
    const n = new Map<string, { label: string; n: number }>();
    for (const m of this.byUser.values())
      for (const t of m.values())
        for (const tag of t.id === t.series ? t.tags : []) {
          const k = tag.toLowerCase();
          const e = n.get(k);
          if (e) e.n++;
          else n.set(k, { label: tag, n: 1 });
        }
    return [...n.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((e) => e.label);
  }

  /** Tasks per project id ('' = no project). */
  projectCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of this.byUser.values()) for (const t of m.values()) if (t.id === t.series) out.set(t.projectId, (out.get(t.projectId) ?? 0) + 1);
    return out;
  }

  private readMilestones() {
    this.milestones = this.store
      .getRowIds('milestones')
      .map((id) => ({ id, ...(this.store.getRow('milestones', id) as Omit<Milestone, 'id'>) }))
      .sort((a, b) => a.day - b.day || a.title.localeCompare(b.title));
  }

  private commentTask = new Map<string, string>();
  private commentCount = new Map<string, number>();
  private ingestComment(id: string): string[] {
    const affected: string[] = [];
    const prev = this.commentTask.get(id);
    if (prev) {
      this.commentCount.set(prev, (this.commentCount.get(prev) ?? 1) - 1);
      this.commentTask.delete(id);
      affected.push(prev);
    }
    if (this.store.hasRow('comments', id)) {
      const t = this.store.getCell('comments', id, 'taskId') as string;
      this.commentTask.set(id, t);
      this.commentCount.set(t, (this.commentCount.get(t) ?? 0) + 1);
      affected.push(t);
    }
    return affected.filter((t) => this.store.hasRow('tasks', t));
  }

  /** Track which task an attachment belongs to; returns affected task ids. */
  private ingestAttachment(id: string): string[] {
    const affected: string[] = [];
    const prev = this.attachmentTask.get(id);
    if (prev) {
      this.fileCount.set(prev, (this.fileCount.get(prev) ?? 1) - 1);
      this.attachmentTask.delete(id);
      affected.push(prev);
    }
    if (this.store.hasRow('attachments', id)) {
      const t = this.store.getCell('attachments', id, 'taskId') as string;
      this.attachmentTask.set(id, t);
      this.fileCount.set(t, (this.fileCount.get(t) ?? 0) + 1);
      affected.push(t);
    }
    return affected;
  }

  /** Derived occurrence ids per recurring task. */
  private occIds = new Map<string, string[]>();
  private today = today();
  private horizon = this.today + HORIZON_DAYS;

  private dropView(id: string) {
    const u = this.taskUser.get(id);
    if (u) {
      this.byUser.get(u)?.delete(id);
      this.dirtyUsers.add(u);
    }
    this.taskUser.delete(id);
  }

  private ingestTask(id: string) {
    this.dropView(id);
    for (const o of this.occIds.get(id) ?? []) {
      this.dropView(o);
      this.prevLane.delete(o);
    }
    this.occIds.delete(id);
    if (!this.store.hasRow('tasks', id)) {
      this.prevLane.delete(id);
      this.storedLane.delete(id);
      return;
    }
    const r = this.store.getRow('tasks', id) as TaskRow;
    const start = Math.min(r.start, r.end);
    const end = Math.max(r.start, r.end);
    const view: TaskView = {
      id,
      userId: r.userId,
      start,
      end,
      title: r.title,
      color: r.color,
      notes: r.notes,
      lane: -1,
      files: this.fileCount.get(id) ?? 0,
      comments: this.commentCount.get(id) ?? 0,
      projectId: r.projectId ?? '',
      project: (r.projectId && this.projectById.get(r.projectId)?.name) || '',
      tags: parseTags(r.tags),
      repeat: isRule(r.repeat) ? r.repeat : '',
      series: id,
      pattern: r.pattern ?? '',
      done: !!r.done,
      time: r.time ?? '',
    };
    let m = this.byUser.get(r.userId);
    if (!m) this.byUser.set(r.userId, (m = new Map()));
    this.dirtyUsers.add(r.userId);
    if (isRule(r.repeat)) {
      const ids: string[] = [];
      let first = false;
      for (const o of occurrences(start, end, r.repeat, r.repeatUntil ?? 0, parseSkip(r.skip), Math.max(this.horizon, start + HORIZON_DAYS))) {
        if (o.n === 0) {
          first = true;
          continue;
        }
        const oid = occurrenceId(id, o.n);
        ids.push(oid);
        this.taskUser.set(oid, r.userId);
        m.set(oid, { ...view, id: oid, start: o.start, end: o.end });
      }
      this.occIds.set(id, ids);
      // The first occurrence was deleted: the stored task itself is hidden.
      if (!first) {
        this.storedLane.set(id, r.lane);
        return;
      }
    }
    // A changed stored lane hint (local drop or remote collaborator) wins
    // over the previous layout.
    if (r.lane >= 0 && this.storedLane.get(id) !== r.lane) this.prevLane.set(id, r.lane);
    this.storedLane.set(id, r.lane);
    this.taskUser.set(id, r.userId);
    m.set(id, view);
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
        files: base?.files ?? 0,
        comments: base?.comments ?? 0,
        projectId: base?.projectId ?? '',
        project: base?.project ?? '',
        tags: base?.tags ?? [],
        repeat: base?.repeat ?? '',
        series: base?.series ?? p.id,
        pattern: base?.pattern ?? '',
        done: base?.done ?? false,
        time: base?.time ?? '',
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
    const height = rowHeight(lanesFor(clusters, this.heightWindow[0], this.heightWindow[1], this.today), this.dims);
    return { kind: 'person', team: user.team ?? '', userId, name: user.name, color: user.color, avatar: user.avatar ?? '', tasks, maxSpan, laneCount, clusters, height };
  }

  setHeightWindow(d0: number, d1: number) {
    const [a, b] = this.heightWindow;
    if (a === d0 && b === d1) return;
    this.heightWindow = [d0, d1];
    let changed = false;
    this.rows = this.rows.map((r) => {
      const height = r.kind === 'team' ? this.dims.teamH : rowHeight(lanesFor(r.clusters, d0, d1, this.today), this.dims);
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
        .filter(([id]) => !this.focus || this.focus.has(id))
        .sort((a, b) => a[1].order - b[1].order || a[1].name.localeCompare(b[1].name));
      const old = new Map(this.rows.map((r) => [r.userId, r]));
      const person = ([id, u]: readonly [string, UserRow]): RowLayout => {
        const prev = old.get(id);
        if (prev && !this.dirtyUsers.has(id)) {
          const team = u.team ?? '';
          return prev.name === u.name && prev.color === u.color && prev.team === team && (prev.avatar ?? '') === (u.avatar ?? '') ? prev : { ...prev, name: u.name, color: u.color, team, avatar: u.avatar ?? '' };
        }
        return this.layoutRow(id, u);
      };
      // Group by team once anyone has one (not while focusing on people).
      const grouped = !this.focus && users.some(([, u]) => u.team);
      this.personCount = users.length;
      if (!grouped) {
        this.teams = [];
        this.rows = users.map(person);
      } else {
        const teams = new Map<string, (readonly [string, UserRow])[]>();
        for (const e of users) {
          const t = e[1].team ?? '';
          const list = teams.get(t);
          if (list) list.push(e);
          else teams.set(t, [e]);
        }
        // Teams in the order of their first person; "No team" last.
        const order = [...teams.keys()].sort((a, b) => (a === NO_TEAM ? 1 : b === NO_TEAM ? -1 : 0));
        this.teams = order;
        this.rows = [];
        for (const t of order) {
          const members = teams.get(t)!;
          const collapsed = this.collapsed.has(t);
          const key = TEAM_ROW + t;
          const prev = old.get(key);
          this.rows.push(
            prev && prev.count === members.length && prev.collapsed === collapsed && prev.height === this.dims.teamH
              ? prev
              : { ...EMPTY_ROW, kind: 'team', team: t, userId: key, name: t || 'No team', count: members.length, collapsed, height: this.dims.teamH },
          );
          if (!collapsed) for (const m of members) this.rows.push(person(m));
        }
      }
      this.dirtyUsers.clear();
      changed = true;
    } else if (this.dirtyUsers.size) {
      for (const id of this.dirtyUsers) {
        const i = this.rowIndex.get(id);
        // Gone, or the index is stale (person removed in this transaction).
        if (i === undefined || !this.store.hasRow('users', id) || this.rows[i]?.userId !== id) continue;
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
