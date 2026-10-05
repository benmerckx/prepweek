import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { BLOCK_H, CHUNK, LANE_H, ROW_PAD, type TimelineModel } from './model.ts';
import { COMPACT_QUERY, HEADER_H, SIDEBAR_W, SIDEBAR_W_COMPACT, Viewport, ZOOM_MAX, ZOOM_MIN } from './viewport.ts';
import { DragController, type DragKind } from './drag.ts';
import { Header } from './Header.tsx';
import { GridBackground, RowView, Sidebar } from './Rows.tsx';
import { Minimap } from './Minimap.tsx';
import { Editor } from './Editor.tsx';
import { Toolbar } from './Toolbar.tsx';
import { labelPinner } from './pin.ts';
import { createTask, createUser, deleteTask, getTask, redo, undo, updateTask } from '../data/store.ts';
import { dayFromYMD, formatRange, startOfWeek, startOfYear, today as getToday, ymd } from '../lib/dates.ts';

interface Win {
  d0: number;
  d1: number;
  r0: number;
  r1: number;
}

const ZOOM_KEY = 'prepweek:zoom';
const EDITOR_H = 230;

const isCompact = () => matchMedia(COMPACT_QUERY).matches;

const readZoom = () => {
  const fallback = isCompact() ? 32 : 40;
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : fallback;
  } catch {
    return fallback;
  }
};

const subscribeCompact = (fn: () => void) => {
  const mq = matchMedia(COMPACT_QUERY);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

export function Timeline({ model }: { model: TimelineModel }) {
  useSyncExternalStore(model.subscribe, model.getVersion);
  const todayDay = useMemo(getToday, []);
  const vp = useMemo(() => new Viewport(), []);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const compact = useSyncExternalStore(subscribeCompact, isCompact);
  const sidebarW = compact ? SIDEBAR_W_COMPACT : SIDEBAR_W;
  vp.sidebarW = sidebarW;
  const [colW, setColW] = useState(readZoom);
  const colWRef = useRef(colW);
  colWRef.current = colW;

  // Scrollable range: a few years around today, widened to fit all data.
  const range = useMemo(() => {
    const y = ymd(todayDay).y;
    let a = dayFromYMD(y - 2, 0, 1);
    let b = dayFromYMD(y + 4, 0, 1) - 1;
    const ext = model.dataExtent();
    if (ext) {
      a = Math.min(a, startOfYear(ext[0]));
      b = Math.max(b, dayFromYMD(ymd(ext[1]).y + 1, 0, 1) - 1);
    }
    a = startOfWeek(a);
    return { origin: a, days: b - a + 1 };
  }, [model, todayDay]);

  vp.colW = colW;
  vp.origin = range.origin;
  vp.rangeDays = range.days;

  const [win, setWin] = useState<Win>({ d0: range.origin, d1: range.origin + CHUNK - 1, r0: 0, r1: 30 });
  const winRef = useRef(win);
  winRef.current = win;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: DragKind; id: string } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /** Move the rendered window only when the viewport nears its edge. */
  const refreshWindow = useCallback(() => {
    const s = vp.scroller;
    if (!s) return;
    const a = Math.floor(vp.firstVisibleDay);
    const b = Math.ceil(vp.firstVisibleDay + vp.visibleDays);
    const ra = model.rowAt(s.scrollTop);
    const rb = model.rowAt(s.scrollTop + vp.viewHeight);
    const w = winRef.current;
    const span = Math.max(7, b - a);
    // The window is a run of whole CHUNKs (tiles). Moving it mounts only the
    // newly exposed tiles; tiles already on screen are memoized and skipped.
    const margin = Math.max(3, Math.round(span * 0.25));
    const daysOk = w.d0 <= a - margin && w.d1 >= b + margin && w.d1 - w.d0 <= span * 4 + 2 * CHUNK;
    const rowsOk = w.r0 <= ra && w.r1 >= rb;
    if (daysOk && rowsOk) return;
    const chunk = (d: number) => Math.floor((d - vp.origin) / CHUNK);
    const next: Win = daysOk
      ? { ...w }
      : {
          d0: vp.origin + Math.max(0, chunk(a - span)) * CHUNK,
          d1: vp.origin + (Math.min(chunk(vp.origin + vp.rangeDays - 1), chunk(b + span)) + 1) * CHUNK - 1,
          r0: w.r0,
          r1: w.r1,
        };
    if (!daysOk) model.setHeightWindow(next.d0, next.d1);
    if (!rowsOk) {
      next.r0 = Math.max(0, ra - 4);
      next.r1 = rb + 4;
    }
    winRef.current = next;
    setWin(next);
  }, [model, vp]);

  // Scroll: rAF-throttled, never re-renders unless the window must move.
  useLayoutEffect(() => {
    const s = scrollerRef.current!;
    vp.scroller = s;
    vp.scrollToDay(todayDay - 2, 0);
    let raf = 0;
    const onScroll = () => {
      labelPinner.update(s.scrollLeft + 4);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        refreshWindow();
        vp.emit();
      });
    };
    s.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(s);
    refreshWindow();
    return () => {
      s.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [vp, refreshWindow, todayDay]);

  // Row heights/count change with data.
  useEffect(() => {
    winRef.current = { ...winRef.current, r0: -1, r1: -1 };
    refreshWindow();
  }, [model.version, refreshWindow]);

  // --- Zoom, anchored at a point so the day under the cursor stays put. ---
  const anchor = useRef<{ day: number; px: number } | null>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const zoomEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  const zoomTo = useCallback(
    (next: number, clientX?: number) => {
      const w = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
      if (w === colWRef.current || !vp.scroller) return;
      // While zooming, blocks must jump with the scroll position, not ease
      // from their old spot (that is the flashing during a pinch).
      if (appRef.current) appRef.current.dataset.zooming = '';
      clearTimeout(zoomEnd.current);
      zoomEnd.current = setTimeout(() => appRef.current && delete appRef.current.dataset.zooming, 250);
      const rect = vp.scroller.getBoundingClientRect();
      const px = clientX !== undefined ? clientX - rect.left - vp.sidebarW : vp.viewWidth / 2;
      anchor.current = { day: vp.firstVisibleDay + px / colWRef.current, px };
      colWRef.current = w;
      setColW(w);
    },
    [vp],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    if (a && vp.scroller) {
      vp.scroller.scrollLeft = (a.day - vp.origin) * colW - a.px;
      anchor.current = null;
    }
    if (vp.scroller) labelPinner.update(vp.scroller.scrollLeft + 4);
    winRef.current = { ...winRef.current, d0: Infinity, d1: -Infinity };
    refreshWindow();
    vp.emit();
    try {
      localStorage.setItem(ZOOM_KEY, String(colW));
    } catch {}
  }, [colW, vp, refreshWindow]);

  // Wheel: pinch / ctrl+wheel zooms; plain vertical wheel pans time when
  // all people fit on screen (nothing to scroll vertically).
  useEffect(() => {
    const s = scrollerRef.current!;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        acc += Math.max(-60, Math.min(60, e.deltaY));
        const factor = Math.exp(-acc * 0.01);
        const target = colWRef.current * factor;
        if (Math.round(target) !== colWRef.current) {
          acc = 0;
          zoomTo(target, e.clientX);
        }
        return;
      }
      if (s.scrollHeight <= s.clientHeight + 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        e.preventDefault();
        s.scrollLeft += e.deltaY;
      }
    };
    s.addEventListener('wheel', onWheel, { passive: false });
    return () => s.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // --- Drag & drop ---
  const dragCtl = useMemo(
    () =>
      new DragController(model, vp, {
        onSelect: (id) => {
          setSelected(id);
          if (id !== selectedRef.current) setEditing(null);
        },
        onCreated: (id) => setEditing(id),
        onDragState: (kind, id) => {
          setDrag(kind && id ? { kind, id } : null);
          if (kind) setEditing(null);
        },
        onTap: (id) => {
          if (id && id === selectedRef.current) {
            setEditing(id);
          } else {
            setSelected(id);
            setEditing(null);
          }
        },
        isSelected: (id) => id === selectedRef.current,
      }),
    [model, vp],
  );
  useEffect(() => () => dragCtl.destroy(), [dragCtl]);

  // --- Touch: block scrolling during a touch drag; two-finger pinch zooms. ---
  useEffect(() => {
    const s = scrollerRef.current!;
    let pinch: { dist: number; w: number } | null = null;
    const span = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        dragCtl.abort();
        pinch = { dist: span(e.touches), w: colWRef.current };
      }
    };
    const move = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const mid = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
        zoomTo((pinch.w * span(e.touches)) / pinch.dist, mid);
        return;
      }
      dragCtl.touchMove(e);
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    // Long-press must not open the context menu / iOS callout.
    const menu = (e: Event) => {
      if ((e.target as HTMLElement).closest('.body')) e.preventDefault();
    };
    // iOS Safari: stop page-level pinch zoom; we zoom the timeline instead.
    const gesture = (e: Event) => e.preventDefault();
    s.addEventListener('touchstart', start, { passive: true });
    s.addEventListener('touchmove', move, { passive: false });
    s.addEventListener('touchend', end);
    s.addEventListener('touchcancel', end);
    s.addEventListener('contextmenu', menu);
    document.addEventListener('gesturestart', gesture);
    return () => {
      s.removeEventListener('touchstart', start);
      s.removeEventListener('touchmove', move);
      s.removeEventListener('touchend', end);
      s.removeEventListener('touchcancel', end);
      s.removeEventListener('contextmenu', menu);
      document.removeEventListener('gesturestart', gesture);
    };
  }, [dragCtl, zoomTo]);

  // --- Keyboard ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const sel = selectedRef.current;
      const t = sel ? getTask(sel) : undefined;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomTo(colWRef.current * 1.25);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomTo(colWRef.current / 1.25);
      } else if (e.key === 't' && !mod) {
        vp.scrollToDay(todayDay - 2, 0, true);
      } else if (!sel || !t) {
        return;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteTask(sel);
        setSelected(null);
        setEditing(null);
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const span = t.end - t.start + 1;
        setSelected(createTask({ ...t, start: t.start + span, end: t.end + span, lane: -1 }));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setEditing(sel);
      } else if (e.key === 'Escape') {
        setSelected(null);
        setEditing(null);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) updateTask(sel, { end: Math.max(t.start, t.end + d) }, 'Resize task');
        else updateTask(sel, { start: t.start + d, end: t.end + d }, 'Move task');
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = model.indexOfUser(t.userId) + (e.key === 'ArrowUp' ? -1 : 1);
        const row = model.rows[i];
        if (row) updateTask(sel, { userId: row.userId, lane: -1 }, 'Move task');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, vp, zoomTo, todayDay]);

  const closeEditor = useCallback(() => setEditing(null), []);

  const onDoubleClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
    if (el) {
      setSelected(el.dataset.task!);
      setEditing(el.dataset.task!);
      return;
    }
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const row = model.rows[model.rowAt(vp.yAt(e.clientY))];
    if (!row) return;
    const day = Math.floor(vp.dayAt(e.clientX));
    const id = createTask({ userId: row.userId, start: day, end: day, title: '', color: row.color, lane: -1, notes: '' });
    setSelected(id);
    setEditing(id);
  };

  // --- Render ---
  const bodyW = range.days * colW;
  const bodyH = Math.max(model.totalHeight + 64, vp.viewHeight);
  const rows = model.rows;
  const rendered = [];
  for (let i = Math.max(0, win.r0); i <= win.r1 && i < rows.length; i++) {
    const r = rows[i]!;
    rendered.push(
      <RowView
        key={r.userId}
        row={r}
        top={model.rowTops[i]!}
        origin={range.origin}
        colW={colW}
        d0={win.d0}
        d1={win.d1}
        selectedId={selected}
        dragId={drag?.id ?? null}
      />,
    );
  }

  const editTask = editing && !drag ? model.findTask(editing) : undefined;
  let editor = null;
  if (editTask) {
    const i = model.indexOfUser(editTask.userId);
    const blockTop = (model.rowTops[i] ?? 0) + ROW_PAD + editTask.lane * LANE_H;
    // Open below the block, or above it when that would leave the viewport.
    const below = blockTop + BLOCK_H + 6;
    const viewBottom = (vp.scroller?.scrollTop ?? 0) + vp.viewHeight;
    const top = below + EDITOR_H > viewBottom && blockTop - EDITOR_H - 6 > 0 ? blockTop - EDITOR_H - 6 : below;
    editor = compact ? (
      // A bottom sheet on phones, outside the scroller so it stays put.
      createPortal(<Editor key={editTask.id} task={editTask} x={0} y={0} sheet onClose={closeEditor} />, document.body)
    ) : (
      <Editor
        key={editTask.id}
        task={editTask}
        x={Math.max(0, (editTask.start - range.origin) * colW)}
        y={top}
        onClose={closeEditor}
      />
    );
  }

  return (
    <div
      ref={appRef}
      className={'app' + (drag ? ` is-${drag.kind}` : '') + (compact ? ' compact' : '')}
      style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}
    >
      <Toolbar
        colW={colW}
        onZoom={(w) => zoomTo(w)}
        onToday={() => vp.scrollToDay(todayDay - 2, 0, true)}
        onPage={(dir) => vp.scroller?.scrollBy({ left: dir * vp.viewWidth * 0.8, behavior: 'smooth' })}
        model={model}
      />
      <div className="scroller" ref={scrollerRef}>
        <div
          className="sheet"
          style={{
            width: sidebarW + bodyW,
            height: HEADER_H + bodyH,
            gridTemplateColumns: `${sidebarW}px ${bodyW}px`,
            gridTemplateRows: `${HEADER_H}px ${bodyH}px`,
          }}
        >
          <div className="corner">
            <span className="corner-label">People</span>
            <span className="corner-count">{rows.length}</span>
          </div>
          <div className="header">
            <Header d0={win.d0} d1={win.d1} origin={range.origin} colW={colW} today={todayDay} />
          </div>
          <div className="sidebar">
            <Sidebar rows={rows} tops={model.rowTops} r0={Math.max(0, win.r0)} r1={win.r1} />
            <button
              className="add-person"
              style={{ transform: `translateY(${model.totalHeight}px)` }}
              onClick={() => createUser('New person')}
            >
              {compact ? '+' : '+ Add person'}
            </button>
          </div>
          <div className="body" onPointerDown={(e) => dragCtl.pointerDown(e.nativeEvent)} onDoubleClick={onDoubleClick}>
            <GridBackground d0={win.d0} d1={win.d1} origin={range.origin} colW={colW} height={bodyH} today={todayDay} />
            {rendered}
            {rows.length === 0 && (
              <div className="empty" style={{ transform: `translateX(${(vp.scroller?.scrollLeft ?? 0) + 32}px)` }}>
                No people on this sheet yet. Add someone on the left, then drag across their row to plan work.
              </div>
            )}
            {editor}
          </div>
        </div>
      </div>
      <div className="bottombar">
        <div className="bottombar-left">
          <VisibleRange vp={vp} />
          <span>Drag the strip to scrub through time</span>
        </div>
        <Minimap model={model} vp={vp} today={todayDay} />
      </div>
    </div>
  );
}

/** Updates imperatively on scroll; never re-renders the timeline. */
function VisibleRange({ vp }: { vp: Viewport }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (!ref.current || !vp.scroller) return;
      const a = Math.floor(vp.firstVisibleDay + 0.5);
      const b = Math.floor(vp.firstVisibleDay + vp.visibleDays - 0.5);
      ref.current.textContent = formatRange(a, Math.max(a, b));
    };
    update();
    return vp.onChange(update);
  }, [vp]);
  return <span className="range-label" ref={ref} />;
}
