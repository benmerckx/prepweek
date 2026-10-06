import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CHUNK, COMFORTABLE, COMPACT, type TimelineModel } from './model.ts';
import { Scale } from './scale.ts';
import { COMPACT_QUERY, HEADER_H, SIDEBAR_W, SIDEBAR_W_COMPACT, Viewport, ZOOM_MAX, ZOOM_MIN } from './viewport.ts';
import { DragController, type DragKind } from './drag.ts';
import { Header } from './Header.tsx';
import { GridBackground, RowView, matches, type TaskFilter } from './Rows.tsx';
import { Sidebar } from './Sidebar.tsx';
import { NO_FILTER, type FilterState } from './Filters.tsx';
import { navigate, useRoute } from '../lib/route.ts';
import { Pages } from './Pages.tsx';
import { ActivityPanel } from './Discussion.tsx';
import { watchDesktopNotifications } from '../data/notify.ts';
import { publish, startPresence, type Peer } from '../data/presence.ts';
import { PresenceLayer } from './Presence.tsx';
import { LockScreen, ShareDialog, useAccess } from './Share.tsx';
import { CommandPalette, type Command } from './Palette.tsx';
import { SignInDialog, WorkspaceDialog, useAutoSave } from './Account.tsx';
import { Minimap } from './Minimap.tsx';
import { Editor } from './Editor.tsx';
import { Toolbar } from './Toolbar.tsx';
import { labelPinner } from './pin.ts';
import { ImportDialog } from '../import/ImportDialog.tsx';
import { MilestoneBand, MilestoneEditor, MilestoneLines, type MsDrag } from './Milestones.tsx';
import { Flag, Minus, Plus } from '../ui/icons.tsx';
import { useBackToClose } from '../lib/useBackToClose.ts';
import { createMilestone, createTask, createUser, deleteTask, getTask, getUser, MILESTONE_COLORS, redo, store, undo, updateTask, type ViewConfig } from '../data/store.ts';
import { dayFromYMD, formatRange, startOfWeek, startOfYear, today as getToday, ymd } from '../lib/dates.ts';

interface Win {
  d0: number;
  d1: number;
  r0: number;
  r1: number;
}

const ZOOM_KEY = 'prepweek:zoom2';
const WEEKENDS_KEY = 'prepweek:hideWeekends';
const DENSITY_KEY = 'prepweek:density';
const COLLAPSED_KEY = 'prepweek:collapsedTeams';

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};
const writeFlag = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {}
};

const isCompact = () => matchMedia(COMPACT_QUERY).matches;

/** Default zoom: just over two weeks on desktop, one week on a phone. */
const defaultZoom = () => {
  const compact = isCompact();
  const width = innerWidth - (compact ? SIDEBAR_W_COMPACT : SIDEBAR_W);
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, width / (compact ? 7 : 16.5))));
};

const readZoom = () => {
  const fallback = defaultZoom();
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
  const access = useAccess();
  const readOnly = access?.role === 'view';
  const [sharing, setSharing] = useState(false);
  const openShare = useCallback(() => setSharing(true), []);
  // Accounts: sign in, workspace people, and saving a plan started here.
  const [signingIn, setSigningIn] = useState(false);
  const openSignIn = useCallback(() => setSigningIn(true), []);
  useEffect(() => {
    window.addEventListener('prepweek:signin', openSignIn);
    return () => window.removeEventListener('prepweek:signin', openSignIn);
  }, [openSignIn]);
  const [workspaceOpen, setWorkspaceOpen] = useState<string | null>(null);
  useAutoSave();
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

  // View options: both are per-device preferences.
  const [hideWeekends, setHideWeekends] = useState(() => readFlag(WEEKENDS_KEY));
  const [dense, setDense] = useState(() => {
    const d = readFlag(DENSITY_KEY);
    model.setDims(d ? COMPACT : COMFORTABLE);
    return d;
  });

  const scale = useMemo(() => new Scale(range.origin, colW, hideWeekends), [range.origin, colW, hideWeekends]);
  vp.scale = scale;
  vp.rangeDays = range.days;

  const [win, setWin] = useState<Win>({ d0: range.origin, d1: range.origin + CHUNK - 1, r0: 0, r1: 30 });
  const winRef = useRef(win);
  winRef.current = win;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: DragKind; id: string } | null>(null);
  const [msDrag, setMsDrag] = useState<MsDrag | null>(null);
  const [msEdit, setMsEdit] = useState<{ id: string; anchor: DOMRect; fresh?: boolean } | null>(null);
  const editMilestone = useCallback((id: string, anchor: DOMRect, fresh?: boolean) => setMsEdit({ id, anchor, fresh }), []);
  /** "+" in the corner: a milestone in the middle of the view. */
  const addMilestoneHere = () => {
    const day = Math.floor(vp.firstVisibleDay + vp.visibleDays / 2);
    const id = createMilestone({ day, title: '', color: MILESTONE_COLORS[0] });
    const lane = document.querySelector('.hd-ms')!.getBoundingClientRect();
    setMsEdit({ id, anchor: new DOMRect(lane.left + vp.x(day), lane.top, vp.colW, lane.height), fresh: true });
  };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const focus = model.getFocus();
  // Collapsed teams are a per-device preference.
  useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      if (Array.isArray(v) && v.length) model.setCollapsed(v);
    } catch {}
  });
  const toggleTeam = useCallback(
    (team: string) => {
      const next = new Set(model.teams.filter(model.isCollapsed));
      if (next.has(team)) next.delete(team);
      else next.add(team);
      model.setCollapsed(next);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
    },
    [model],
  );
  const [filterState, setFilterState] = useState<FilterState>(NO_FILTER);
  const manageProjects = useCallback(() => navigate({ section: 'projects' }), []);
  const route = useRoute();
  const onPage = route.section !== 'plan';
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  /** Search and filters as one predicate; non-matching blocks are faded. */
  const filter: TaskFilter = useMemo(() => {
    const ps = new Set(filterState.projects);
    const ts = new Set(filterState.tags);
    if (!q && !ps.size && !ts.size) return null;
    return (t) =>
      (!q || matches(t, q)) && (!ps.size || ps.has(t.projectId)) && (!ts.size || t.tags.some((g) => ts.has(g.toLowerCase())));
  }, [q, filterState]);

  /** Toggle focus on a person; additive keeps the others already focused. */
  const focusPerson = useCallback(
    (id: string, additive = false) => {
      const cur = model.getFocus();
      let next: Set<string> | null;
      if (additive) {
        next = new Set(cur ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next = cur && cur.size === 1 && cur.has(id) ? null : new Set([id]);
      }
      model.setFocus(next);
      if (vp.scroller) vp.scroller.scrollTop = 0;
    },
    [model, vp],
  );
  const clearFocus = useCallback(() => model.setFocus(null), [model]);

  // Search matches (in the people currently shown), in time order.
  const found = useMemo(() => {
    if (!q || !filter) return [];
    const out: { id: string; start: number; userId: string }[] = [];
    for (const r of model.rows) for (const t of r.tasks) if (filter(t)) out.push(t);
    return out.sort((a, b) => a.start - b.start);
  }, [q, filter, model.version]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Scroll to the next (or previous) match after the middle of the view. */
  const jumpToMatch = useCallback(
    (dir: 1 | -1 = 1) => {
      if (!found.length || !vp.scroller) return;
      const mid = vp.firstVisibleDay + vp.visibleDays / 2;
      const cur = selectedRef.current;
      const i = cur ? found.findIndex((f) => f.id === cur) : -1;
      let next = i >= 0 ? found[(i + dir + found.length) % found.length]! : undefined;
      if (!next) {
        next = dir > 0 ? (found.find((f) => f.start > mid) ?? found[0]!) : ([...found].reverse().find((f) => f.start < mid) ?? found[found.length - 1]!);
      }
      setSelected(next.id);
      setEditing(null);
      const ri = model.indexOfUser(next.userId);
      const top = model.rowTops[ri] ?? 0;
      const s = vp.scroller;
      const offscreen = top < s.scrollTop || top + (model.rows[ri]?.height ?? 0) > s.scrollTop + vp.viewHeight;
      vp.scrollToDay(next.start, 0.3, true, offscreen ? top - 24 : undefined);
    },
    [found, model, vp],
  );

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
      anchor.current = { day: vp.scale.dayAt(vp.scroller.scrollLeft + px), px };
      colWRef.current = w;
      setColW(w);
    },
    [vp],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    if (a && vp.scroller) {
      vp.scroller.scrollLeft = scale.xF(a.day) - a.px;
      anchor.current = null;
    }
    if (vp.scroller) labelPinner.update(vp.scroller.scrollLeft + 4);
    winRef.current = { ...winRef.current, d0: Infinity, d1: -Infinity };
    refreshWindow();
    vp.emit();
    try {
      localStorage.setItem(ZOOM_KEY, String(colW));
    } catch {}
  }, [scale, colW, vp, refreshWindow]);

  /** Toggle weekends, keeping the day in the middle of the view in place. */
  const toggleWeekends = useCallback(() => {
    if (vp.scroller) {
      const px = vp.viewWidth / 2;
      anchor.current = { day: vp.scale.dayAt(vp.scroller.scrollLeft + px), px };
    }
    setHideWeekends((h) => {
      writeFlag(WEEKENDS_KEY, !h);
      return !h;
    });
  }, [vp]);
  const toggleDense = useCallback(() => {
    const next = model.dims !== COMPACT;
    writeFlag(DENSITY_KEY, next);
    model.setDims(next ? COMPACT : COMFORTABLE);
    setDense(next);
  }, [model]);
  // --- Jump to a task (from notifications, activity, the palette) ---
  const [activityOpen, setActivityOpen] = useState(false);
  const openActivity = useCallback(() => setActivityOpen(true), []);
  const revealTask = useCallback(
    (id: string) => {
      const t = getTask(id);
      if (!t) return;
      // Make sure its person is on screen.
      const f = model.getFocus();
      if (f && !f.has(t.userId)) model.setFocus(null);
      const team = getUser(t.userId)?.team ?? '';
      if (model.isCollapsed(team)) toggleTeam(team);
      setSelected(id);
      setEditing(null);
      // After the focus/collapse change has laid out the rows.
      requestAnimationFrame(() => {
        vp.scrollToDay(t.start, 0.3, true, (model.rowTops[model.indexOfUser(t.userId)] ?? 0) - 60);
        // Open the editor once the scroll has settled.
        setTimeout(() => setEditing(id), 450);
      });
    },
    [model, vp, toggleTeam],
  );
  useEffect(() => watchDesktopNotifications(revealTask), [revealTask]);

  // --- Presence: share what I look at, select and point at. ---
  useEffect(() => {
    startPresence();
    const share = () => {
      if (!vp.scroller) return;
      const a = vp.firstVisibleDay;
      publish({ view: [a, a + vp.visibleDays] });
    };
    share();
    return vp.onChange(share);
  }, [vp]);
  useEffect(() => publish({ sel: selected }), [selected]);
  const followPeer = useCallback(
    (p: Peer) => {
      if (p.sel && model.findTask(p.sel)) {
        const t = model.findTask(p.sel)!;
        vp.scrollToDay(t.start, 0.3, true, (model.rowTops[model.indexOfUser(t.userId)] ?? 0) - 60);
      } else if (p.view) vp.scrollToDay((p.view[0] + p.view[1]) / 2, 0.5, true);
    },
    [model, vp],
  );
  const onBodyPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const y = vp.yAt(e.clientY);
    const i = model.rowAt(y);
    const row = model.rows[i];
    if (row) publish({ cur: { day: vp.dayAt(e.clientX), user: row.userId, dy: y - model.rowTops[i]! } });
  };

  // --- Saved views ---
  const viewConfig: ViewConfig = useMemo(
    () => ({
      focus: focus ? [...focus] : [],
      query: query.trim(),
      projects: filterState.projects,
      tags: filterState.tags,
      hideWeekends,
      dense,
      colW,
    }),
    [focus, query, filterState, hideWeekends, dense, colW],
  );
  const applyView = useCallback(
    (c: ViewConfig) => {
      if (c.focus) {
        const known = c.focus.filter((id) => store.hasRow('users', id));
        model.setFocus(known.length ? known : null);
      }
      if (c.query !== undefined) setQuery(c.query);
      if (c.projects || c.tags) setFilterState({ projects: c.projects ?? [], tags: c.tags ?? [] });
      if (c.hideWeekends !== undefined && c.hideWeekends !== (vp.scale.hideWeekends)) toggleWeekends();
      if (c.dense !== undefined && c.dense !== (model.dims === COMPACT)) toggleDense();
      if (c.colW) zoomTo(c.colW);
      if (vp.scroller) vp.scroller.scrollTop = 0;
    },
    [model, vp, toggleWeekends, toggleDense, zoomTo],
  );

  // Row heights changed: re-window the rows.
  useEffect(() => {
    winRef.current = { ...winRef.current, r0: -1, r1: -1 };
    refreshWindow();
  }, [dense, refreshWindow]);

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
        // Desktop: a click opens a block, or starts a new one on empty space
        // (unless it's the click that dismisses an open editor).
        onClickBlock: (id) => {
          setSelected(id);
          setEditing(id);
        },
        onClickEmpty: (userId, day, wasEditing) => {
          if (wasEditing || readOnlyRef.current) {
            setSelected(null);
            setEditing(null);
            return;
          }
          const color = getUser(userId)?.color ?? '#4f7cff';
          const id = createTask({ userId, start: day, end: day, title: '', color, lane: -1, notes: '' });
          setSelected(id);
          setEditing(id);
        },
        isSelected: (id) => id === selectedRef.current,
        isEditing: () => editingRef.current !== null,
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
      // ⌘K works from anywhere, even a text field.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('.palette')) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      // Dialogs and drawers handle their own keys.
      if (isTyping(e.target) || importingRef.current || document.querySelector('.modal-backdrop, .drawer-backdrop')) return;
      const mod = e.metaKey || e.ctrlKey;
      // On the projects and clients pages only undo/redo reach the plan.
      if (onPageRef.current && !(mod && /^[zy]$/i.test(e.key))) return;
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
      } else if (e.key === '/' && !mod) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.tb-search input')?.focus();
      } else if (e.key === 'Escape' && !sel && model.getFocus()) {
        model.setFocus(null);
      } else if (!sel || !t) {
        return;
      } else if (e.key === 'f' && !mod) {
        focusPerson(t.userId);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteTask(sel);
        setSelected(null);
        setEditing(null);
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const span = t.end - t.start + 1;
        setSelected(createTask({ ...t, start: t.start + span, end: t.end + span, lane: -1, repeat: '', repeatUntil: 0, skip: '' }));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setEditing(sel);
      } else if (e.key === 'Escape') {
        setSelected(null);
        setEditing(null);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        // Step by visible columns, so hidden weekends are skipped.
        const sc = vp.scale;
        const step = (day: number) => sc.dayOfCol(sc.col(day) + (e.key === 'ArrowLeft' ? -1 : 1));
        let id: string;
        if (e.shiftKey) id = updateTask(sel, { end: Math.max(t.start, step(t.end)) }, 'Resize task');
        else {
          const start = step(t.start);
          id = updateTask(sel, { start, end: sc.hideWeekends ? sc.dayOfCol(sc.col(start) + sc.cols(t.start, t.end) - 1) : t.end + start - t.start }, 'Move task');
        }
        if (id !== sel) setSelected(id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        let i = model.indexOfUser(t.userId) + dir;
        while (model.rows[i]?.kind === 'team') i += dir;
        const row = model.rows[i];
        if (row) {
          const id = updateTask(sel, { userId: row.userId, lane: -1 }, 'Move task');
          if (id !== sel) setSelected(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, vp, zoomTo, todayDay, focusPerson]);

  const closeEditor = useCallback(() => setEditing(null), []);
  // Stable callbacks so the memoized toolbar skips re-rendering on edits.
  const goToday = useCallback(() => vp.scrollToDay(todayDay - 2, 0, true), [vp, todayDay]);
  const page = useCallback((dir: -1 | 1) => vp.scroller?.scrollBy({ left: dir * vp.viewWidth * 0.8, behavior: 'smooth' }), [vp]);
  const openImport = useCallback(() => setImporting({ file: null }), []);

  // --- Command palette (⌘K) ---
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const paletteCommands = useMemo<Command[]>(() => {
    const c: Command[] = [
      { label: 'Go to today', keys: 'T', keywords: 'now jump', run: goToday },
      { label: 'Zoom in', keys: '⌘+', run: () => zoomTo(colWRef.current * 1.4) },
      { label: 'Zoom out', keys: '⌘−', run: () => zoomTo(colWRef.current / 1.4) },
      { label: hideWeekends ? 'Show weekends' : 'Hide weekends', keywords: 'saturday sunday workdays', run: toggleWeekends },
      { label: dense ? 'Comfortable rows' : 'Compact rows', keywords: 'density dense', run: toggleDense },
      { label: 'Show everyone', keywords: 'focus clear people all', run: () => model.setFocus(null) },
      { label: 'Clear filters', keywords: 'project tag search reset', run: () => (setFilterState(NO_FILTER), setQuery('')) },
      { label: 'Find tasks', keys: '/', keywords: 'search', run: () => document.querySelector<HTMLInputElement>('.tb-search input')?.focus() },
      { label: 'Activity', keywords: 'history changelog log who changed', run: openActivity },
      { label: 'Share…', keywords: 'link invite view only private', run: openShare },
    ];
    if (!readOnly)
      c.push(
        { label: 'Add person', keywords: 'new member user', run: () => createUser('New person') },
        { label: 'Add milestone', keywords: 'deadline flag launch', run: addMilestoneHere },
        { label: 'Projects', keywords: 'manage list page', run: manageProjects },
        { label: 'Clients', keywords: 'customers manage list page', run: () => navigate({ section: 'clients' }) },
        { label: 'Plan', keywords: 'timeline back', run: () => navigate({ section: 'plan' }) },
        { label: 'Import from Teamweek…', keywords: 'csv toggl plan upload', run: openImport },
        { label: 'Undo', keys: '⌘Z', run: undo },
        { label: 'Redo', keys: '⇧⌘Z', run: redo },
      );
    return c;
  }, [goToday, zoomTo, hideWeekends, toggleWeekends, dense, toggleDense, model, openActivity, openShare, readOnly, manageProjects, openImport]); // eslint-disable-line react-hooks/exhaustive-deps
  const paletteFocus = useCallback((id: string) => focusPerson(id), [focusPerson]);
  const paletteProject = useCallback((id: string) => setFilterState({ projects: [id], tags: [] }), []);

  // --- Import ---
  const [importing, setImporting] = useState<{ file: File | null } | null>(null);
  const importingRef = useRef(importing);
  importingRef.current = importing;
  // Dropping a CSV anywhere on the app opens the importer with it.
  useEffect(() => {
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const over = (e: DragEvent) => {
      if (isFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      e.preventDefault();
      if (!importingRef.current && /\.(csv|txt)$/i.test(f.name)) setImporting({ file: f });
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const lastPointer = useRef('mouse');

  // --- Space + drag pans (hand cursor), and never starts a block. ---
  const spaceDown = useRef(false);
  const [spacePan, setSpacePan] = useState(false);
  useEffect(() => {
    const isControl = (t: EventTarget | null) => isTyping(t) || (t instanceof HTMLElement && !!t.closest('button, a, select, summary'));
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isControl(e.target) || onPageRef.current || document.querySelector('.modal-backdrop, .drawer-backdrop')) return;
      e.preventDefault(); // no page scroll
      if (!spaceDown.current) {
        spaceDown.current = true;
        setSpacePan(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceDown.current) return;
      spaceDown.current = false;
      setSpacePan(false);
    };
    const blur = () => {
      spaceDown.current = false;
      setSpacePan(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  const [panning, setPanning] = useState(false);
  const startPan = (e: React.PointerEvent) => {
    const s = vp.scroller;
    if (!s || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const left = s.scrollLeft;
    const top = s.scrollTop;
    setPanning(true);
    const move = (ev: PointerEvent) => {
      s.scrollLeft = left - (ev.clientX - x0);
      s.scrollTop = top - (ev.clientY - y0);
    };
    const end = () => {
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const onBodyPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType;
    if (spaceDown.current) return startPan(e);
    dragCtl.pointerDown(e.nativeEvent);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
      if (el) setEditing(el.dataset.task!);
      return;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
    if (el) {
      setSelected(el.dataset.task!);
      setEditing(el.dataset.task!);
      return;
    }
    // With a mouse a single click already created it.
    if ((e.target as HTMLElement).closest('[data-no-drag]') || lastPointer.current === 'mouse') return;
    const row = model.personAt(vp.yAt(e.clientY));
    if (!row) return;
    const day = Math.floor(vp.dayAt(e.clientX));
    const id = createTask({ userId: row.userId, start: day, end: day, title: '', color: row.color, lane: -1, notes: '' });
    setSelected(id);
    setEditing(id);
  };

  // --- Render ---
  const bodyW = scale.x(range.origin + range.days);
  // With the phone sheet open, leave room to scroll the edited block above it.
  const bodyH = Math.max(model.totalHeight + 64 + (compact && editing ? vp.viewHeight * 0.7 : 0), vp.viewHeight);
  const rows = model.rows;
  // Only the rows holding the selected / dragged block get those ids, so a
  // selection change re-renders two rows instead of all of them.
  const selUser = selected ? model.findTask(selected)?.userId : undefined;
  const dragUser = drag ? model.getPreview()?.userId ?? model.findTask(drag.id)?.userId : undefined;
  const rendered = [];
  for (let i = Math.max(0, win.r0); i <= win.r1 && i < rows.length; i++) {
    const r = rows[i]!;
    rendered.push(
      <RowView
        key={r.userId}
        row={r}
        top={model.rowTops[i]!}
        scale={scale}
        dims={model.dims}
        d0={win.d0}
        d1={win.d1}
        selectedId={r.userId === selUser || r.userId === dragUser ? selected : null}
        dragId={r.userId === dragUser ? (drag?.id ?? null) : null}
        filter={filter}
      />,
    );
  }

  const editTask = editing && !drag ? model.findTask(editing) : undefined;
  // Back button closes the editor instead of leaving the app.
  useBackToClose(!!editTask, closeEditor);
  // Phones: a bottom sheet. Desktop: a panel on the right. Both live
  // outside the scroller so they stay put while the timeline scrolls.
  const editor = editTask
    ? createPortal(
        <Editor key={editTask.id} task={editTask} model={model} sheet={compact} side={!compact} readOnly={readOnly} onClose={closeEditor} />,
        document.body,
      )
    : null;

  return (
    <div
      ref={appRef}
      className={'app' + (drag ? ` is-${drag.kind}` : '') + (compact ? ' compact' : '') + (dense ? ' dense' : '') + (readOnly ? ' readonly' : '') + (spacePan ? ' space-pan' : '') + (panning ? ' panning' : '')}
      style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}
    >
      <Toolbar
        colW={colW}
        onZoom={zoomTo}
        onToday={goToday}
        onPage={page}
        model={model}
        query={query}
        onQuery={setQuery}
        matchCount={found.length}
        onNextMatch={jumpToMatch}
        onFocusPerson={focusPerson}
        onClearFocus={clearFocus}
        onImport={openImport}
        hideWeekends={hideWeekends}
        onToggleWeekends={toggleWeekends}
        dense={dense}
        onToggleDense={toggleDense}
        filter={filterState}
        onFilter={setFilterState}
        onManageProjects={manageProjects}
        view={viewConfig}
        onApplyView={applyView}
        onOpenTask={revealTask}
        onOpenActivity={openActivity}
        onFollow={followPeer}
        readOnly={readOnly}
        onShare={openShare}
        onPalette={openPalette}
        onSignIn={openSignIn}
        onWorkspace={setWorkspaceOpen}
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
          <div className={'corner' + (focus ? ' focusing' : '')}>
            <div className="corner-top">
            {focus ? (
              <button className="focus-chip" onClick={clearFocus} title="Show everyone (Esc)">
                <span className="corner-label">Focus</span>
                <span className="corner-count">
                  {model.personCount}/{store.getRowCount('users')}
                </span>
                <span aria-hidden>×</span>
              </button>
            ) : (
              <>
                <span className="corner-label">People</span>
                <span className="corner-count">{model.personCount}</span>
              </>
            )}
            </div>
            <div className="corner-ms">
              <Flag size={13} />
              <span className="corner-ms-label">Milestones</span>
              <button className="corner-ms-add" onClick={addMilestoneHere} aria-label="Add milestone" title="Add milestone (or click the lane)">
                <Plus />
              </button>
            </div>
          </div>
          <div className="header">
            <Header d0={win.d0} d1={win.d1} scale={scale} today={todayDay} />
            <MilestoneBand
              milestones={model.milestones}
              d0={win.d0}
              d1={win.d1}
              scale={scale}
              vp={vp}
              drag={msDrag}
              onDrag={setMsDrag}
              onEdit={editMilestone}
            />
          </div>
          <div className="sidebar">
            <Sidebar
              model={model}
              sheet={compact}
              onToggleTeam={toggleTeam}
              rows={rows}
              tops={model.rowTops}
              r0={Math.max(0, win.r0)}
              r1={win.r1}
              focused={focus !== null}
              today={todayDay}
              onFocusPerson={focusPerson}
            />
            {!focus && (
            <button
              className="add-person"
              style={{ transform: `translateY(${model.totalHeight}px)` }}
              onClick={() => createUser('New person')}
            >
              {compact ? '+' : '+ Add person'}
            </button>
            )}
            {rows.length === 0 && !compact && (
              <p className="sidebar-empty" style={{ transform: `translateY(${model.totalHeight}px)` }}>
                No people yet. Add someone, then drag across their row to plan work.
              </p>
            )}
          </div>
          <div
            className="body"
            onPointerDown={onBodyPointerDown}
            onPointerMove={onBodyPointerMove}
            onPointerLeave={() => publish({ cur: null })}
            onDoubleClick={onDoubleClick}
          >
            <GridBackground d0={win.d0} d1={win.d1} scale={scale} height={bodyH} today={todayDay} />
            <MilestoneLines milestones={model.milestones} d0={win.d0} d1={win.d1} scale={scale} height={bodyH} drag={msDrag} />
            {rendered}
            {rows.length === 0 && compact && (
              <div className="empty" style={{ transform: `translateX(${(vp.scroller?.scrollLeft ?? 0) + 32}px)` }}>
                No people on this sheet yet. Add someone on the left, then drag across their row to plan work.
              </div>
            )}
            <PresenceLayer model={model} scale={scale} version={model.version} />
            {editor}
          </div>
        </div>
      </div>
      {!compact && !onPage && (
        // Zoom: a quiet pill over the timeline's corner (pinch and ⌘-wheel
        // are the main way); the slider opens on hover.
        <div className="zoom-pill">
          <button className="btn icon" onClick={() => zoomTo(colW / 1.25)} aria-label="Zoom out" title="Zoom out (⌘−, pinch)">
            <Minus />
          </button>
          <input
            type="range"
            min={Math.log(ZOOM_MIN)}
            max={Math.log(ZOOM_MAX)}
            step={0.01}
            value={Math.log(colW)}
            onChange={(e) => zoomTo(Math.exp(Number(e.currentTarget.value)))}
            aria-label="Zoom"
          />
          <button className="btn icon" onClick={() => zoomTo(colW * 1.25)} aria-label="Zoom in" title="Zoom in (⌘+, pinch)">
            <Plus />
          </button>
        </div>
      )}
      <div className="bottombar">
        <div className="bottombar-left">
          <VisibleRange vp={vp} />
          <span>Drag the strip to scrub through time</span>
        </div>
        <Minimap model={model} vp={vp} today={todayDay} filter={filter} />
      </div>
      {msEdit && <MilestoneEditor key={msEdit.id} id={msEdit.id} anchor={msEdit.anchor} fresh={msEdit.fresh} sheet={compact} onClose={() => setMsEdit(null)} />}
      {sharing && <ShareDialog onClose={() => setSharing(false)} />}
      {palette && (
        <CommandPalette
          model={model}
          commands={paletteCommands}
          onFocusPerson={paletteFocus}
          onFilterProject={paletteProject}
          onApplyView={applyView}
          onOpenTask={revealTask}
          onClose={() => setPalette(false)}
        />
      )}
      {access?.role === 'none' && <LockScreen signedIn={!!access.signedIn} deleted={access.deleted} onSignIn={openSignIn} />}
      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
      {workspaceOpen && <WorkspaceDialog workspaceId={workspaceOpen} onClose={() => setWorkspaceOpen(null)} />}
      {activityOpen && (
        <ActivityPanel
          onClose={() => setActivityOpen(false)}
          onOpenTask={(id) => {
            setActivityOpen(false);
            revealTask(id);
          }}
        />
      )}
      {onPage && (
        <Pages
          model={model}
          route={route}
          onOpenInPlan={(projects) => {
            setFilterState({ projects, tags: [] });
            navigate({ section: 'plan' });
          }}
          onOpenTask={(id) => {
            navigate({ section: 'plan' });
            requestAnimationFrame(() => revealTask(id));
          }}
        />
      )}
      {importing && (
        <ImportDialog
          initialFile={importing.file}
          onClose={() => setImporting(null)}
          onImported={(range) => {
            setImporting(null);
            // Show the imported work if it's nowhere near the current view.
            if (range && (todayDay < range[0] || todayDay > range[1])) vp.scrollToDay(range[0], 0.1, true);
          }}
        />
      )}
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
