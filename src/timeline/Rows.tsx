import { memo, useLayoutEffect, useRef, useState } from 'react';
import { labelPinner } from './pin.ts';
import { BLOCK_H, CHUNK, LANE_H, ROW_PAD, visibleTasks, type RowLayout, type TaskView } from './model.ts';
import { renameUser } from '../data/store.ts';
import { formatRange, workdays } from '../lib/dates.ts';

interface BlockProps {
  task: TaskView;
  origin: number;
  colW: number;
  selected: boolean;
  dragging: boolean;
}

export const TaskBlock = memo(function TaskBlock({ task, origin, colW, selected, dragging }: BlockProps) {
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
  const cls = 'task' + (selected ? ' selected' : '') + (dragging ? ' dragging' : '') + (task.title ? '' : ' untitled');
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
        </div>
      </div>
      {width >= 18 && <div className="handle end" data-handle="end" />}
    </div>
  );
});

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
}

export const RowView = memo(function RowView({ row, top, origin, colW, d0, d1, selectedId, dragId }: RowProps) {
  const tiles = [];
  for (let c = d0; c <= d1; c += CHUNK) {
    tiles.push(
      <RowTile key={c} row={row} c0={c} first={c === d0} origin={origin} colW={colW} selectedId={selectedId} dragId={dragId} />,
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
}

/** The blocks of one row that start inside one CHUNK of days. */
const RowTile = memo(function RowTile({ row, c0, first, origin, colW, selectedId, dragId }: TileProps) {
  const c1 = c0 + CHUNK - 1;
  const tasks = visibleTasks(row, c0, c1).filter((t) => t.start >= c0 || first);
  return (
    <>
      {tasks.map((t) => (
        <TaskBlock key={t.id} task={t} origin={origin} colW={colW} selected={t.id === selectedId} dragging={t.id === dragId} />
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
}

export const Sidebar = memo(function Sidebar({ rows, tops, r0, r1 }: SidebarProps) {
  const out = [];
  for (let i = r0; i <= r1 && i < rows.length; i++) {
    const r = rows[i]!;
    out.push(<SidebarRow key={r.userId} row={r} top={tops[i]!} />);
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

const SidebarRow = memo(function SidebarRow({ row, top }: { row: RowLayout; top: number }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="person" style={{ transform: `translateY(${top}px)`, height: row.height }}>
      <div className="avatar" style={{ background: row.color }}>
        {initials(row.name)}
      </div>
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
        <div className="person-name" onDoubleClick={() => setEditing(true)} title={row.name}>
          <span className="person-full">{row.name}</span>
          <span className="person-first">{row.name.split(/\s+/)[0]}</span>
          <div className="person-sub">{row.tasks.length} tasks</div>
        </div>
      )}
    </div>
  );
});
