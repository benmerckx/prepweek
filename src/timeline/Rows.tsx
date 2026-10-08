import { formatDuration, formatTime } from '../lib/times.ts';
import { memo, useLayoutEffect, useRef } from 'react';
import { labelPinner } from './pin.ts';
import { Away, Check, Comment, ListCheck, Notes, Paperclip, Repeat, People as PeopleIcon } from '../ui/icons.tsx';
import { CHUNK, visibleTasks, type Dims, type RowLayout, type TaskView } from './model.ts';
import type { Scale } from './scale.ts';
import { formatRange, workdays } from '../lib/dates.ts';

interface BlockProps {
  task: TaskView;
  scale: Scale;
  dims: Dims;
  selected: boolean;
  dragging: boolean;
  dimmed: boolean;
}

export const TaskBlock = memo(function TaskBlock({ task, scale, dims, selected, dragging, dimmed }: BlockProps) {
  // A weekend-only task with weekends hidden still gets a sliver to grab.
  const width = Math.max(6, scale.w(task.start, task.end) - 3);
  const left = scale.x(task.start) + 1;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    labelPinner.register(el, left, width);
    return () => labelPinner.unregister(el);
  }, [left, width]);
  // Workdays, or calendar days for a weekend-only task (never "0d").
  const days = workdays(task.start, task.end) || task.end - task.start + 1;
  /** Tall blocks: title on top, details on a second line. */
  const tall = dims.blockH >= 36;
  const cls = 'task' + (task.off ? ' off' : '') + (task.done ? ' done' : '') + (selected ? ' selected' : '') + (dragging ? ' dragging' : '') + (task.title ? '' : ' untitled') + (dimmed ? ' dimmed' : '');
  return (
    <div
      ref={ref}
      className={cls}
      data-task={task.id}
      data-pattern={(!task.off && task.pattern) || undefined}
      title={[task.title || (task.off ? 'Time off' : 'Untitled'), task.project, formatRange(task.start, task.end), task.estimate ? `${formatDuration(task.estimate)} estimated` : '', task.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ')}
      style={{
        transform: `translate(${left}px, ${dims.pad + task.lane * dims.laneH}px)`,
        width,
        height: dims.blockH,
        ['--c' as string]: task.color,
      }}
    >
      {width >= 18 && <div className="handle start" data-handle="start" />}
      <div className="task-clip">
        <div className={'task-label' + (tall ? ' tall' : '')}>
          <span className="task-title">
            {task.off ? <Away size={12} /> : task.done && <Check size={12} />}
            {task.title || (task.off ? 'Time off' : 'Untitled')}
          </span>
          {(tall ? width > 30 : width > 100) && (
            <span className="task-sub">
              <span className="task-meta">
                {/* Narrow blocks still say how long (or when); wider ones
                    add the project, then its client. */}
                {[
                  task.time && formatTime(task.time),
                  task.project && task.project !== task.title && width > (tall ? 100 : 180) ? task.project : '',
                  task.client && task.project && width > (tall ? 190 : 280) ? task.client : '',
                  // "3d", "6h" for a day's estimate, "3d · 20h" for a longer one.
                  task.time && days === 1 ? '' : task.estimate && days === 1 ? '' : `${days}d`,
                  task.estimate ? formatDuration(task.estimate) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {width > 64 && (task.files > 0 || task.notes || task.repeat || task.comments > 0 || task.people > 1 || task.checks > 0) && (
                <span className="task-badges">
                  {task.checks > 0 && (
                    <span title={`Checklist: ${task.checked} of ${task.checks} done`}>
                      <ListCheck size={12} />
                      {task.checked}/{task.checks}
                    </span>
                  )}
                  {task.people > 1 && (
                    <span title={`Shared by ${task.people} people`}>
                      <PeopleIcon size={12} />
                      {task.people}
                    </span>
                  )}
                  {task.repeat && <Repeat size={12} />}
                  {task.comments > 0 && (
                    <>
                      <Comment size={12} />
                      {task.comments > 1 && task.comments}
                    </>
                  )}
                  {task.notes && <Notes size={12} />}
                  {task.files > 0 && (
                    <>
                      <Paperclip size={12} />
                      {task.files > 1 && task.files}
                    </>
                  )}
                </span>
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
  t.title.toLowerCase().includes(q) ||
  t.notes.toLowerCase().includes(q) ||
  t.project.toLowerCase().includes(q) ||
  t.tags.some((g) => g.toLowerCase().includes(q));

/** Search + filter as one predicate; null when nothing is filtered. */
export type TaskFilter = ((t: TaskView) => boolean) | null;

interface RowProps {
  row: RowLayout;
  top: number;
  scale: Scale;
  dims: Dims;
  /** Window, aligned to CHUNK boundaries relative to origin. */
  d0: number;
  d1: number;
  selectedId: string | null;
  dragId: string | null;
  /** Blocks that don't pass are faded. */
  filter: TaskFilter;
}

export const RowView = memo(function RowView({ row, top, scale, dims, d0, d1, selectedId, dragId, filter }: RowProps) {
  if (row.kind === 'team') return <div className="row team-band" style={{ transform: `translateY(${top}px)`, height: row.height }} />;
  const tiles = [];
  for (let c = d0; c <= d1; c += CHUNK) {
    tiles.push(
      <RowTile key={c} row={row} c0={c} first={c === d0} scale={scale} dims={dims} selectedId={selectedId} dragId={dragId} filter={filter} />,
    );
  }
  return (
    <div className={'row' + (row.pinned ? ' pinned' : '')} style={{ transform: `translateY(${top}px)`, height: row.height }}>
      {tiles}
    </div>
  );
});

interface TileProps {
  row: RowLayout;
  c0: number;
  /** The first tile also renders blocks that started before the window. */
  first: boolean;
  scale: Scale;
  dims: Dims;
  selectedId: string | null;
  dragId: string | null;
  filter: TaskFilter;
}

/** The blocks of one row that start inside one CHUNK of days. */
const RowTile = memo(function RowTile({ row, c0, first, scale, dims, selectedId, dragId, filter }: TileProps) {
  const c1 = c0 + CHUNK - 1;
  const tasks = visibleTasks(row, c0, c1).filter((t) => t.start >= c0 || first);
  return (
    <>
      {tasks.map((t) => (
        <TaskBlock
          key={t.id}
          task={t}
          scale={scale}
          dims={dims}
          selected={t.id === selectedId}
          dragging={t.id === dragId}
          dimmed={filter !== null && !filter(t)}
        />
      ))}
    </>
  );
});

interface GridProps {
  d0: number;
  d1: number;
  scale: Scale;
  height: number;
  today: number;
}

/** Day/weekend grid as CSS gradients over the rendered window only. */
export const GridBackground = memo(function GridBackground({ d0, d1, scale, height, today }: GridProps) {
  // d0 is always a Monday, so the weekend stripe sits at columns 5–6, and
  // with weekends hidden a week is simply five columns.
  const colW = scale.colW;
  const week = scale.perWeek * colW;
  const dayLines = colW >= 12;
  return (
    <>
      <div
        className="gridbg"
        style={{
          transform: `translateX(${scale.x(d0)}px)`,
          width: scale.w(d0, d1),
          height,
          backgroundImage: [
            `linear-gradient(to right, var(--grid-week) 1px, transparent 1px)`,
            dayLines ? `linear-gradient(to right, var(--grid-day) 1px, transparent 1px)` : 'none',
            scale.hideWeekends ? 'none' : `linear-gradient(to right, transparent ${5 * colW}px, var(--weekend) ${5 * colW}px)`,
          ].join(','),
          backgroundSize: `${week}px 100%, ${colW}px 100%, ${week}px 100%`,
        }}
      />
      {today >= d0 && today <= d1 && !scale.isHidden(today) && (
        <div className="today-col" style={{ transform: `translateX(${scale.x(today)}px)`, width: colW, height }} />
      )}
    </>
  );
});
