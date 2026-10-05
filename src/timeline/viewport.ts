// Imperative view geometry shared by the timeline, drag controller and
// minimap. Scrolling never goes through React: the browser scrolls natively
// (compositor-thread fast), and we only listen to decide when the rendered
// window of days/rows needs to move.

import { Scale } from './scale.ts';

export const SIDEBAR_W = 220;
/** Narrow screens: avatar-only people column. */
export const SIDEBAR_W_COMPACT = 64;
export const COMPACT_QUERY = '(max-width: 640px)';
/** Month band 22 + day band 30 + milestone lane 22. */
export const HEADER_H = 74;

export const ZOOM_MIN = 6;
export const ZOOM_MAX = 160;

export class Viewport {
  scroller: HTMLDivElement | null = null;
  /** The time axis (origin, column width, hidden weekends). */
  scale = new Scale(0, 40, false);
  sidebarW = SIDEBAR_W;
  rangeDays = 0;
  private listeners = new Set<() => void>();

  get colW() {
    return this.scale.colW;
  }
  /** Day number at x = 0 of the body (a Monday). */
  get origin() {
    return this.scale.origin;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  emit() {
    this.listeners.forEach((l) => l());
  }

  get bodyWidth() {
    return this.scale.x(this.origin + this.rangeDays);
  }

  /** Width of the visible body area (excluding the sidebar). */
  get viewWidth() {
    const s = this.scroller;
    return s ? Math.max(0, s.clientWidth - this.sidebarW) : 0;
  }
  get viewHeight() {
    const s = this.scroller;
    return s ? Math.max(0, s.clientHeight - HEADER_H) : 0;
  }

  /** Fractional day at the left edge of the visible body. */
  get firstVisibleDay() {
    return this.scale.dayAt(this.scroller?.scrollLeft ?? 0);
  }
  /** Calendar days spanned by the visible body (incl. hidden weekends). */
  get visibleDays() {
    const left = this.scroller?.scrollLeft ?? 0;
    return this.scale.dayAt(left + this.viewWidth) - this.scale.dayAt(left);
  }

  /** Body x coordinate under a client x coordinate. */
  bodyX(clientX: number) {
    const s = this.scroller!;
    return clientX - s.getBoundingClientRect().left - this.sidebarW + s.scrollLeft;
  }
  /** Fractional column under a client x coordinate. */
  colAt(clientX: number) {
    return this.bodyX(clientX) / this.colW;
  }
  /** Fractional day number under a client x coordinate. */
  dayAt(clientX: number) {
    return this.scale.dayAt(this.bodyX(clientX));
  }
  /** Body y coordinate under a client y coordinate. */
  yAt(clientY: number) {
    const s = this.scroller!;
    return clientY - s.getBoundingClientRect().top - HEADER_H + s.scrollTop;
  }

  x(day: number) {
    return this.scale.x(day);
  }

  /** Scroll so `day` (fractional) sits at `frac` of the visible width. */
  scrollToDay(day: number, frac = 0.5, smooth = false) {
    const s = this.scroller;
    if (!s) return;
    const left = this.scale.xF(day) - this.viewWidth * frac;
    s.scrollTo({ left, behavior: smooth ? 'smooth' : 'instant' });
  }

  maxScrollLeft() {
    const s = this.scroller;
    return s ? Math.max(0, s.scrollWidth - s.clientWidth) : 0;
  }
}
