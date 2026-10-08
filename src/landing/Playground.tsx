// The footer's little puzzle: fit this week's work into the team's free
// days. Drag a block onto a row (or tap it, then tap a day); blocks only fit
// where the days are free. Fill every day and the next week comes up, a
// little harder each time (more people, some time off in the way).

import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const PEOPLE = ['Ava', 'Noah', 'Mila'];
const COLORS = ['#3b6fd4', '#2a9a6a', '#d9473f', '#d69a1f', '#8452d6', '#1d98ab', '#d2448d', '#e2692a'];
const TITLES = ['Kickoff', 'Workshop', 'Review', 'Launch', 'Pitch', 'Research', 'Design', 'Build', 'Retro', 'Testing', 'Copy', 'Demo', 'Sprint', 'Interviews', 'Offsite'];

interface Piece {
  id: number;
  len: number;
  title: string;
  color: string;
  /** Where it sits on the board, or null in the tray. */
  at: { row: number; col: number } | null;
}
interface Puzzle {
  rows: number;
  /** Days already off: "row:col". */
  off: Set<string>;
  pieces: Piece[];
}

const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T,>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** A solvable week: free days cut into blocks of 1–3 days, then shuffled. */
const makePuzzle = (level: number): Puzzle => {
  const rows = level < 1 ? 2 : 3;
  const off = new Set<string>();
  if (level >= 2) for (let k = 0; k < 1 + (level >= 4 ? 1 : 0); k++) off.add(`${rand(rows)}:${rand(5)}`);
  const pieces: Piece[] = [];
  const titles = shuffle([...TITLES]);
  let id = 0;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < 5) {
      if (off.has(`${r}:${c}`)) {
        c++;
        continue;
      }
      let run = 0;
      while (c + run < 5 && !off.has(`${r}:${c + run}`)) run++;
      // Cut the free run into pieces, longer ones first so it isn't all 1s.
      while (run > 0) {
        const len = Math.min(run, run === 4 ? 2 : 1 + rand(3));
        pieces.push({ id: id++, len, title: titles[id % titles.length]!, color: COLORS[rand(COLORS.length)]!, at: null });
        run -= len;
        c += len;
      }
    }
  }
  return { rows, off, pieces: shuffle(pieces) };
};

const fits = (p: Puzzle, piece: Piece, row: number, col: number) => {
  if (row < 0 || row >= p.rows || col < 0 || col + piece.len > 5) return false;
  for (let c = col; c < col + piece.len; c++) {
    if (p.off.has(`${row}:${c}`)) return false;
    for (const o of p.pieces) if (o !== piece && o.at && o.at.row === row && c >= o.at.col && c < o.at.col + o.len) return false;
  }
  return true;
};

export function Playground() {
  const [level, setLevel] = useState(0);
  const [puzzle, setPuzzle] = useState(() => makePuzzle(0));
  const [picked, setPicked] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: number; dx: number; dy: number; target: { row: number; col: number } | null } | null>(null);
  const grab = useRef<{ id: number; x: number; y: number; offX: number; moved: boolean } | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const solved = puzzle.pieces.every((p) => p.at);

  // Solved: a moment to enjoy it, then next week.
  useEffect(() => {
    if (!solved) return;
    const t = setTimeout(() => {
      setLevel((l) => l + 1);
      setPuzzle(makePuzzle(level + 1));
      setPicked(null);
    }, 1600);
    return () => clearTimeout(t);
  }, [solved, level]);

  const place = useCallback((id: number, at: { row: number; col: number } | null) => {
    setPuzzle((p) => {
      const piece = p.pieces.find((x) => x.id === id)!;
      if (at && !fits(p, piece, at.row, at.col)) return p;
      return { ...p, pieces: p.pieces.map((x) => (x.id === id ? { ...x, at } : x)) };
    });
  }, []);

  /** The board cell under a point, for a piece grabbed `offX` px from its left edge. */
  const cellAt = (x: number, y: number, offX: number) => {
    const r = board.current?.getBoundingClientRect();
    if (!r) return null;
    const cw = r.width / 5;
    const rh = r.height / puzzle.rows;
    if (y < r.top - rh * 0.3 || y > r.bottom + rh * 0.3 || x < r.left - cw || x > r.right + cw) return null;
    return { row: Math.min(puzzle.rows - 1, Math.max(0, Math.floor((y - r.top) / rh))), col: Math.round((x - offX - r.left) / cw) };
  };

  const down = (e: RPointerEvent<HTMLButtonElement>, id: number) => {
    if (solved || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    grab.current = { id, x: e.clientX, y: e.clientY, offX: e.clientX - rect.left, moved: false };
  };
  const move = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    g.moved = true;
    const t = cellAt(e.clientX, e.clientY, g.offX);
    const piece = puzzle.pieces.find((p) => p.id === g.id)!;
    setDrag({ id: g.id, dx, dy, target: t && fits(puzzle, piece, t.row, t.col) ? t : null });
  };
  const up = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    grab.current = null;
    if (!g) return;
    if (!g.moved) {
      setPicked((p) => (p === g.id ? null : g.id));
      setDrag(null);
      return;
    }
    const t = cellAt(e.clientX, e.clientY, g.offX);
    const piece = puzzle.pieces.find((p) => p.id === g.id)!;
    if (t && fits(puzzle, piece, t.row, t.col)) place(g.id, t);
    // Dropped away from the board: back to the tray.
    else if (!t) place(g.id, null);
    setDrag(null);
    setPicked(null);
  };

  /** Tap a day with a block picked up: put it there. */
  const tapCell = (row: number, col: number) => {
    if (picked === null) return;
    const piece = puzzle.pieces.find((p) => p.id === picked)!;
    // Tapped somewhere it doesn't fit from there: try it ending on that day.
    const start = fits(puzzle, piece, row, col) ? col : col - piece.len + 1;
    if (fits(puzzle, piece, row, start)) {
      place(picked, { row, col: start });
      setPicked(null);
    }
  };

  const pieceEl = (p: Piece) => {
    const dragging = drag?.id === p.id;
    return (
      <button
        key={p.id}
        type="button"
        className={'lp-fit-piece' + (dragging ? ' dragging' : '') + (picked === p.id ? ' picked' : '')}
        style={{
          ['--len' as string]: p.len,
          ...(p.at ? { gridRow: p.at.row + 1, gridColumn: `${p.at.col + 1} / span ${p.len}` } : {}),
          ...(dragging ? { transform: `translate(${drag!.dx}px, ${drag!.dy}px)` } : {}),
        }}
        aria-label={`${p.title}, ${p.len} day${p.len > 1 ? 's' : ''}${p.at ? `, ${PEOPLE[p.at.row]} from ${DAYS[p.at.col]}` : ''}`}
        onPointerDown={(e) => down(e, p.id)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          grab.current = null;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPicked((x) => (x === p.id ? null : p.id));
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && p.at) place(p.id, null);
        }}
      >
        <span className="task lp-task" style={{ ['--c' as string]: p.color }}>
          <span className="task-clip">
            <span className="task-label tall">
              <span className="task-title">{p.title}</span>
              <span className="task-sub">
                <span className="task-meta">{p.len}d</span>
              </span>
            </span>
          </span>
        </span>
      </button>
    );
  };

  const target = drag?.target;
  const draggedLen = drag ? puzzle.pieces.find((p) => p.id === drag.id)!.len : 0;
  return (
    <section className={'lp-fit' + (solved ? ' solved' : '')} aria-label="A small puzzle: plan the week">
      <p className="lp-fit-title">
        {solved ? (
          <b>Week planned. Nice.</b>
        ) : (
          <>
            <b>Spare a minute?</b> Fit this week’s work into the free days.
          </>
        )}
        {level > 0 && <span className="lp-fit-score">{level === 1 ? '1 week planned' : `${level} weeks planned`}</span>}
      </p>
      <div className="lp-fit-wrap">
        <div className="lp-fit-names" aria-hidden style={{ ['--rows' as string]: puzzle.rows }}>
          {PEOPLE.slice(0, puzzle.rows).map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
        <div>
          <div className="lp-fit-days" aria-hidden>
            {DAYS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="lp-fit-board" ref={board} style={{ ['--rows' as string]: puzzle.rows }}>
            {Array.from({ length: puzzle.rows * 5 }, (_, i) => {
              const row = Math.floor(i / 5);
              const col = i % 5;
              const isOff = puzzle.off.has(`${row}:${col}`);
              const lit = target && target.row === row && col >= target.col && col < target.col + draggedLen;
              return (
                <button
                  key={i}
                  type="button"
                  tabIndex={picked === null || isOff ? -1 : 0}
                  className={'lp-fit-cell' + (isOff ? ' off' : '') + (lit ? ' lit' : '')}
                  style={{ gridRow: row + 1, gridColumn: col + 1 }}
                  aria-label={isOff ? `${PEOPLE[row]} is off on ${DAYS[col]}` : `${PEOPLE[row]}, ${DAYS[col]}`}
                  onClick={() => tapCell(row, col)}
                >
                  {isOff && <span>Off</span>}
                </button>
              );
            })}
            {puzzle.pieces.filter((p) => p.at).map(pieceEl)}
          </div>
        </div>
      </div>
      <div className="lp-fit-tray">{puzzle.pieces.filter((p) => !p.at).map(pieceEl)}</div>
    </section>
  );
}
