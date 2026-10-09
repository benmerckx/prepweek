import { useEffect, useRef } from 'react';
import { visibleTasks, type TimelineModel } from './model.ts';
import type { TaskFilter } from './Rows.tsx';
import type { Viewport } from './viewport.ts';
import { getPeers, onPeers } from '../data/presence.ts';
import { onThemeChange } from '../lib/theme.ts';
import { addMonths, formatDay, monthShort, startOfMonth, startOfWeek, weekLead, ymd } from '../lib/dates.ts';

// A VS Code–style scrubber for the time axis. The canvas shows ~6 months at
// a time (about a month on phones, or the whole range if it fits); like VS Code's minimap it scrolls
// proportionally with the main view, so the slider moves linearly with the
// scroll position. Clicking outside the slider jumps there and keeps scrubbing.

const TARGET_DAYS = 183;
const LABEL_H = 16;

interface Props {
  model: TimelineModel;
  vp: Viewport;
  today: number;
  /** Search/filters: the matching work is highlighted on the strip. */
  filter?: TaskFilter;
  /** Days the strip spans (less on phones, where the view is a few days). */
  span?: number;
}

interface Geo {
  W: number;
  H: number;
  scale: number; // px per day
  mmStart: number;
  sliderX: number;
  sliderW: number;
  travel: number; // px the slider can travel
}

export function Minimap({ model, vp, today, filter = null, span = TARGET_DAYS }: Props) {
  const spanRef = useRef(span);
  spanRef.current = span;
  const filterRef = useRef<TaskFilter>(filter);
  const invalidateRef = useRef(() => {});
  useEffect(() => {
    filterRef.current = filter;
    invalidateRef.current();
  }, [filter]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = useRef({ hoverX: -1, dragging: false, grabDx: 0, raf: 0, rebuild: 0, colors: {} as Record<string, string>, shift: 0, lock: null as null | number, over: 0, glide: null as null | { from: number; to: number; s0: number; s1: number; timer: number } });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const st = state.current;

    const readColors = () => {
      const cs = getComputedStyle(wrap);
      for (const k of ['bg', 'band', 'weekend', 'line', 'text', 'text-strong', 'slider', 'slider-border', 'today', 'hover', 'dim', 'ink'])
        st.colors[k] = cs.getPropertyValue(`--mm-${k}`).trim();
    };
    readColors();

    const geo = (): Geo => {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const total = Math.max(1, vp.rangeDays);
      const scale = Math.max(W / total, W / spanRef.current);
      const mmDays = W / scale;
      const max = vp.maxScrollLeft();
      const f = max > 0 ? (vp.scroller?.scrollLeft ?? 0) / max : 0;
      // Proportional (like VS Code), plus a shift in days that a click sets
      // so the clicked spot ends up under the pointer.
      const base = vp.origin + f * Math.max(0, total - mmDays);
      const viewDays = vp.visibleDays;
      const sliderW = Math.max(6, viewDays * scale);
      const fv = vp.firstVisibleDay;
      // Mid-glide after a click: blend the shift in with the scroll progress,
      // so the strip moves smoothly instead of jumping.
      const gl = st.glide;
      if (gl) {
        const p = gl.to === gl.from ? 1 : Math.min(1, Math.max(0, ((vp.scroller?.scrollLeft ?? 0) - gl.from) / (gl.to - gl.from)));
        st.shift = gl.s0 + (gl.s1 - gl.s0) * p;
      }
      let mmStart = st.lock ?? base + st.shift;
      // Keep the handle on the strip (except mid-glide or while dragging,
      // when the strip holds still under the handle).
      if (st.lock !== null) st.shift = mmStart - base;
      else if (!gl) {
        if ((fv - mmStart) * scale < 0) mmStart = fv;
        else if ((fv - mmStart) * scale + sliderW > W) mmStart = fv - (W - sliderW) / scale;
        st.shift = mmStart - base;
      }
      const sliderX = (fv - mmStart) * scale;
      return { W, H, scale, mmStart, sliderX, sliderW, travel: Math.max(1, W - viewDays * scale) };
    };

    // The static part (month bands, labels, tasks, today) is rendered into
    // an offscreen tile 3× the visible width and only re-rendered when the
    // view leaves it or the data changes; a scroll frame is one drawImage.
    const cache = { canvas: document.createElement('canvas'), start: 0, days: 0, scale: 0, version: -1, H: 0, dpr: 0, theme: 0, filter: 0 };
    let themeGen = 0;
    let filterGen = 0;
    invalidateRef.current = () => {
      filterGen++;
      schedule();
    };

    const renderCache = (g: Geo, dpr: number) => {
      const days = (g.W * 3) / g.scale;
      cache.start = Math.floor(g.mmStart - g.W / g.scale);
      cache.days = Math.ceil(days);
      cache.scale = g.scale;
      cache.version = model.version;
      cache.H = g.H;
      cache.dpr = dpr;
      cache.theme = themeGen;
      cache.filter = filterGen;
      const cw = Math.ceil(cache.days * g.scale);
      const oc = cache.canvas;
      oc.width = Math.ceil(cw * dpr);
      oc.height = Math.round(g.H * dpr);
      const o = oc.getContext('2d')!;
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = st.colors;
      const H = g.H;
      const s0 = cache.start;
      const s1 = s0 + cache.days;
      o.fillStyle = c.bg!;
      o.fillRect(0, 0, cw, H);

      // Month bands and labels.
      o.font = '600 10px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
      o.textBaseline = 'middle';
      for (let m = startOfMonth(s0); m <= s1; m = addMonths(m, 1)) {
        const x = (m - s0) * g.scale;
        const w = (addMonths(m, 1) - m) * g.scale;
        const { y, m: mi } = ymd(m);
        if (mi % 2 === 0) {
          o.fillStyle = c.band!;
          o.fillRect(x, LABEL_H, w, H - LABEL_H);
        }
        o.fillStyle = mi === 0 ? c['text-strong']! : c.line!;
        o.fillRect(Math.round(x), mi === 0 ? 0 : LABEL_H - 4, 1, mi === 0 ? H : 4);
        if (mi === 0) {
          // A new year: a label you can spot, like Today's.
          o.font = '700 9.5px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
          const label = String(y);
          const lw = o.measureText(label).width + 10;
          o.beginPath();
          o.roundRect(Math.round(x), 1, lw, LABEL_H - 2, 4);
          o.fill();
          o.fillStyle = c.bg!;
          o.fillText(label, Math.round(x) + 5, LABEL_H / 2 + 0.5);
          o.font = '600 10px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
        } else if (w > 26) {
          o.fillStyle = c.text!;
          o.fillText(monthShort(mi), x + 4, LABEL_H / 2 + 1);
        }
      }
      // Weeks: a tick where each starts (Monday, or the user's first day of
      // the week); zoomed in (phones), its date too. The weekends are veiled
      // after the plan is drawn (below).
      if (g.scale >= 2) {
        o.font = '500 9.5px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
        for (let d = startOfWeek(s0 + weekLead()) - weekLead(); d <= s1; d += 7) {
          const x = (d - s0) * g.scale;
          const sinceMonth = (d - startOfMonth(d)) * g.scale;
          if (sinceMonth === 0) continue;
          o.fillStyle = c.line!;
          o.fillRect(Math.round(x), LABEL_H - 5, 1, 5);
          if (g.scale < 9 || sinceMonth < 30) continue; // the month's own label is there
          o.fillStyle = c.text!;
          o.globalAlpha = 0.7;
          o.fillText(String(ymd(d).d), x + 3, LABEL_H / 2 + 1);
          o.globalAlpha = 1;
        }
      }

      // A miniature of the plan: a thin strip per person, in the same
      // order as the rows, each block in its own color. You see whose time
      // is taken where at a glance, and the strip looks like the timeline
      // it scrubs. Time off is drawn faint, done work dimmed; with a search
      // or filter on, the rest fades and what matches stands out.
      const people = model.rows.filter((r) => r.kind === 'person');
      const top = LABEL_H + 4;
      const bottom = H - 3;
      const lane = people.length ? (bottom - top) / people.length : 0;
      const bar = lane >= 4 ? lane - 1.5 : lane >= 2 ? lane - 0.5 : lane;
      const f = filterRef.current;
      people.forEach((row, i) => {
        const y = top + i * lane;
        // A faint track per person, so empty stretches read as free time.
        if (lane >= 3) {
          o.fillStyle = c.band!;
          o.fillRect(0, y, cw, bar);
        }
        for (const t of visibleTasks(row, s0, s1)) {
          const x = (t.start - s0) * g.scale;
          const w = Math.max(1, (t.end - t.start + 1) * g.scale - (g.scale > 4 ? 1 : 0));
          const match = !f || f(t);
          o.fillStyle = t.off ? c.text! : t.color;
          o.globalAlpha = !match ? 0.12 : t.off ? 0.25 : t.done ? 0.35 : 0.72;
          o.fillRect(x, y, w, bar);
        }
        o.globalAlpha = 1;
      });

      // Weekends veiled over the plan, so each week reads as its own column.
      if (g.scale >= 2) {
        o.fillStyle = c.weekend!;
        for (let d = startOfWeek(s0) + 5; d <= s1; d += 7) o.fillRect((d - s0) * g.scale, LABEL_H, 2 * g.scale, H - LABEL_H);
      }

      // Milestones: a marker in the label row and a thin line down.
      for (const m of model.milestones) {
        if (m.day < s0 || m.day > s1) continue;
        const x = Math.round((m.day + 0.5 - s0) * g.scale);
        o.fillStyle = m.color;
        o.globalAlpha = 0.55;
        o.fillRect(x, LABEL_H, 1, H - LABEL_H);
        o.globalAlpha = 1;
        o.beginPath();
        o.moveTo(x - 4, LABEL_H - 9);
        o.lineTo(x + 4, LABEL_H - 9);
        o.lineTo(x, LABEL_H - 2);
        o.closePath();
        o.fill();
      }


    };

    const draw = () => {
      st.raf = 0;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (W === 0 || H === 0) return;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = geo();
      const c = st.colors;
      const mmEnd = g.mmStart + W / g.scale;
      const mustRebuild =
        cache.version === -1 ||
        cache.scale !== g.scale ||
        cache.H !== H ||
        cache.dpr !== dpr ||
        cache.theme !== themeGen ||
        cache.filter !== filterGen ||
        g.mmStart < cache.start ||
        mmEnd > cache.start + cache.days;
      if (mustRebuild) {
        clearTimeout(st.rebuild);
        st.rebuild = 0;
        renderCache(g, dpr);
      } else if (cache.version !== model.version && !st.rebuild) {
        // Data changed but the view didn't: keep showing the current image
        // and rebuild once edits settle (a drag or a burst of syncs would
        // otherwise rebuild the whole heatmap on every change).
        st.rebuild = setTimeout(() => {
          st.rebuild = 0;
          cache.version = -1;
          schedule();
        }, 300) as unknown as number;
      }
      const sx = Math.round((g.mmStart - cache.start) * g.scale * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(cache.canvas, sx, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '600 10px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      // Slider: dim everything outside the visible range, frame the inside.
      ctx.fillStyle = c.dim!;
      ctx.fillRect(0, 0, Math.max(0, g.sliderX), H);
      ctx.fillRect(g.sliderX + g.sliderW, 0, Math.max(0, W - g.sliderX - g.sliderW), H);
      ctx.fillStyle = c.slider!;
      ctx.globalAlpha = st.dragging ? 1 : 0.6;
      ctx.fillRect(g.sliderX, 0, g.sliderW, LABEL_H);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c['slider-border']!;
      ctx.lineWidth = st.dragging ? 2 : 1.5;
      ctx.strokeRect(g.sliderX + 0.75, 0.75, g.sliderW - 1.5, H - 1.5);

      // Where everyone else is looking: a thin bracket in their color.
      for (const p of getPeers()) {
        if (!p.view) continue;
        const x0 = (p.view[0] - g.mmStart) * g.scale;
        const w = Math.max(4, (p.view[1] - p.view[0]) * g.scale);
        if (x0 + w < 0 || x0 > W) continue;
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x0, H - 4, w, 3);
        ctx.fillRect(x0, H - 9, 2, 8);
        ctx.fillRect(x0 + w - 2, H - 9, 2, 8);
        ctx.globalAlpha = 1;
      }

      // Today, on top of the slider: a full-height line and a pill.
      const tx = Math.round((today + 0.5 - g.mmStart) * g.scale);
      ctx.fillStyle = c.today!;
      ctx.fillRect(tx - 1, LABEL_H - 1, 2, H - LABEL_H + 1);
      ctx.font = '700 9.5px "Inter Variable", ui-sans-serif, system-ui, sans-serif';
      const label = 'Today';
      const lw = ctx.measureText(label).width + 10;
      ctx.beginPath();
      ctx.roundRect(tx - lw / 2, 1, lw, LABEL_H - 2, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(label, tx, LABEL_H / 2 + 0.5);
      ctx.textAlign = 'start';
      ctx.font = '600 10px "Inter Variable", ui-sans-serif, system-ui, sans-serif';

      // Hover readout.
      if (st.hoverX >= 0 && !st.dragging) {
        const day = Math.floor(g.mmStart + st.hoverX / g.scale);
        ctx.fillStyle = c.hover!;
        ctx.fillRect(Math.round(st.hoverX), 0, 1, H);
        const label = formatDay(day);
        const tw = ctx.measureText(label).width + 10;
        const lx = Math.min(W - tw, Math.max(0, st.hoverX - tw / 2));
        ctx.fillStyle = c['text-strong']!;
        ctx.fillRect(lx, H - 17, tw, 16);
        ctx.fillStyle = c.bg!;
        ctx.fillText(label, lx + 5, H - 9);
      }
    };

    const schedule = () => {
      if (!st.raf) st.raf = requestAnimationFrame(draw);
    };

    // Scrubbing.
    // Dragging moves the timeline at the strip's own scale: the strip holds
    // still (st.lock) and the handle follows the pointer over it. Pushing the
    // handle past either edge pans the strip by the overshoot.
    const setFromSlider = (sliderLeft: number) => {
      const g = geo();
      if (st.lock === null) return;
      const room = g.W - g.sliderW;
      // Only movement further out pans (coming back doesn't undo it).
      const left = Math.min(room, Math.max(0, sliderLeft));
      const over = sliderLeft - left;
      const push = over < 0 ? Math.min(0, over - st.over) : over > 0 ? Math.max(0, over - st.over) : 0;
      st.lock += push / g.scale;
      st.over = over;
      const day = st.lock + left / g.scale;
      if (vp.scroller) vp.scroller.scrollLeft = Math.min(vp.maxScrollLeft(), Math.max(0, vp.scale.xF(day)));
    };
    const endGlide = () => {
      if (!st.glide) return;
      clearTimeout(st.glide.timer);
      st.shift = st.glide.s1;
      st.glide = null;
      schedule();
    };
    const scroller = vp.scroller;
    scroller?.addEventListener('scrollend', endGlide);
    const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
    /** Over the handle (with a little slack so a thin one is still grabbable). */
    const onHandle = (x: number, g = geo()) => x >= g.sliderX - 4 && x <= g.sliderX + g.sliderW + 4;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x = localX(e);
      const g = geo();
      if (!onHandle(x, g)) {
        // Outside the handle: glide so the clicked day is centred in the
        // timeline, and shift the strip so that day (now the handle's centre)
        // ends up right under the pointer. No drag starts here.
        const day = g.mmStart + x / g.scale;
        const max = vp.maxScrollLeft();
        const left = Math.min(max, Math.max(0, vp.scale.xF(day) - vp.viewWidth / 2));
        const total = Math.max(1, vp.rangeDays);
        const baseEnd = vp.origin + (max > 0 ? left / max : 0) * Math.max(0, total - g.W / g.scale);
        if (st.glide) clearTimeout(st.glide.timer);
        const from = vp.scroller?.scrollLeft ?? 0;
        st.glide = {
          from,
          to: left,
          s0: st.shift,
          s1: day - x / g.scale - baseEnd,
          timer: setTimeout(endGlide, 2500) as unknown as number, // fallback for scrollend

        };
        vp.scroller?.scrollTo({ left, behavior: 'smooth' });
        return;
      }
      endGlide();
      canvas.setPointerCapture(e.pointerId);
      st.dragging = true;
      st.lock = g.mmStart;
      st.over = 0;
      wrap.classList.add('scrubbing');
      // Dragging jumps straight to each position: no block/row transitions
      // (a click outside the handle still glides).
      document.documentElement.dataset.scrubbing = '';
      st.grabDx = x - g.sliderX;
      schedule();
    };
    const move = (e: PointerEvent) => {
      const x = localX(e);
      st.hoverX = x;
      if (st.dragging) setFromSlider(x - st.grabDx);
      // A hand only over the handle; elsewhere a click glides there.
      canvas.style.cursor = st.dragging ? 'grabbing' : onHandle(x) ? 'grab' : 'default';
      schedule();
    };
    const up = (e: PointerEvent) => {
      st.dragging = false;
      st.lock = null;
      wrap.classList.remove('scrubbing');
      delete document.documentElement.dataset.scrubbing;
      if (e.pointerType === 'touch') st.hoverX = -1;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      schedule();
    };
    const leave = () => {
      st.hoverX = -1;
      schedule();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      // Wheel over the minimap scrolls in minimap pixels: fast travel.
      if (vp.scroller) vp.scroller.scrollLeft += (d / geo().scale) * vp.colW * 0.5;
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    const offVp = vp.onChange(schedule);
    const offModel = model.subscribe(schedule);
    const offPeers = onPeers(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    const offTheme = onThemeChange(() => {
      readColors();
      themeGen++;
      schedule();
    });
    schedule();
    return () => {
      scroller?.removeEventListener('scrollend', endGlide);
      offPeers();
      cancelAnimationFrame(st.raf);
      clearTimeout(st.rebuild);
      st.raf = 0;
      st.rebuild = 0;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      offVp();
      offModel();
      ro.disconnect();
      offTheme();
    };
  }, [model, vp, today]);

  return (
    <div className="minimap" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
