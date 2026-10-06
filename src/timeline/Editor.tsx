import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Attachments, attachFiles } from './Attachments.tsx';
import { PALETTE, deleteTask, getTask, updateTask } from '../data/store.ts';
import { RULES, RULE_LABELS, type Rule } from '../lib/recur.ts';
import { formatDay, formatRange, workdays } from '../lib/dates.ts';
import type { TaskView, TimelineModel } from './model.ts';
import { ProjectField, TagField } from './Projects.tsx';
import { Discussion } from './Discussion.tsx';

// Lexical loads on first use, not on page load.
import { PatternPicker } from './PatternPicker.tsx';

import { DatePicker, Select, isPopoverOpen, type Option } from '../ui/Select.tsx';

const RichNotes = lazy(() => import('./RichNotes.tsx'));
import { Calendar, Check, Repeat, Trash } from '../ui/icons.tsx';

interface Props {
  task: TaskView;
  model: TimelineModel;
  /** Render as a bottom sheet (phones). */
  sheet?: boolean;
  /** Render as a panel on the right (desktop). */
  side?: boolean;
  /** View-only link: show, don't edit. */
  readOnly?: boolean;
  onClose(): void;
}

export function Editor({ task, model, sheet, side, readOnly, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  /** The text field that last had focus, so picking a color can keep it. */
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [error, setError] = useState('');
  const [dropping, setDropping] = useState(false);
  const attach = async (files: File[]) => {
    if (!files.length) return;
    setError((await attachFiles(task.id, files)) ?? '');
  };

  useEffect(() => {
    // Only a new (untitled) task starts in its title; opening an existing
    // one shouldn't grab focus or select text.
    if (!readOnly && !task.title) {
      titleRef.current?.focus({ preventScroll: true });
      titleRef.current?.select();
    }
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // Inside the panel, or picking from (or dismissing) one of its dropdowns.
      if (ref.current?.contains(t) || isPopoverOpen()) return;
      // Side panel: clicks on the timeline are handled there (open another
      // block, or close on empty space) so the panel doesn't flicker.
      if (side && t.closest?.('.body')) return;
      onClose();
    };
    // Defer so the click that opened us doesn't close us.
    const t = setTimeout(() => window.addEventListener('pointerdown', away, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
    };
  }, [task.id, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Side panel: keep the block being edited visible left of the panel.
  useEffect(() => {
    if (!side) return;
    const t = setTimeout(() => {
      const block = document.querySelector(`[data-task="${CSS.escape(task.id)}"]`);
      const scroller = document.querySelector<HTMLElement>('.scroller');
      if (!block || !scroller || !ref.current) return;
      const b = block.getBoundingClientRect();
      const panel = ref.current.getBoundingClientRect().left;
      const start = scroller.getBoundingClientRect().left + 240;
      if (b.left > panel - 80) scroller.scrollBy({ left: Math.min(b.left - start, b.right - panel + 48), behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(t);
  }, [side, task.id]);

  // Bottom sheet: keep the block being edited visible above the sheet.
  useEffect(() => {
    if (!sheet) return;
    const t = setTimeout(() => {
      const block = document.querySelector(`[data-task="${CSS.escape(task.id)}"]`);
      const scroller = document.querySelector<HTMLElement>('.scroller');
      if (!block || !scroller || !ref.current) return;
      const b = block.getBoundingClientRect();
      const top = ref.current.getBoundingClientRect().top;
      const header = scroller.getBoundingClientRect().top + 80;
      if (b.bottom > top - 12) scroller.scrollBy({ top: b.bottom - top + 24, behavior: 'smooth' });
      else if (b.top < header) scroller.scrollBy({ top: b.top - header - 12, behavior: 'smooth' });
    }, 220); // after the sheet's slide-in
    return () => clearTimeout(t);
  }, [sheet, task.id]);

  // Keyboard handling for the bottom sheet. Android (with the viewport's
  // interactive-widget=resizes-content) shrinks the layout instead of
  // panning the page, so the sheet simply sits above the keyboard. iOS
  // ignores that setting and pans the whole page to reveal the input; undo
  // the pan and lift the sheet by the keyboard height instead, so the
  // timeline behind it stays exactly where it was.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!sheet || !vv) return;
    const update = () => {
      if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      ref.current?.style.setProperty('--kb', `${Math.round(kb)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [sheet]);

  const saveTitle = () => {
    const v = titleRef.current?.value.trim() ?? '';
    if (v !== task.title) updateTask(task.id, { title: v }, 'Rename task');
  };

  return (
    <div
      ref={ref}
      className={'editor' + (sheet ? ' sheet' : '') + (side ? ' side' : '') + (dropping ? ' dropping' : '') + (readOnly ? ' readonly' : '')}
      data-no-drag
      onPointerDown={(e) => e.stopPropagation()}
      // Drop or paste files to attach them (and keep the drop away from the
      // app-wide CSV import handler).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        void attach([...e.dataTransfer.files]);
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (!files.length) return;
        e.preventDefault();
        void attach(files);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <fieldset className="editor-fieldset" disabled={readOnly}>
        <input
          ref={titleRef}
          className="editor-title"
          placeholder="What's the plan?"
          defaultValue={task.title}
          onFocus={(e) => (lastField.current = e.currentTarget)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              saveTitle();
              onClose();
            }
          }}
        />
        <div className="editor-meta">
          <Calendar />
          <span>{formatRange(task.start, task.end)}</span>
          {task.time && <span className="editor-time">{task.time}</span>}
          <span className="editor-days">
            {workdays(task.start, task.end)} workday{workdays(task.start, task.end) === 1 ? '' : 's'}
          </span>
        </div>
        <button
          className={'done-toggle' + (task.done ? ' on' : '')}
          aria-pressed={task.done}
          onClick={() => updateTask(task.series, { done: !task.done }, task.done ? 'Reopen task' : 'Complete task')}
        >
          <span className="done-box">{task.done && <Check size={12} />}</span>
          {task.done ? 'Done' : 'Mark as done'}
        </button>
        <div className="editor-fields">
          <ProjectField task={task} model={model} />
          <TagField task={task} model={model} />
          <RepeatField task={task} />
        </div>
        <div className="swatches">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={'swatch' + (c === task.color ? ' on' : '')}
              style={{ background: c }}
              aria-pressed={c === task.color}
              aria-label={`Color ${c}`}
              // Don't take focus: the text field keeps it, so on phones the
              // keyboard stays up while you pick a color.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                updateTask(task.id, { color: c }, 'Recolor task');
                const f = lastField.current;
                if (f && document.activeElement !== f) f.focus({ preventScroll: true });
              }}
            >
              {c === task.color && <Check size={13} />}
            </button>
          ))}
        </div>
        <PatternPicker value={task.pattern} color={task.color} onPick={(p) => updateTask(task.id, { pattern: p }, p ? 'Set pattern' : 'Remove pattern')} />
        <Suspense fallback={<div className="rich-notes loading">{task.notes || 'Notes'}</div>}>
          <RichNotes
            key={task.series}
            value={task.notes}
            readOnly={readOnly}
            onSave={(md) => updateTask(task.series, { notes: md }, 'Edit notes')}
          />
        </Suspense>
      </fieldset>
      <Attachments taskId={task.series} onError={setError} />
      {error && <p className="editor-error">{error}</p>}
      <Discussion taskId={task.series} collapsed={sheet && !task.comments} />
      <div className="editor-actions">
        {!readOnly && (
          <button
            className="btn danger"
            title={task.repeat ? 'Delete only this occurrence' : 'Delete task'}
            onClick={() => {
              deleteTask(task.id);
              onClose();
            }}
          >
            <Trash />
            {task.repeat ? 'Delete this' : 'Delete'}
          </button>
        )}
        {task.repeat && !readOnly && (
          <button
            className="btn danger ghost"
            title="Delete every occurrence"
            onClick={() => {
              deleteTask(task.id, 'series');
              onClose();
            }}
          >
            Delete all
          </button>
        )}
        <button
          className="btn primary"
          onClick={() => {
            saveTitle();
            onClose();
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

/** Repeat rule + optional end date; edits always apply to the whole series. */
const REPEAT_OPTIONS: Option<Rule | ''>[] = [{ value: '', label: 'Doesn’t repeat' }, ...RULES.map((r) => ({ value: r, label: RULE_LABELS[r] }))];

function RepeatField({ task }: { task: TaskView }) {
  const series = getTask(task.series);
  const until = series?.repeatUntil ?? 0;
  const set = (patch: { repeat?: string; repeatUntil?: number }, label: string) => updateTask(task.series, patch, label);
  return (
    <div className={'repeat-field' + (task.repeat ? ' on' : '')}>
      <Repeat size={14} />
      <Select
        label="Repeat"
        className="repeat-select"
        value={task.repeat as Rule | ''}
        options={REPEAT_OPTIONS}
        onChange={(v) => set({ repeat: v, ...(v ? {} : { repeatUntil: 0 }) }, v ? 'Repeat task' : 'Stop repeating')}
      />
      {task.repeat && (
        <label className="repeat-until" title={until ? `Last one starts on or before ${formatDay(until)}` : 'Repeats for the next two years'}>
          <span>until</span>
          <DatePicker
            label="Repeat until"
            value={until || null}
            clearable
            placeholder="No end"
            onChange={(d) => set({ repeatUntil: d ?? 0 }, d ? 'Set repeat end' : 'Remove repeat end')}
          />
        </label>
      )}
    </div>
  );
}
