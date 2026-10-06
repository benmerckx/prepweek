import { useEffect, useRef } from 'react';
import type { TimelineModel } from './model.ts';
import type { Viewport } from './viewport.ts';
import { getPeers, onPeers } from '../data/presence.ts';
import { onThemeChange } from '../lib/theme.ts';
import { addMonths, formatDay, isWeekend, monthShort, startOfMonth, startOfWeek, ymd } from '../lib/dates.ts';

// A VS Code–style scrubber for the time axis. The canvas shows ~18 months at
// a time (or the whole range if it fits); like VS Code's minimap it scrolls
// proportionally with the main view, so the slider moves linearly with the
// scroll position and you can traverse years with one drag. Clicking outside
// the slider jumps there and keeps scrubbing.

const TARGET_DAYS = 548;
const LABEL_H = 16;

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
  const state = useRef({ hoverX: -1, dragging: false, grabDx: 0, raf: 0, rebuild: 0, colors: {} as Record<string, string> });

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

    // Weekly series per block color, rebuilt when the data changes.
    let seriesCache: { version: number; week0: number; weeks: number; max: number; lines: { color: string; values: Float32Array }[] } | null = null;
    const getSeries = () => {
      if (seriesCache?.version === model.version) return seriesCache;
      const week0 = startOfWeek(vp.origin);
      const weeks = Math.ceil((vp.rangeDays + 7) / 7) + 1;
      const byColor = new Map<string, Float32Array>();
      for (const row of model.rows)
        for (const t of row.tasks) {
          let a = byColor.get(t.color);
          if (!a) byColor.set(t.color, (a = new Float32Array(weeks)));
          for (let d = Math.max(t.start, week0); d <= t.end; d++) {
            const k = ((d - week0) / 7) | 0;
            if (k >= weeks) break;
            if (!isWeekend(d)) a[k]! += 0.2; // 5 workdays → 1 block on average
          }
        }
      // Smooth over ~5 weeks (triangular weights) so trends read as trends,
      // not week-to-week noise.
      const W5 = [1, 2, 3, 2, 1];
      for (const [color, raw] of byColor) {
        const out = new Float32Array(weeks);
        for (let k = 0; k < weeks; k++) {
          let sum = 0;
          let wsum = 0;
          for (let j = -2; j <= 2; j++) {
            const v = raw[k + j];
            if (v === undefined) continue;
            sum += v * W5[j + 2]!;
            wsum += W5[j + 2]!;
          }
          out[k] = sum / wsum;
        }
        byColor.set(color, out);
      }
      let max = 1;
      const lines = [...byColor].map(([color, values]) => {
        let total = 0;
        for (const v of values) {
          total += v;
          if (v > max) max = v;
        }
        return { color, values, total };
      });
      // Biggest series first, so smaller ones draw on top.
      lines.sort((a, b) => b.total - a.total);
      seriesCache = { version: model.version, week0, weeks, max: max * 1.08, lines };
      return seriesCache;
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

      // Kind and amount of work: one line per block color, all people
      // combined. Each point is a week: how many blocks of that color run
      // on an average workday. A shared y-scale over the whole range keeps
      // the lines comparable while scrolling.
      const series = getSeries();
      const top = LABEL_H + 6;
      const bottom = H - 3;
      const plotH = bottom - top;
      const k0 = Math.max(0, Math.floor((s0 - series.week0) / 7) - 1);
      const k1 = Math.min(series.weeks - 1, Math.ceil((s1 - series.week0) / 7) + 1);
      const xOf = (k: number) => (series.week0 + k * 7 + 3.5 - s0) * g.scale;
      const yOf = (v: number) => bottom - (v / series.max) * plotH;
      // Baseline.
      o.fillStyle = c.line!;
      o.globalAlpha = 0.6;
      o.fillRect(0, bottom, cw, 1);
      o.globalAlpha = 1;
      o.lineJoin = 'round';
      o.lineCap = 'round';
      for (const { color, values } of series.lines) {
        // Smooth curve through the weekly points (midpoint quadratics).
        const path = new Path2D();
        let px = xOf(k0);
        let py = yOf(values[k0]!);
        path.moveTo(px, py);
        for (let k = k0 + 1; k <= k1; k++) {
          const x = xOf(k);
          const y = yOf(values[k]!);
          path.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
          px = x;
          py = y;
        }
        path.lineTo(px, py);
        const area = new Path2D(path);
        area.lineTo(px, bottom);
        area.lineTo(xOf(k0), bottom);
        area.closePath();
        o.fillStyle = color;
        o.globalAlpha = 0.07;
        o.fill(area);
        o.globalAlpha = 1;
        o.strokeStyle = color;
        o.lineWidth = 1.75;
        o.stroke(path);
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
    const setFromSlider = (sliderLeft: number) => {
      const g = geo();
      const f = Math.min(1, Math.max(0, sliderLeft / g.travel));
      if (vp.scroller) vp.scroller.scrollLeft = f * vp.maxScrollLeft();
    };
    const localX = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
    /** Over the handle (with a little slack so a thin one is still grabbable). */
    const onHandle = (x: number, g = geo()) => x >= g.sliderX - 4 && x <= g.sliderX + g.sliderW + 4;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x = localX(e);
      const g = geo();
      if (!onHandle(x, g)) {
        // Outside the handle: glide there so the handle ends up centred
        // under the pointer. No drag starts here.
        const f = Math.min(1, Math.max(0, (x - g.sliderW / 2) / g.travel));
        vp.scroller?.scrollTo({ left: f * vp.maxScrollLeft(), behavior: 'smooth' });
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      st.dragging = true;
      wrap.classList.add('scrubbing');
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
      wrap.classList.remove('scrubbing');
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
