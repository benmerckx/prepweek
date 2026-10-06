// The footer's playground: a little timeline of blocks to fiddle with. Drag
// a block to another day and it drops into place (blocks stack like lanes in
// the app, so dropping one low lifts the ones above), tap one to recolor it,
// tap an empty spot to drop in a new one. Fill a row edge to edge and it
// clears. Nothing is saved.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

const COLORS = ['#3b7bff', '#20b55c', '#f04438', '#f5b301', '#9b5cff', '#0fc2d8', '#f72585', '#8ccf12', '#ff7b1c'];
const PATTERNS = ['', 'dots', '', 'stripes', '', 'zigzag', 'waves', '', 'triangles', 'rings'];
const TITLES = [
  'Coffee', 'Ship it', 'Inbox zero', 'Nap', 'Big launch', '1:1', 'Retro', 'Deep work', 'Lunch', 'Friday drinks',
  'Bug bash', 'Pitch', 'Standup', 'Pizza', 'Demo day', 'Workshop', 'Moodboard', 'Hotfix', 'Offsite', 'Brainstorm',
  'Rebrand', 'Focus time', 'Kickoff', 'Walk', 'Cake', 'Review',
];
const LANES = 5;
/** A block (44px) and the gap above it. */
const LANE_H = 52;
const FALL_MS = 380;
const CLEAR_MS = 460;

interface B {
  id: number;
  col: number;
  span: number;
  /** Lane from the bottom. */
  row: number;
  title: string;
  color: string;
  pattern: string;
  /** Where it's drawn while held or falling in, between lanes and days. */
  fx?: number;
  fy?: number;
  clearing?: boolean;
}

/** Drop order for the opening layout: a bottom row one gap short of clearing. */
const OPENING: Record<5 | 10, Omit<B, 'id' | 'row'>[]> = {
  10: [
    { col: 0, span: 4, title: 'Website relaunch', color: '#3b7bff', pattern: 'stripes' },
    { col: 4, span: 2, title: 'Workshop', color: '#f5b301', pattern: '' },
    { col: 7, span: 3, title: 'Big launch', color: '#9b5cff', pattern: 'zigzag' },
    { col: 1, span: 2, title: 'Coffee', color: '#ff7b1c', pattern: '' },
    { col: 4, span: 3, title: 'Deep work', color: '#20b55c', pattern: 'dots' },
    { col: 8, span: 1, title: 'Nap', color: '#0fc2d8', pattern: '' },
    { col: 2, span: 2, title: 'Pizza', color: '#f72585', pattern: 'waves' },
  ],
  5: [
    { col: 0, span: 2, title: 'Relaunch', color: '#3b7bff', pattern: 'stripes' },
    { col: 3, span: 2, title: 'Big launch', color: '#9b5cff', pattern: 'zigzag' },
    { col: 1, span: 2, title: 'Coffee', color: '#ff7b1c', pattern: '' },
    { col: 4, span: 1, title: 'Nap', color: '#0fc2d8', pattern: '' },
  ],
};
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr'];

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Stack blocks like lanes: in order of height, each lands on whatever is
 * under its days. `order` overrides the height used for sorting (a block
 * let go between lanes slots in there).
 */
const settle = (blocks: B[], cols: number, order: Map<number, number> = new Map()): B[] => {
  const heights = new Array<number>(cols).fill(0);
  const sorted = [...blocks].sort((a, b) => (order.get(a.id) ?? a.row) - (order.get(b.id) ?? b.row) || a.col - b.col);
  const rows = new Map<number, number>();
  for (const b of sorted) {
    let row = 0;
    for (let c = b.col; c < b.col + b.span; c++) row = Math.max(row, heights[c]!);
    for (let c = b.col; c < b.col + b.span; c++) heights[c] = row + 1;
    rows.set(b.id, row);
  }
  return blocks.map((b) => ({ ...b, row: rows.get(b.id)! }));
};

/** Lanes filled edge to edge. */
const fullRows = (blocks: B[], cols: number) => {
  const filled = new Map<number, number>();
  for (const b of blocks) if (!b.clearing) filled.set(b.row, (filled.get(b.row) ?? 0) + b.span);
  return [...filled].filter(([, n]) => n >= cols).map(([row]) => row);
};

let nextId = 1;

export function Playground() {
  const [cols, setCols] = useState<5 | 10>(() => (matchMedia('(max-width: 640px)').matches ? 5 : 10));
  const [blocks, setBlocks] = useState<B[]>([]);
  const [cleared, setCleared] = useState(0);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const els = useRef(new Map<number, HTMLElement>());
  const drag = useRef<{ id: number; px: number; py: number; x0: number; y0: number; colW: number; moved: boolean } | null>(null);
  const live = useRef(blocks);
  live.current = blocks;

  const say = useCallback((text: string) => setToast({ text, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  /** A little squash when a block lands after a fall. */
  const bump = useCallback((ids: number[], delay = FALL_MS) => {
    if (reduced()) return;
    for (const id of ids)
      els.current.get(id)?.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.04, 0.84)' }, { transform: 'scale(0.98, 1.05)' }, { transform: 'scale(1)' }],
        { duration: 320, delay, easing: 'ease-out' },
      );
  }, []);

  // Full lanes flash and go; what's above falls in (and may clear again).
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (blocks.some((b) => b.clearing || b.fx !== undefined)) return;
    const rows = fullRows(blocks, cols);
    if (!rows.length) return;
    setBlocks(blocks.map((b) => (rows.includes(b.row) ? { ...b, clearing: true } : b)));
    setCleared((n) => n + rows.length);
    say(rows.length > 1 ? `${rows.length} rows cleared!` : pick(['Week cleared!', 'All done. Nice!', 'Cleared!', 'Shipped!']));
    clearTimer.current = setTimeout(() => {
      const kept = live.current.filter((b) => !b.clearing);
      const settled = settle(kept, cols);
      setBlocks(settled);
      bump(settled.filter((b) => b.row < kept.find((k) => k.id === b.id)!.row).map((b) => b.id), 180);
    }, CLEAR_MS);
  }, [blocks, cols, say, bump]);
  useEffect(() => () => clearTimeout(clearTimer.current), []);

  /** Put `b` in at its column (falling from `from`, a height between lanes). */
  const land = useCallback(
    (others: B[], b: B, from: number, fallback?: B): boolean => {
      const settled = settle([...others, b], cols, new Map([[b.id, from]]));
      if (settled.some((x) => x.row >= LANES)) {
        if (!reduced())
          board.current?.animate([{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], {
            duration: 360,
          });
        say(pick(['Overbooked!', 'Too much on the plate', 'No room this week']));
        if (fallback) setBlocks([...others, { ...fallback, fx: undefined, fy: undefined }]);
        return false;
      }
      const placed = settled.map((x) => (x.id === b.id ? { ...x, fx: b.fx, fy: b.fy } : x));
      setBlocks(placed);
      // Next frame: let go of the drawn position, so it slides/falls into its lane.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setBlocks((cur) => cur.map((x) => (x.id === b.id ? { ...x, fx: undefined, fy: undefined } : x)));
          bump([b.id]);
        }),
      );
      return true;
    },
    [cols, bump, say],
  );

  const spawn = useCallback(
    (spec?: Partial<B>, col?: number) => {
      const span = spec?.span ?? (cols === 5 ? pick([1, 1, 2]) : pick([1, 2, 2, 3]));
      const at = clamp(spec?.col ?? (col !== undefined ? col - Math.floor(span / 2) : Math.floor(Math.random() * cols)), 0, cols - span);
      const b: B = {
        id: nextId++,
        col: at,
        span,
        row: LANES,
        title: spec?.title ?? pick(TITLES),
        color: spec?.color ?? pick(COLORS),
        pattern: spec?.pattern ?? pick(PATTERNS),
        fx: at,
        fy: LANES + 0.6,
      };
      return land(live.current.filter((x) => !x.clearing), b, LANES + 1);
    },
    [cols, land],
  );

  // The opening layout rains in once the footer is in view.
  const started = useRef(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting || started.current) return;
        started.current = true;
        OPENING[cols].forEach((spec, i) => timers.push(setTimeout(() => spawn(spec), reduced() ? 0 : 150 + i * 170)));
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [cols, spawn]);

  // Phone ⇄ desktop: start over at the new width.
  useEffect(() => {
    const mq = matchMedia('(max-width: 640px)');
    const on = () => {
      const c = mq.matches ? 5 : 10;
      if (c === cols) return;
      setCols(c);
      setBlocks([]);
      started.current = false;
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [cols]);

  const recolor = (id: number) => {
    setBlocks((cur) =>
      cur.map((b) => (b.id === id ? { ...b, color: COLORS[(COLORS.indexOf(b.color) + 1) % COLORS.length]!, pattern: PATTERNS[(PATTERNS.indexOf(b.pattern) + 3) % PATTERNS.length]! } : b)),
    );
    if (!reduced())
      els.current.get(id)?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
  };

  const move = (id: number, col: number, from: number) => {
    const b = live.current.find((x) => x.id === id);
    if (!b || b.clearing) return;
    const moved = { ...b, col: clamp(Math.round(col), 0, cols - b.span) };
    land(
      live.current.filter((x) => x.id !== id && !x.clearing),
      moved,
      from,
      b,
    );
  };

  const onDown = (e: PointerEvent<HTMLButtonElement>, b: B) => {
    if (b.clearing || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: b.id, px: e.clientX, py: e.clientY, x0: b.col, y0: b.row, colW: (board.current?.clientWidth ?? 600) / cols, moved: false };
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setBlocks((cur) =>
      cur.map((b) => (b.id === d.id ? { ...b, fx: clamp(d.x0 + dx / d.colW, 0, cols - b.span), fy: clamp(d.y0 - dy / LANE_H, 0, LANES + 0.4) } : b)),
    );
  };
  const onUp = (b: B) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== b.id) return;
    if (!d.moved) return recolor(b.id);
    const cur = live.current.find((x) => x.id === b.id);
    if (cur) move(b.id, cur.fx ?? cur.col, (cur.fy ?? cur.row) - 0.5);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, b: B) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      move(b.id, b.col + (e.key === 'ArrowLeft' ? -1 : 1), b.row - 0.5);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      setBlocks((cur) => settle(cur.filter((x) => x.id !== b.id), cols));
    }
  };

  /** A tap on an empty spot drops a new block there. */
  const onBoard = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !board.current) return;
    const r = board.current.getBoundingClientRect();
    spawn(undefined, Math.floor(((e.clientX - r.left) / r.width) * cols));
  };

  const days = Array.from({ length: cols }, (_, i) => `${DAYS[i % 5]} ${[5, 6, 7, 8, 9, 12, 13, 14, 15, 16][i]}`);

  return (
    <section className="lp-play" ref={root} aria-label="Playground: blocks to play with">
      <div className="lp-play-head">
        <div>
          <h3>All planned? Have a play.</h3>
          <p>
            Drag a block to another day, tap one to recolor it, tap an empty spot to drop in a new one. Fill a row edge to edge to clear it.
          </p>
        </div>
        <div className="lp-play-actions">
          <span className="lp-play-score" aria-live="polite">
            <b key={cleared}>{cleared}</b> {cleared === 1 ? 'row' : 'rows'} cleared
          </span>
          <button className="lp-btn ghost" onClick={() => spawn()}>
            Drop a block
          </button>
          <button
            className="lp-btn ghost"
            onClick={() => {
              setBlocks([]);
              setCleared(0);
              started.current = false;
              OPENING[cols].forEach((spec, i) => setTimeout(() => spawn(spec), 120 + i * 140));
            }}
          >
            Start over
          </button>
        </div>
      </div>
      <div className="lp-play-days" style={{ ['--cols' as string]: cols }} aria-hidden>
        {days.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div
        ref={board}
        className="lp-play-board"
        style={{ ['--cols' as string]: cols, height: LANES * LANE_H + 8 }}
        onPointerDown={onBoard}
      >
        {blocks.map((b) => {
          const x = b.fx ?? b.col;
          const y = b.fy ?? b.row;
          const held = drag.current?.id === b.id && drag.current.moved;
          return (
            <button
              key={b.id}
              ref={(el) => {
                if (el) els.current.set(b.id, el);
                else els.current.delete(b.id);
              }}
              className={'lp-play-block' + (held ? ' held' : '') + (b.clearing ? ' clearing' : '') + (b.fx !== undefined && !held ? ' entering' : '')}
              style={{ ['--x' as string]: x, ['--y' as string]: y, ['--span' as string]: b.span } as CSSProperties}
              aria-label={`${b.title}, ${days[b.col]}${b.span > 1 ? ` to ${days[b.col + b.span - 1]}` : ''}. Arrow keys move it, Enter recolors it.`}
              onPointerDown={(e) => onDown(e, b)}
              onPointerMove={onMove}
              onPointerUp={() => onUp(b)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={(e) => onKey(e, b)}
              onClick={(e) => e.detail === 0 && recolor(b.id)}
            >
              <span className="task lp-task" data-pattern={b.pattern || undefined} style={{ ['--c' as string]: b.color }}>
                <span className="task-clip">
                  <span className="task-label tall">
                    <span className="task-title">{b.title}</span>
                    <span className="task-sub">
                      <span className="task-meta">{b.span > 1 ? `${b.span}d` : '1d'}</span>
                    </span>
                  </span>
                </span>
              </span>
            </button>
          );
        })}
        {toast && (
          <span className="lp-play-toast" key={toast.key} role="status">
            {toast.text}
          </span>
        )}
      </div>
    </section>
  );
}
