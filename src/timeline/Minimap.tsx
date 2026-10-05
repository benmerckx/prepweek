import { useEffect, useRef } from 'react';
import type { TimelineModel } from './model.ts';
import type { Cluster } from '../lib/layout.ts';
import type { Viewport } from './viewport.ts';
import { addMonths, formatDay, isWeekend, monthShort, startOfMonth, startOfWeek, ymd } from '../lib/dates.ts';

// A VS Code–style scrubber for the time axis. The canvas shows ~18 months at
// a time (or the whole range if it fits); like VS Code's minimap it scrolls
// proportionally with the main view, so the slider moves linearly with the
// scroll position and you can traverse years with one drag. Clicking outside
// the slider jumps there and keeps scrubbing.

const TARGET_DAYS = 548;
const LABEL_H = 16;
/** Minimum band height per person (px) before people get grouped. */
const MIN_BAND = 2.5;

/** Clusters (sorted, non-overlapping) intersecting [d0, d1]. */
function* clustersIn(cs: Cluster[], d0: number, d1: number) {
  let lo = 0;
  let hi = cs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid]!.end < d0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < cs.length && cs[i]!.start <= d1; i++) yield cs[i]!;
}

interface Props {
  model: TimelineModel;
  vp: Viewport;
  today: number;
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

export function Minimap({ model, vp, today }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = useRef({ hoverX: -1, dragging: false, grabDx: 0, raf: 0, colors: {} as Record<string, string> });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const st = state.current;

    const readColors = () => {
      const cs = getComputedStyle(wrap);
      for (const k of ['bg', 'band', 'line', 'text', 'text-strong', 'slider', 'slider-border', 'today', 'hover', 'dim', 'ink'])
        st.colors[k] = cs.getPropertyValue(`--mm-${k}`).trim();
    };
    readColors();

    const geo = (): Geo => {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const total = Math.max(1, vp.rangeDays);
      const scale = Math.max(W / total, W / TARGET_DAYS);
      const mmDays = W / scale;
      const max = vp.maxScrollLeft();
      const f = max > 0 ? (vp.scroller?.scrollLeft ?? 0) / max : 0;
      const mmStart = vp.origin + f * Math.max(0, total - mmDays);
      const viewDays = vp.visibleDays;
      const sliderX = (vp.firstVisibleDay - mmStart) * scale;
      const sliderW = Math.max(6, viewDays * scale);
      return { W, H, scale, mmStart, sliderX, sliderW, travel: Math.max(1, W - viewDays * scale) };
    };

    // The static part (month bands, labels, tasks, today) is rendered into
    // an offscreen tile 3× the visible width and only re-rendered when the
    // view leaves it or the data changes; a scroll frame is one drawImage.
    const cache = { canvas: document.createElement('canvas'), start: 0, days: 0, scale: 0, version: -1, H: 0, dpr: 0, theme: 0 };
    let themeGen = 0;

    const renderCache = (g: Geo, dpr: number) => {
      const days = (g.W * 3) / g.scale;
      cache.start = Math.floor(g.mmStart - g.W / g.scale);
      cache.days = Math.ceil(days);
      cache.scale = g.scale;
      cache.version = model.version;
      cache.H = g.H;
      cache.dpr = dpr;
      cache.theme = themeGen;
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
        if (w > 26 || mi === 0) {
          o.fillStyle = mi === 0 ? c['text-strong']! : c.text!;
          o.fillText(mi === 0 ? String(y) : monthShort(mi), x + 4, LABEL_H / 2 + 1);
        }
      }

      // Workload, not blocks: one band per person, shaded week by week by
      // booked workdays (parallel tasks count extra). Free weeks fade out,
      // busy and overbooked weeks get darker, and nothing is drawn per block. With many people, adjacent rows share a band
      // and are averaged.
      const rows = model.rows;
      const avail = H - LABEL_H - 3;
      const perBand = Math.max(1, Math.ceil((MIN_BAND * rows.length) / Math.max(1, avail)));
      const bands = Math.ceil(rows.length / perBand);
      const bandH = avail / Math.max(1, bands);
      const vGap = bandH >= 4 ? 1 : 0;
      const w0 = startOfWeek(s0);
      const weeks = Math.ceil((s1 - w0 + 1) / 7);
      const cellW = 7 * g.scale;
      const load = new Float32Array(weeks);
      o.fillStyle = c.ink!;
      for (let b = 0; b < bands; b++) {
        load.fill(0);
        const first = b * perBand;
        const last = Math.min(rows.length, first + perBand);
        for (let i = first; i < last; i++) {
          for (const cl of clustersIn(rows[i]!.clusters, w0, s1)) {
            for (let d = Math.max(cl.start, w0); d <= Math.min(cl.end, s1); d++) {
              if (!isWeekend(d)) load[((d - w0) / 7) | 0]! += cl.lanes;
            }
          }
        }
        const top = LABEL_H + 2 + b * bandH;
        const n = last - first;
        for (let k = 0; k < weeks; k++) {
          const v = load[k]! / (5 * n); // 1 = one task every workday
          if (v <= 0) continue;
          // 0 → nothing, fully booked → mid tone, 1.5× (parallel work) → full.
          o.globalAlpha = 0.08 + 0.72 * Math.min(1, v / 1.5);
          o.fillRect((w0 + k * 7 - s0) * g.scale, top, cellW + 0.5, bandH - vGap);
        }
      }
      o.globalAlpha = 1;

      // Today.
      o.fillStyle = c.today!;
      o.fillRect(Math.round((today - s0) * g.scale), 0, 2, H);
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
      if (
        cache.version !== model.version ||
        cache.scale !== g.scale ||
        cache.H !== H ||
        cache.dpr !== dpr ||
        cache.theme !== themeGen ||
        g.mmStart < cache.start ||
        mmEnd > cache.start + cache.days
      ) {
        renderCache(g, dpr);
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
    const setFromSlider = (sliderLeft: number) => {
      const g = geo();
      const f = Math.min(1, Math.max(0, sliderLeft / g.travel));
      if (vp.scroller) vp.scroller.scrollLeft = f * vp.maxScrollLeft();
    };
    const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const x = localX(e);
      let g = geo();
      if (x < g.sliderX || x > g.sliderX + g.sliderW) {
        // Jump: centre the clicked day, then keep dragging from there.
        vp.scrollToDay(g.mmStart + x / g.scale, 0.5);
        g = geo();
      }
      st.dragging = true;
      st.grabDx = x - g.sliderX;
      schedule();
    };
    const move = (e: PointerEvent) => {
      const x = localX(e);
      st.hoverX = x;
      if (st.dragging) setFromSlider(x - st.grabDx);
      schedule();
    };
    const up = (e: PointerEvent) => {
      st.dragging = false;
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
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => {
      readColors();
      themeGen++;
      schedule();
    };
    mq.addEventListener('change', theme);
    schedule();
    return () => {
      cancelAnimationFrame(st.raf);
      st.raf = 0;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      offVp();
      offModel();
      ro.disconnect();
      mq.removeEventListener('change', theme);
    };
  }, [model, vp, today]);

  return (
    <div className="minimap" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
