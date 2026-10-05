import { LANE_H, ROW_PAD, type TimelineModel } from './model.ts';
import { HEADER_H, SIDEBAR_W, type Viewport } from './viewport.ts';
import { createTask, getUser, updateTask } from '../data/store.ts';

// Pointer-driven move / resize / create, written from scratch on Pointer
// Events. Design points that make it feel solid:
//
//  - A 4px slop threshold separates clicks from drags.
//  - Window-level listeners (not element capture), so virtualization can
//    unmount/remount the block mid-drag without breaking the gesture.
//  - Everything is computed from the latest pointer position + current scroll,
//    so autoscroll, zoom and remote edits during a drag stay consistent.
//  - Snapping rounds to the nearest column boundary, not floor(), so a block
//    moves when the pointer is halfway into the next day.
//  - The drag is only a *preview* in the TimelineModel (other blocks reflow
//    live); the store is written once on drop, as one undoable command, which
//    is also exactly one sync message for collaborators.
//  - Esc cancels; Alt/Option duplicates instead of moving.

export type DragKind = 'move' | 'resize-start' | 'resize-end' | 'create';

export const NEW_TASK_ID = '__new__';

interface Session {
  kind: DragKind;
  pointerId: number;
  taskId: string;
  userId: string;
  start: number;
  end: number;
  /** For move: pointer day (fractional) minus task start at pointerdown. */
  grab: number;
  /** For create: the day under the pointer at pointerdown. */
  anchor: number;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  started: boolean;
  duplicate: boolean;
  /** Last computed preview, to avoid redundant model updates. */
  key: string;
}

export interface DragCallbacks {
  onSelect(id: string | null): void;
  onCreated(id: string): void;
  onDragState(kind: DragKind | null, taskId: string | null): void;
}

const SLOP = 4;
const EDGE = 56; // autoscroll zone in px
const MAX_SPEED = 28; // px per frame at the very edge

export class DragController {
  private s: Session | null = null;
  private raf = 0;

  constructor(
    private model: TimelineModel,
    private vp: Viewport,
    private cb: DragCallbacks,
  ) {}

  get active() {
    return this.s?.started ?? false;
  }

  pointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.s) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag]')) return;
    const block = target.closest<HTMLElement>('[data-task]');
    const day = this.vp.dayAt(e.clientX);
    const base = {
      pointerId: e.pointerId,
      downX: e.clientX,
      downY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      duplicate: e.altKey,
      key: '',
    };
    if (block) {
      const task = this.model.findTask(block.dataset.task!);
      if (!task) return;
      const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
      const kind: DragKind = handle === 'start' ? 'resize-start' : handle === 'end' ? 'resize-end' : 'move';
      this.s = { ...base, kind, taskId: task.id, userId: task.userId, start: task.start, end: task.end, grab: day - task.start, anchor: 0 };
    } else {
      const row = this.model.rows[this.model.rowAt(this.vp.yAt(e.clientY))];
      if (!row) return;
      const d = Math.floor(day);
      this.s = { ...base, kind: 'create', taskId: NEW_TASK_ID, userId: row.userId, start: d, end: d, grab: 0, anchor: d };
    }
    // Prevent text selection / native drag while we own the gesture.
    e.preventDefault();
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.cancel);
    window.addEventListener('keydown', this.key, true);
  };

  private move = (e: PointerEvent) => {
    const s = this.s;
    if (!s || e.pointerId !== s.pointerId) return;
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.duplicate = e.altKey && s.kind === 'move';
    if (!s.started) {
      if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) < SLOP) return;
      s.started = true;
      document.body.dataset.dragging = s.kind;
      this.cb.onDragState(s.kind, s.taskId);
      if (s.kind !== 'create') this.cb.onSelect(s.taskId);
      this.loop();
    }
    this.update();
  };

  /** Recompute the preview from the last pointer position. */
  private update() {
    const s = this.s!;
    const vp = this.vp;
    const day = vp.dayAt(s.lastX);
    const y = vp.yAt(s.lastY);
    let { userId, start, end } = s;
    let lane: number | undefined;
    const ri = this.model.rowAt(y);
    const row = this.model.rows[ri];

    switch (s.kind) {
      case 'move': {
        const span = s.end - s.start;
        start = Math.round(day - s.grab);
        end = start + span;
        if (row) {
          userId = row.userId;
          lane = Math.max(0, Math.floor((y - this.model.rowTops[ri]! - ROW_PAD) / LANE_H));
        }
        break;
      }
      case 'resize-start':
        start = Math.min(s.end, Math.round(day));
        break;
      case 'resize-end':
        end = Math.max(s.start, Math.round(day) - 1);
        break;
      case 'create': {
        const d = Math.floor(day);
        start = Math.min(s.anchor, d);
        end = Math.max(s.anchor, d);
        const top = this.model.rowTops[this.model.indexOfUser(userId)] ?? 0;
        lane = Math.max(0, Math.floor((y - top - ROW_PAD) / LANE_H));
        break;
      }
    }

    const key = `${userId}|${start}|${end}|${lane}`;
    if (key === s.key) return;
    s.key = key;
    const user = getUser(userId);
    this.model.setPreview({
      id: s.taskId,
      userId,
      start,
      end,
      lane,
      ...(s.kind === 'create' ? { title: '', color: user?.color } : {}),
    });
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const s = this.s;
      const el = this.vp.scroller;
      if (!s?.started || !el) return;
      const r = el.getBoundingClientRect();
      const left = r.left + SIDEBAR_W;
      const top = r.top + HEADER_H;
      const right = r.left + el.clientWidth;
      const bottom = r.top + el.clientHeight;
      const speed = (d: number) => (d < EDGE ? Math.ceil(MAX_SPEED * ((EDGE - Math.max(d, 0)) / EDGE) ** 2) : 0);
      const dx = speed(right - s.lastX) - speed(s.lastX - left);
      const dy = s.kind === 'move' ? speed(bottom - s.lastY) - speed(s.lastY - top) : 0;
      if (dx || dy) {
        const bx = el.scrollLeft;
        const by = el.scrollTop;
        el.scrollLeft += dx;
        el.scrollTop += dy;
        if (el.scrollLeft !== bx || el.scrollTop !== by) this.update();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  };

  private up = (e: PointerEvent) => {
    const s = this.s;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.started) {
      this.end();
      this.cb.onSelect(s.kind === 'create' ? null : s.taskId);
      return;
    }
    this.update();
    const p = this.model.getPreview();
    const lane = this.model.laneOf(s.taskId) ?? -1;
    if (p) {
      if (s.kind === 'create') {
        const id = createTask({ userId: p.userId, start: p.start, end: p.end, title: '', color: p.color ?? '#4f7cff', lane, notes: '' });
        this.model.rememberLane(id, lane);
        this.end();
        this.cb.onSelect(id);
        this.cb.onCreated(id);
        return;
      }
      const orig = this.model.findTask(s.taskId);
      const changed = !orig || orig.userId !== p.userId || orig.start !== p.start || orig.end !== p.end || this.model.laneOf(s.taskId) !== orig.lane;
      if (s.duplicate && orig) {
        const id = createTask({ userId: p.userId, start: p.start, end: p.end, title: orig.title, color: orig.color, lane, notes: orig.notes });
        this.model.rememberLane(id, lane);
        this.end();
        this.cb.onSelect(id);
        return;
      }
      if (changed) {
        const label = s.kind === 'move' ? 'Move task' : 'Resize task';
        updateTask(s.taskId, { userId: p.userId, start: p.start, end: p.end, lane }, label);
      }
    }
    this.end();
  };

  private cancel = () => {
    if (this.s) this.end();
  };

  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.end();
    } else if (e.key === 'Alt' && this.s) {
      this.s.duplicate = this.s.kind === 'move';
    }
  };

  private end() {
    cancelAnimationFrame(this.raf);
    const had = this.s?.started;
    this.s = null;
    delete document.body.dataset.dragging;
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.cancel);
    window.removeEventListener('keydown', this.key, true);
    if (this.model.getPreview()) this.model.setPreview(null);
    if (had) this.cb.onDragState(null, null);
  }

  destroy() {
    this.end();
  }
}

