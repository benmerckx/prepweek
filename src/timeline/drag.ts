import type { TimelineModel } from './model.ts';
import { HEADER_H, type Viewport } from './viewport.ts';
import { createTask, getUser, isReadOnly, updateTask } from '../data/store.ts';

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
//  - Touch: swipes keep scrolling. A long-press picks a block up (or starts
//    drawing a new one on empty space); an already-selected block drags
//    immediately. Tap selects, tapping the selected block edits it. Once a
//    touch drag is live, touchmove is cancelled so the page doesn't scroll.

export type DragKind = 'move' | 'resize-start' | 'resize-end' | 'create';

export const NEW_TASK_ID = '__new__';

interface Session {
  kind: DragKind;
  pointerId: number;
  taskId: string;
  userId: string;
  start: number;
  end: number;
  /** Pointer column (fractional) minus the dragged edge's column at pointerdown. */
  grab: number;
  /** For create: the day under the pointer at pointerdown. */
  anchor: number;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  started: boolean;
  /** Touch: waiting for the long-press before the drag can start. */
  pending: boolean;
  touch: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  duplicate: boolean;
  /** Last computed preview, to avoid redundant model updates. */
  key: string;
  /** The task editor was open when the press began. */
  editing: boolean;
}

export interface DragCallbacks {
  onSelect(id: string | null): void;
  onCreated(id: string): void;
  onDragState(kind: DragKind | null, taskId: string | null): void;
  /** Touch tap (no drag) on a block, or on empty space (null). */
  onTap(id: string | null): void;
  /** Mouse click (no drag) on a block. */
  onClickBlock(id: string): void;
  /** Mouse click (no drag) on empty space; `editing` = an editor was open. */
  onClickEmpty(userId: string, day: number, editing: boolean): void;
  isSelected(id: string): boolean;
  isEditing(): boolean;
}

const SLOP = 4;
const TOUCH_SLOP = 10; // movement that turns a pending long-press into a scroll
const LONG_PRESS = 350;
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
    // Everything is computed in columns, so with weekends hidden a block can
    // never snap onto a (zero-width) Saturday or Sunday.
    const sc = this.vp.scale;
    const col = this.vp.colAt(e.clientX);
    const base = {
      pointerId: e.pointerId,
      downX: e.clientX,
      downY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      pending: false,
      touch: e.pointerType === 'touch',
      timer: undefined,
      duplicate: e.altKey,
      key: '',
      editing: this.cb.isEditing(),
    };
    if (block) {
      const task = this.model.findTask(block.dataset.task!);
      if (!task) return;
      const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
      const kind: DragKind = handle === 'start' ? 'resize-start' : handle === 'end' ? 'resize-end' : 'move';
      // Grab offset from the edge being dragged, so the edge doesn't jump to
      // the pointer (matters for the offset touch knobs).
      const grab = kind === 'resize-end' ? col - sc.col(task.end + 1) : col - sc.col(task.start);
      this.s = { ...base, kind, taskId: task.id, userId: task.userId, start: task.start, end: task.end, grab, anchor: 0 };
    } else {
      // View-only: tapping a block selects it, nothing else.
      if (isReadOnly()) return;
      const row = this.model.personAt(this.vp.yAt(e.clientY));
      if (!row) return;
      const d = sc.dayOfCol(Math.floor(col));
      this.s = { ...base, kind: 'create', taskId: NEW_TASK_ID, userId: row.userId, start: d, end: d, grab: 0, anchor: d };
    }
    const s = this.s;
    if (s.touch && !(s.kind !== 'create' && this.cb.isSelected(s.taskId))) {
      // Let the browser scroll unless the finger stays put long enough.
      s.pending = true;
      s.timer = setTimeout(this.arm, LONG_PRESS);
    } else {
      // Prevent text selection / native drag while we own the gesture.
      e.preventDefault();
    }
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
    if (s.pending) {
      // Moved before the long-press fired: it's a scroll, not ours.
      if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) > TOUCH_SLOP) this.end();
      return;
    }
    if (!s.started) {
      if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) < SLOP) return;
      if (isReadOnly()) return this.end();
      this.begin();
    }
    this.update();
  };

  private begin() {
    const s = this.s!;
    s.started = true;
    document.body.dataset.dragging = s.kind;
    this.cb.onDragState(s.kind, s.taskId);
    if (s.kind !== 'create') this.cb.onSelect(s.taskId);
    this.loop();
  }

  private arm = () => {
    const s = this.s;
    if (!s?.pending) return;
    s.pending = false;
    if (isReadOnly()) return;
    navigator.vibrate?.(8);
    this.begin();
    this.update();
  };

  /** Called by the timeline's non-passive touchmove listener. */
  touchMove = (e: TouchEvent) => {
    if (this.s?.started && this.s.touch && e.cancelable) e.preventDefault();
  };

  /** A second finger landed: give the gesture to pinch-zoom. */
  abort() {
    if (this.s) this.end();
  }

  /** Recompute the preview from the last pointer position. */
  private update() {
    const s = this.s!;
    const vp = this.vp;
    const sc = vp.scale;
    const col = vp.colAt(s.lastX);
    const y = vp.yAt(s.lastY);
    const { pad, laneH } = this.model.dims;
    let { userId, start, end } = s;
    let lane: number | undefined;
    const ri = this.model.rowAt(y);
    const row = this.model.rows[ri];

    switch (s.kind) {
      case 'move': {
        const startCol = Math.round(col - s.grab);
        start = sc.dayOfCol(startCol);
        // Keep the length in visible columns (workdays when weekends are hidden).
        end = sc.hideWeekends ? sc.dayOfCol(startCol + Math.max(1, sc.cols(s.start, s.end)) - 1) : start + (s.end - s.start);
        // Over a team header: stay with the current person.
        if (row?.kind === 'person') {
          userId = row.userId;
          lane = Math.max(0, Math.floor((y - this.model.rowTops[ri]! - pad) / laneH));
        }
        break;
      }
      case 'resize-start':
        start = Math.min(s.end, sc.dayOfCol(Math.min(sc.col(s.end), Math.round(col - s.grab))));
        break;
      case 'resize-end':
        end = Math.max(s.start, sc.dayOfCol(Math.max(sc.col(s.start), Math.round(col - s.grab) - 1)));
        break;
      case 'create': {
        const d = sc.dayOfCol(Math.floor(col));
        start = Math.min(s.anchor, d);
        end = Math.max(s.anchor, d);
        const top = this.model.rowTops[this.model.indexOfUser(userId)] ?? 0;
        lane = Math.max(0, Math.floor((y - top - pad) / laneH));
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
      const left = r.left + this.vp.sidebarW;
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
      const id = s.kind === 'create' ? null : s.taskId;
      if (s.touch) this.cb.onTap(id);
      else if (id) this.cb.onClickBlock(id);
      else this.cb.onClickEmpty(s.userId, s.anchor, s.editing);
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
        const id = createTask({
          userId: p.userId,
          start: p.start,
          end: p.end,
          title: orig.title,
          color: orig.color,
          lane,
          notes: orig.notes,
          projectId: orig.projectId,
          tags: orig.tags.join(','),
          pattern: orig.pattern,
        });
        this.model.rememberLane(id, lane);
        this.end();
        this.cb.onSelect(id);
        return;
      }
      if (changed) {
        const label = s.kind === 'move' ? 'Move task' : 'Resize task';
        // Moving one occurrence of a series detaches it under a new id.
        const id = updateTask(s.taskId, { userId: p.userId, start: p.start, end: p.end, lane }, label);
        if (id !== s.taskId) {
          this.model.rememberLane(id, lane);
          this.end();
          this.cb.onSelect(id);
          return;
        }
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
    clearTimeout(this.s?.timer);
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

