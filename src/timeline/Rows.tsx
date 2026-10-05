import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { labelPinner } from './pin.ts';
import { Notes, Paperclip } from '../ui/icons.tsx';
import { BLOCK_H, CHUNK, LANE_H, ROW_PAD, visibleTasks, type RowLayout, type TaskView } from './model.ts';
import { renameUser } from '../data/store.ts';
import { formatRange, isWeekend, workdays } from '../lib/dates.ts';

interface BlockProps {
  task: TaskView;
  origin: number;
  colW: number;
  selected: boolean;
  dragging: boolean;
  dimmed: boolean;
}

export const TaskBlock = memo(function TaskBlock({ task, origin, colW, selected, dragging, dimmed }: BlockProps) {
  const span = task.end - task.start + 1;
  const width = span * colW - 3;
  const left = (task.start - origin) * colW + 1;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    labelPinner.register(el, left, width);
    return () => labelPinner.unregister(el);
  }, [left, width]);
  const days = workdays(task.start, task.end);
  const cls = 'task' + (selected ? ' selected' : '') + (dragging ? ' dragging' : '') + (task.title ? '' : ' untitled') + (dimmed ? ' dimmed' : '');
  return (
    <div
      ref={ref}
      className={cls}
      data-task={task.id}
      title={`${task.title || 'Untitled'} · ${formatRange(task.start, task.end)}`}
      style={{
        transform: `translate(${left}px, ${ROW_PAD + task.lane * LANE_H}px)`,
        width,
        height: BLOCK_H,
        ['--c' as string]: task.color,
      }}
    >
      {width >= 18 && <div className="handle start" data-handle="start" />}
      <div className="task-clip">
        <div className="task-label">
          <span className="task-title">{task.title || 'Untitled'}</span>
          {width > 120 && <span className="task-meta">{days}d</span>}
          {width > 90 && (task.files > 0 || task.notes) && (
            <span className="task-badges">
              {task.notes && <Notes size={12} />}
              {task.files > 0 && (
                <>
                  <Paperclip size={12} />
                  {task.files > 1 && task.files}
                </>
              )}
            </span>
          )}
        </div>
      </div>
      {width >= 18 && <div className="handle end" data-handle="end" />}
    </div>
  );
});

export const matches = (t: TaskView, q: string) =>
  t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q);

interface RowProps {
  row: RowLayout;
  top: number;
  origin: number;
  colW: number;
  /** Window, aligned to CHUNK boundaries relative to origin. */
  d0: number;
  d1: number;
  selectedId: string | null;
  dragId: string | null;
  /** Lower-cased search; blocks that don't match are faded. */
  query: string;
}

export const RowView = memo(function RowView({ row, top, origin, colW, d0, d1, selectedId, dragId, query }: RowProps) {
  const tiles = [];
  for (let c = d0; c <= d1; c += CHUNK) {
    tiles.push(
      <RowTile key={c} row={row} c0={c} first={c === d0} origin={origin} colW={colW} selectedId={selectedId} dragId={dragId} query={query} />,
    );
  }
  return (
    <div className="row" style={{ transform: `translateY(${top}px)`, height: row.height }}>
      {tiles}
    </div>
  );
});

interface TileProps {
  row: RowLayout;
  c0: number;
  /** The first tile also renders blocks that started before the window. */
  first: boolean;
  origin: number;
  colW: number;
  selectedId: string | null;
  dragId: string | null;
  query: string;
}

/** The blocks of one row that start inside one CHUNK of days. */
const RowTile = memo(function RowTile({ row, c0, first, origin, colW, selectedId, dragId, query }: TileProps) {
  const c1 = c0 + CHUNK - 1;
  const tasks = visibleTasks(row, c0, c1).filter((t) => t.start >= c0 || first);
  return (
    <>
      {tasks.map((t) => (
        <TaskBlock key={t.id} task={t} origin={origin} colW={colW} selected={t.id === selectedId}
          dragging={t.id === dragId}
          dimmed={query !== '' && !matches(t, query)}
        />
      ))}
    </>
  );
});

interface GridProps {
  d0: number;
  d1: number;
  origin: number;
  colW: number;
  height: number;
  today: number;
}

/** Day/weekend grid as CSS gradients over the rendered window only. */
export const GridBackground = memo(function GridBackground({ d0, d1, origin, colW, height, today }: GridProps) {
  // d0 is always a Monday, so the weekend stripe sits at columns 5–6.
  const week = 7 * colW;
  const dayLines = colW >= 12;
  return (
    <>
      <div
        className="gridbg"
        style={{
          transform: `translateX(${(d0 - origin) * colW}px)`,
          width: (d1 - d0 + 1) * colW,
          height,
          backgroundImage: [
            `linear-gradient(to right, var(--grid-week) 1px, transparent 1px)`,
            dayLines ? `linear-gradient(to right, var(--grid-day) 1px, transparent 1px)` : 'none',
            `linear-gradient(to right, transparent ${5 * colW}px, var(--weekend) ${5 * colW}px)`,
          ].join(','),
          backgroundSize: `${week}px 100%, ${colW}px 100%, ${week}px 100%`,
        }}
      />
      {today >= d0 && today <= d1 && (
        <div className="today-col" style={{ transform: `translateX(${(today - origin) * colW}px)`, width: colW, height }} />
      )}
    </>
  );
});

interface SidebarProps {
  rows: RowLayout[];
  tops: number[];
  r0: number;
  r1: number;
  focused: boolean;
  today: number;
  onFocusPerson(id: string, additive: boolean): void;
}

export const Sidebar = memo(function Sidebar({ rows, tops, r0, r1, focused, today, onFocusPerson }: SidebarProps) {
  const out = [];
  for (let i = r0; i <= r1 && i < rows.length; i++) {
    const r = rows[i]!;
    out.push(<SidebarRow key={r.userId} row={r} top={tops[i]!} focused={focused} today={today} onFocusPerson={onFocusPerson} />);
  }
  return <>{out}</>;
});

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

const LOAD_DAYS = 28;

/**
 * Share of workdays in the next four weeks that have at least one task,
 * plus how much of it is parallel work (2+ tasks on the same day).
 */
const upcomingLoad = (row: RowLayout, today: number) => {
  const end = today + LOAD_DAYS - 1;
  let booked = 0;
  let parallel = 0;
  let total = 0;
  for (let d = today; d <= end; d++) if (!isWeekend(d)) total++;
  for (const c of row.clusters) {
    if (c.end < today) continue;
    if (c.start > end) break;
    for (let d = Math.max(c.start, today); d <= Math.min(c.end, end); d++) {
      if (isWeekend(d)) continue;
      booked++;
      if (c.lanes > 1) parallel++;
    }
  }
  return { pct: total ? booked / total : 0, parallel: total ? parallel / total : 0 };
};

interface RowProps2 {
  row: RowLayout;
  top: number;
  focused: boolean;
  today: number;
  onFocusPerson(id: string, additive: boolean): void;
}

const SidebarRow = memo(function SidebarRow({ row, top, focused, today, onFocusPerson }: RowProps2) {
  const [editing, setEditing] = useState(false);
  const load = useMemo(() => upcomingLoad(row, today), [row.clusters, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = row.name.split(/\s+/)[0];
  return (
    <div className={'person' + (focused ? ' in-focus' : '')} style={{ transform: `translateY(${top}px)`, height: row.height }}>
      <button
        className="avatar"
        style={{ ['--c' as string]: row.color }}
        title={focused ? 'Show everyone' : `Focus on ${first} (⌘/Shift-click to add)`}
        aria-label={focused ? 'Show everyone' : `Focus on ${row.name}`}
        aria-pressed={focused}
        onClick={(e) => onFocusPerson(row.userId, e.metaKey || e.ctrlKey || e.shiftKey)}
      >
        {initials(row.name)}
      </button>
      {editing ? (
        <input
          className="person-input"
          autoFocus
          defaultValue={row.name}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== row.name) renameUser(row.userId, v);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <div className="person-name" onDoubleClick={() => setEditing(true)} title={`${row.name} (double-click to rename)`}>
          <span className="person-full">{row.name}</span>
          <span className="person-first">{first}</span>
          <div className="person-sub" title="Booked workdays in the next 4 weeks">
            <span className="load">
              <span className="load-fill" style={{ width: `${Math.round(load.pct * 100)}%` }} />
              <span className="load-over" style={{ width: `${Math.round(load.parallel * 100)}%` }} />
            </span>
            {Math.round(load.pct * 100)}% booked
          </div>
        </div>
      )}
    </div>
  );
});
