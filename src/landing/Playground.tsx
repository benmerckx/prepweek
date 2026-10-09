// The daily week (see daily.ts): plan a small team's week so that every
// block is on the board and every rule holds. The same puzzle for everyone
// each day, easy early in the week and hard on Friday, with a timer, moves,
// a streak and a line to share. Drag a block onto a day (or tap it, then
// tap a day); drag it off the board to put it back. On the home page's
// footer and on its own page, /daily.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  DAYS,
  LEVELS,
  PEOPLE,
  dailyWeek,
  fits,
  isSolved,
  localDay,
  practiceWeek,
  ruleBlocks,
  ruleState,
  ruleText,
  type Place,
  type Rule,
  type Week,
} from './daily.ts';
import { trackEvent } from '../lib/stats.ts';

// --- Saved progress (this device) ---

interface Saved {
  number: number;
  places: Place[];
  moves: number;
  /** Seconds spent so far. */
  time: number;
  done: 'solved' | 'shown' | null;
}
const KEY = 'prepweek:daily';
const HISTORY = 'prepweek:daily-history';
const load = (number: number): Saved | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    return s && s.number === number ? s : null;
  } catch {
    return null;
  }
};
const save = (s: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
};
/** Puzzle numbers solved without peeking. */
const solvedNumbers = (): number[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY) ?? '[]') as number[];
  } catch {
    return [];
  }
};
const markSolved = (n: number) => {
  try {
    localStorage.setItem(HISTORY, JSON.stringify([...new Set([...solvedNumbers(), n])].slice(-400)));
  } catch {}
};
/** Days in a row, up to today (or yesterday, while today's is still open). */
const streakOf = (today: number) => {
  const set = new Set(solvedNumbers());
  let n = set.has(today) ? today : today - 1;
  let streak = 0;
  while (set.has(n)) {
    streak++;
    n--;
  }
  return streak;
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const untilMidnight = () => {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const m = Math.ceil((next.getTime() - now.getTime()) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

// --- Bits ---

const RuleIcon = ({ kind }: { kind: Rule['kind'] }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'day' && (
      <>
        <rect x="2.5" y="3.25" width="11" height="10.25" rx="2" />
        <path d="M2.5 6.5h11M5.5 1.75v2.5M10.5 1.75v2.5" />
      </>
    )}
    {kind === 'after' && <path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" />}
    {kind === 'together' && (
      <>
        <rect x="2" y="3" width="8" height="4.5" rx="1.5" />
        <rect x="6" y="8.5" width="8" height="4.5" rx="1.5" />
      </>
    )}
  </svg>
);
const StateIcon = ({ state }: { state: boolean | null }) =>
  state === null ? (
    <span className="lp-dw-state" aria-label="Not placed yet" />
  ) : (
    <span className={'lp-dw-state ' + (state ? 'ok' : 'bad')} aria-label={state ? 'Holds' : 'Broken'}>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {state ? <path d="m3.5 8.5 3 3 6-7" /> : <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      </svg>
    </span>
  );

// --- The game ---

export function DailyWeek({ page = false }: { page?: boolean }) {
  const today = useMemo(() => localDay(), []);
  const daily = useMemo(() => dailyWeek(today), [today]);
  const [week, setWeek] = useState<Week>(daily);
  const practice = week !== daily;
  const saved = useMemo(() => load(daily.number), [daily]);
  const [places, setPlaces] = useState<Place[]>(() => saved?.places ?? daily.pieces.map(() => null));
  const [moves, setMoves] = useState(saved?.moves ?? 0);
  const [time, setTime] = useState(saved?.time ?? 0);
  const [done, setDone] = useState<Saved['done']>(saved?.done ?? null);
  const [picked, setPicked] = useState<number | null>(null);
  const [hot, setHot] = useState<number[]>([]);
  const [drag, setDrag] = useState<{ id: number; dx: number; dy: number; target: { row: number; col: number } | null } | null>(null);
  const [shared, setShared] = useState('');
  const grab = useRef<{ id: number; x: number; y: number; offX: number; moved: boolean } | null>(null);
  const board = useRef<HTMLDivElement>(null);

  const started = moves > 0;
  const solved = done === 'solved';

  // Keep today's progress (not a practice week's).
  useEffect(() => {
    if (!practice) save({ number: daily.number, places, moves, time, done });
  }, [practice, daily, places, moves, time, done]);

  // The clock runs from the first move until it's done, while the page is in view.
  useEffect(() => {
    if (!started || done) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setTime((s) => s + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [started, done]);

  // All placed and every rule holding: done.
  useEffect(() => {
    if (done || !isSolved(week, places)) return;
    setDone('solved');
    setPicked(null);
    trackEvent('daily_solve', practice ? 'practice' : LEVELS[week.level]);
    // No focus ring left on the last block placed.
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.lp-dw')) document.activeElement.blur();
    if (!practice) markSolved(daily.number);
  }, [week, places, done, practice, daily]);

  const place = (i: number, at: Place) => {
    if (done) return;
    if (at && !fits(week, places, i, at.row, at.col)) return;
    const cur = places[i];
    if (cur === at || (cur && at && cur.row === at.row && cur.col === at.col)) return;
    setPlaces(places.map((p, j) => (j === i ? at : p)));
    if (moves === 0) trackEvent('daily_play', practice ? 'practice' : LEVELS[week.level]);
    setMoves((m) => m + 1);
  };

  const restart = (w: Week) => {
    setWeek(w);
    setPlaces(w.pieces.map(() => null));
    setMoves(0);
    setTime(0);
    setDone(null);
    setPicked(null);
    setShared('');
  };
  const showAnswer = () => {
    trackEvent('daily_reveal', practice ? 'practice' : LEVELS[week.level]);
    setPlaces(week.solution);
    setDone('shown');
    setPicked(null);
  };

  // --- What holds, what's broken ---
  const states = week.rules.map((r) => ruleState(r, week.pieces, places));
  const broken = new Set<number>();
  week.rules.forEach((r, k) => {
    if (states[k] === false) for (const i of ruleBlocks(r)) broken.add(i);
  });
  const whoOf = (i: number) => week.rules.find((r) => r.kind === 'who' && r.piece === i) as Extract<Rule, { kind: 'who' }> | undefined;
  const listed = week.rules.map((r, k) => ({ r, k })).filter(({ r }) => r.kind !== 'who');
  const placed = places.filter(Boolean).length;

  // --- Dragging ---
  const cellAt = (x: number, y: number, offX: number) => {
    const r = board.current?.getBoundingClientRect();
    if (!r) return null;
    const cw = r.width / 5;
    const rh = r.height / week.rows;
    if (y < r.top - rh * 0.4 || y > r.bottom + rh * 0.4 || x < r.left - cw || x > r.right + cw) return null;
    return { row: Math.min(week.rows - 1, Math.max(0, Math.floor((y - r.top) / rh))), col: Math.round((x - offX - r.left) / cw) };
  };
  const down = (e: RPointerEvent<HTMLButtonElement>, i: number) => {
    if (done || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    grab.current = { id: i, x: e.clientX, y: e.clientY, offX: e.clientX - rect.left, moved: false };
  };
  const move = (e: RPointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    g.moved = true;
    const t = cellAt(e.clientX, e.clientY, g.offX);
    setDrag({ id: g.id, dx, dy, target: t && fits(week, places, g.id, t.row, t.col) ? t : null });
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
    if (t && fits(week, places, g.id, t.row, t.col)) place(g.id, t);
    // Dropped away from the board: back to the tray.
    else if (!t) place(g.id, null);
    setDrag(null);
    setPicked(null);
  };
  /** Tap a day with a block picked up: put it there (or ending there, if it only fits that way). */
  const tapCell = (row: number, col: number) => {
    if (picked === null) return;
    const len = week.pieces[picked]!.len;
    for (const start of [col, col - len + 1, col - 1]) {
      if (fits(week, places, picked, row, start)) {
        place(picked, { row, col: start });
        setPicked(null);
        return;
      }
    }
  };

  // --- Sharing ---
  const share = async () => {
    trackEvent('daily_share');
    const streak = streakOf(daily.number);
    const text = [
      `Prepweek Daily #${daily.number} · ${LEVELS[daily.level]}`,
      `✅ ${clock(time)} · ${moves} moves${streak > 1 ? ` · 🔥 ${streak}` : ''}`,
      `${location.origin}/daily`,
    ].join('\n');
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setShared('Copied, paste it anywhere');
      }
    } catch {
      /* closed the share sheet */
    }
  };

  const pieceEl = (i: number) => {
    const p = week.pieces[i]!;
    const at = places[i];
    const dragging = drag?.id === i;
    const who = whoOf(i);
    return (
      <button
        key={p.id}
        type="button"
        className={
          'lp-fit-piece' +
          (dragging ? ' dragging' : '') +
          (picked === i ? ' picked' : '') +
          (broken.has(i) ? ' broken' : '') +
          (hot.includes(i) ? ' hot' : '')
        }
        style={{
          ['--len' as string]: p.len,
          ...(at ? { gridRow: at.row + 1, gridColumn: `${at.col + 1} / span ${p.len}` } : {}),
          ...(dragging ? { transform: `translate(${drag!.dx}px, ${drag!.dy}px)` } : {}),
        }}
        aria-label={`${p.title}, ${p.len} day${p.len > 1 ? 's' : ''}${who ? `, ${who.people.map((x) => PEOPLE[x]).join(' or ')} only` : ''}${at ? `, ${PEOPLE[at.row]} from ${DAYS[at.col]}` : ''}`}
        onPointerDown={(e) => down(e, i)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          grab.current = null;
          setDrag(null);
        }}
        onPointerEnter={() => setHot(week.rules.filter((r) => ruleBlocks(r).includes(i)).flatMap(ruleBlocks))}
        onPointerLeave={() => setHot([])}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPicked((x) => (x === i ? null : i));
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && at) place(i, null);
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
          {who && (
            <span className="lp-dw-who" title={`${who.people.map((x) => PEOPLE[x]).join(' or ')} only`}>
              {who.people.map((x) => (
                <i key={x}>{PEOPLE[x]![0]}</i>
              ))}
            </span>
          )}
        </span>
      </button>
    );
  };

  const target = drag?.target;
  const draggedLen = drag ? week.pieces[drag.id]!.len : 0;
  const streak = streakOf(daily.number);
  return (
    <section className={'lp-fit lp-dw' + (page ? ' page' : '') + (done ? ` ${done}` : '')} aria-label="The daily week: a planning puzzle">
      {!page && <p className="lp-dw-kicker">Spare a minute? Today’s planning puzzle.</p>}
      <header className="lp-dw-head">
        <div className="lp-dw-name">
          <b>{practice ? 'Practice week' : `Daily week #${daily.number}`}</b>
          <span className={'lp-dw-level l' + week.level}>{LEVELS[week.level]}</span>
          {!page && !practice && (
            <a className="lp-dw-own" href="/daily">
              Open on its own page
            </a>
          )}
        </div>
        <div className="lp-dw-stats" aria-live="polite">
          <span>{clock(time)}</span>
          <span>
            {moves} {moves === 1 ? 'move' : 'moves'}
          </span>
        </div>
      </header>
      {!started && !done && <p className="lp-dw-how">Plan the week: every block on the board, every rule kept. Letters on a block say who can do it.</p>}

      <div className="lp-dw-main">
        <div className="lp-fit-wrap">
          <div className="lp-fit-names" aria-hidden style={{ ['--rows' as string]: week.rows }}>
            {PEOPLE.slice(0, week.rows).map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          <div>
            <div className="lp-fit-days" aria-hidden>
              {DAYS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="lp-fit-board" ref={board} style={{ ['--rows' as string]: week.rows }}>
              {Array.from({ length: week.rows * 5 }, (_, k) => {
                const row = Math.floor(k / 5);
                const col = k % 5;
                const isOff = week.off.has(`${row}:${col}`);
                const lit = target && target.row === row && col >= target.col && col < target.col + draggedLen;
                return (
                  <button
                    key={k}
                    type="button"
                    tabIndex={picked === null || isOff ? -1 : 0}
                    className={'lp-fit-cell' + (isOff ? ' off' : '') + (lit ? ' lit' : '') + (picked !== null && !isOff ? ' open' : '')}
                    style={{ gridRow: row + 1, gridColumn: col + 1 }}
                    aria-label={isOff ? `${PEOPLE[row]} is off on ${DAYS[col]}` : `${PEOPLE[row]}, ${DAYS[col]}`}
                    onClick={() => tapCell(row, col)}
                  >
                    {isOff && <span>Off</span>}
                  </button>
                );
              })}
              {week.pieces.map((_, i) => i).filter((i) => places[i]).map(pieceEl)}
            </div>
          </div>
        </div>

        <ol className="lp-dw-rules" aria-label="Rules">
          {listed.map(({ r, k }) => (
            <li
              key={k}
              className={(states[k] === true ? 'ok' : states[k] === false ? 'bad' : '') + (ruleBlocks(r).some((i) => hot.includes(i)) ? ' hot' : '')}
              onPointerEnter={() => setHot(ruleBlocks(r))}
              onPointerLeave={() => setHot([])}
            >
              <RuleIcon kind={r.kind} />
              <span>{ruleText(r, week.pieces)}</span>
              <StateIcon state={states[k]!} />
            </li>
          ))}
        </ol>
      </div>

      {done ? (
        <div className="lp-dw-done" role="status">
          {solved ? (
            <>
              <b>Week planned.</b>
              <span>
                {clock(time)} · {moves} moves
                {!practice && streak > 1 ? ` · 🔥 ${streak} days in a row` : ''}
              </span>
            </>
          ) : (
            <>
              <b>Here’s how it fits.</b>
              <span>Every rule holds, and it’s the only way it does.</span>
            </>
          )}
          <div className="lp-dw-actions">
            {solved && !practice && (
              <button className="lp-btn primary" onClick={share}>
                Share
              </button>
            )}
            <button className="lp-btn ghost" onClick={() => restart(practiceWeek(week.level))}>
              {practice ? 'Another practice week' : 'Practice week'}
            </button>
          </div>
          {shared && <small>{shared}</small>}
          {!practice && <small>A new week in {untilMidnight()}</small>}
        </div>
      ) : (
        <>
          <div className="lp-fit-tray" aria-label="Blocks to plan">
            {week.pieces.map((_, i) => i).filter((i) => !places[i]).map(pieceEl)}
          </div>
          <div className="lp-dw-foot">
            <span className="lp-dw-progress">
              {placed} of {week.pieces.length} placed
            </span>
            {placed > 0 && (
              <button className="lp-dw-link" onClick={() => setPlaces(week.pieces.map(() => null))}>
                Start over
              </button>
            )}
            <button className="lp-dw-link" onClick={showAnswer}>
              Show the answer
            </button>
            {practice && (
              <button className="lp-dw-link" onClick={() => restart(daily)}>
                Back to today’s
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The home page's footer. */
export const Playground = () => <DailyWeek />;
