// Fields in the task details panel: dates, time of day, and the block's look
// (color + pattern).

import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { PALETTE, PATTERNS, updateTask } from '../data/store.ts';
import { workdays } from '../lib/dates.ts';
import { DAY_END, TIME_STEP, defaultTime, formatClock, formatDuration, joinTime, moveStart, parseTime } from '../lib/times.ts';
import { DayButton, Select, type Option } from '../ui/Select.tsx';
import { Check, ChevronDown, Close, Plus } from '../ui/icons.tsx';
import { PatternChip, PatternPicker } from './PatternPicker.tsx';
import type { TaskView } from './model.ts';

/** Moving an occurrence of a series detaches it under a new id. */
type Retarget = (id: string) => void;

export function DateField({ task, onRetarget }: { task: TaskView; onRetarget: Retarget }) {
  const days = workdays(task.start, task.end);
  const place = (start: number, end: number, label: string) => {
    if (start === task.start && end === task.end) return;
    const id = updateTask(task.id, { start, end }, label);
    if (id !== task.id) onRetarget(id);
  };
  return (
    <div className="prop-dates">
      {/* A new start moves the task; a new end resizes it. */}
      <DayButton label="Start date" value={task.start} onChange={(d) => place(d, task.end + (d - task.start), 'Move task')} />
      <span className="prop-sep">→</span>
      <DayButton label="End date" value={task.end} min={task.start} onChange={(d) => place(task.start, Math.max(d, task.start), 'Resize task')} />
      <span className="prop-badge" title="Workdays">
        {days}d
      </span>
    </div>
  );
}

const clockOptions = (from: number, to: number, extra: number, label: (m: number) => string): Option<string>[] => {
  const mins: number[] = [];
  for (let m = from; m <= to; m += TIME_STEP) mins.push(m);
  // An imported time off the 15-minute grid still shows as picked.
  if (extra >= from && extra <= to && !mins.includes(extra)) mins.push(extra), mins.sort((a, b) => a - b);
  return mins.map((m) => ({ value: String(m), label: label(m) }));
};

export function TimeField({ task }: { task: TaskView }) {
  const parsed = parseTime(task.time);
  const set = (v: string, label: string) => updateTask(task.id, { time: v }, label);
  if (!parsed) {
    return (
      <button
        type="button"
        className="prop-value prop-add"
        onClick={() => {
          const d = defaultTime(task.start);
          set(joinTime(d.start, d.end), 'Set time');
        }}
      >
        <span>{task.time || 'All day'}</span>
        <span className="prop-hint">
          <Plus /> Add time
        </span>
      </button>
    );
  }
  const t = { start: parsed.start, end: parsed.end ?? Math.min(parsed.start + 60, DAY_END) };
  return (
    <div className="prop-times">
      <Select
        label="Start time"
        className="time-select"
        value={String(t.start)}
        options={clockOptions(0, DAY_END - TIME_STEP, t.start, formatClock)}
        onChange={(v) => {
          const n = moveStart(t, +v);
          set(joinTime(n.start, n.end), 'Change time');
        }}
      />
      <span className="prop-sep">–</span>
      <Select
        label="End time"
        className="time-select end"
        value={String(t.end)}
        options={clockOptions(t.start + TIME_STEP, DAY_END, t.end, (m) => `${formatClock(m)}  ·  ${formatDuration(m - t.start)}`)}
        onChange={(v) => set(joinTime(t.start, +v), 'Change time')}
      />
      <button type="button" className="prop-clear" aria-label="Remove time" title="All day" onClick={() => set('', 'Remove time')}>
        <Close size={13} />
      </button>
    </div>
  );
}

const COLOR_NAMES: Record<string, string> = {
  '#3b7bff': 'Blue',
  '#20b55c': 'Green',
  '#f04438': 'Red',
  '#f5b301': 'Amber',
  '#9b5cff': 'Violet',
  '#0fc2d8': 'Cyan',
  '#f72585': 'Pink',
  '#6b7c93': 'Slate',
  '#8ccf12': 'Lime',
  '#ff7b1c': 'Orange',
};
const titleCase = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The block's color and pattern: a preview that opens both pickers. */
export function LookField({ task, readOnly }: { task: TaskView; readOnly?: boolean }) {
  const name = COLOR_NAMES[task.color.toLowerCase()] ?? 'Custom';
  const label = (PATTERNS as readonly string[]).includes(task.pattern) ? `${name} · ${titleCase(task.pattern)}` : name;
  return (
    <DialogTrigger>
      <Button className="prop-value look-btn" isDisabled={readOnly} aria-label={`Color and pattern: ${label}`}>
        <PatternChip color={task.color} pattern={task.pattern} big />
        <span>{label}</span>
        <ChevronDown size={14} />
      </Button>
      <Popover className="ui-pop look-pop" offset={6} placement="bottom start">
        <Dialog className="look-dialog" aria-label="Color and pattern">
          <div className="look-label">Color</div>
          <div className="look-colors">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={'swatch' + (c === task.color ? ' on' : '')}
                style={{ background: c }}
                aria-pressed={c === task.color}
                aria-label={COLOR_NAMES[c] ?? c}
                title={COLOR_NAMES[c]}
                onClick={() => updateTask(task.id, { color: c }, 'Recolor task')}
              >
                {c === task.color && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="look-label">Pattern</div>
          <PatternPicker value={task.pattern} color={task.color} onPick={(p) => updateTask(task.id, { pattern: p }, p ? 'Set pattern' : 'Remove pattern')} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
