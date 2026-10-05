// The time axis: maps day numbers ↔ columns ↔ pixels.
//
// With weekends shown, every day is one column. With weekends hidden,
// Saturdays and Sundays collapse to zero width, so a week is five columns.
// All horizontal positioning (blocks, header, grid, milestones, drag
// snapping, scrolling) goes through this one object.
//
// `origin` is always a Monday, which keeps the week arithmetic simple.

export class Scale {
  readonly perWeek: number;

  constructor(
    readonly origin: number,
    readonly colW: number,
    readonly hideWeekends: boolean,
  ) {
    this.perWeek = hideWeekends ? 5 : 7;
  }

  /** Column index of the start of `day` (weekend days share Monday's). */
  col(day: number): number {
    const rel = day - this.origin;
    if (!this.hideWeekends) return rel;
    const weeks = Math.floor(rel / 7);
    const dow = rel - weeks * 7;
    return weeks * 5 + Math.min(dow, 5);
  }

  /** Column for a fractional day (for anchoring zoom/scroll positions). */
  colF(day: number): number {
    const d = Math.floor(day);
    const frac = day - d;
    if (!this.hideWeekends) return d - this.origin + frac;
    return this.col(d) + (this.isHidden(d) ? 0 : frac);
  }

  /** The (visible) day shown in integer column `c`. */
  dayOfCol(c: number): number {
    if (!this.hideWeekends) return this.origin + c;
    const weeks = Math.floor(c / 5);
    return this.origin + weeks * 7 + (c - weeks * 5);
  }

  /** Fractional day under fractional column `c` (never a hidden day). */
  dayAtCol(c: number): number {
    if (!this.hideWeekends) return this.origin + c;
    const weeks = Math.floor(c / 5);
    return this.origin + weeks * 7 + (c - weeks * 5);
  }

  isHidden(day: number): boolean {
    if (!this.hideWeekends) return false;
    const dow = (((day - this.origin) % 7) + 7) % 7;
    return dow >= 5;
  }

  /** Left edge of `day` in pixels. */
  x(day: number): number {
    return this.col(day) * this.colW;
  }
  xF(day: number): number {
    return this.colF(day) * this.colW;
  }

  /** Pixel width of the inclusive range [start, end]. */
  w(start: number, end: number): number {
    return (this.col(end + 1) - this.col(start)) * this.colW;
  }

  /** Number of visible columns in [start, end]. */
  cols(start: number, end: number): number {
    return this.col(end + 1) - this.col(start);
  }

  /** Fractional day at pixel `x`. */
  dayAt(x: number): number {
    return this.dayAtCol(x / this.colW);
  }
}
