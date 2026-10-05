import { useEffect, useRef, useState } from 'react';
import { Attachments, attachFiles } from './Attachments.tsx';
import { PALETTE, deleteTask, getTask, updateTask } from '../data/store.ts';
import { RULES, RULE_LABELS } from '../lib/recur.ts';
import { dayFromYMD, formatDay, formatRange, workdays, ymd } from '../lib/dates.ts';
import type { TaskView, TimelineModel } from './model.ts';
import { ProjectField, TagField } from './Projects.tsx';
import { Discussion } from './Discussion.tsx';
import { Calendar, Check, Repeat, Trash } from '../ui/icons.tsx';

interface Props {
  task: TaskView;
  model: TimelineModel;
  x: number;
  y: number;
  /** Render as a bottom sheet (phones). */
  sheet?: boolean;
  /** View-only link: show, don't edit. */
  readOnly?: boolean;
  onClose(): void;
}

export function Editor({ task, model, x, y, sheet, readOnly, onClose }: Props) {
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
    // On phones only jump into the keyboard for a new (untitled) task.
    if (!readOnly && (!sheet || !task.title)) {
      titleRef.current?.focus({ preventScroll: true });
      titleRef.current?.select();
    }
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Defer so the click that opened us doesn't close us.
    const t = setTimeout(() => window.addEventListener('pointerdown', away, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
    };
  }, [task.id, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

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
      className={'editor' + (sheet ? ' sheet' : '') + (dropping ? ' dropping' : '') + (readOnly ? ' readonly' : '')}
      data-no-drag
      style={sheet ? undefined : { transform: `translate(${x}px, ${y}px)` }}
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
          <span className="editor-days">
            {workdays(task.start, task.end)} workday{workdays(task.start, task.end) === 1 ? '' : 's'}
          </span>
        </div>
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
        <textarea
          className="editor-notes"
          placeholder="Notes"
          defaultValue={task.notes}
          rows={2}
          onFocus={(e) => (lastField.current = e.currentTarget)}
          onBlur={(e) => e.currentTarget.value !== task.notes && updateTask(task.id, { notes: e.currentTarget.value }, 'Edit notes')}
        />
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

const isoOf = (day: number) => {
  const { y, m, d } = ymd(day);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Repeat rule + optional end date; edits always apply to the whole series. */
function RepeatField({ task }: { task: TaskView }) {
  const series = getTask(task.series);
  const until = series?.repeatUntil ?? 0;
  const set = (patch: { repeat?: string; repeatUntil?: number }, label: string) => updateTask(task.series, patch, label);
  return (
    <div className={'repeat-field' + (task.repeat ? ' on' : '')}>
      <Repeat size={14} />
      <select
        aria-label="Repeat"
        value={task.repeat}
        onChange={(e) => set({ repeat: e.currentTarget.value, ...(e.currentTarget.value ? {} : { repeatUntil: 0 }) }, e.currentTarget.value ? 'Repeat task' : 'Stop repeating')}
      >
        <option value="">Doesn’t repeat</option>
        {RULES.map((r) => (
          <option key={r} value={r}>
            {RULE_LABELS[r]}
          </option>
        ))}
      </select>
      {task.repeat && (
        <label className="repeat-until" title={until ? `Last one starts on or before ${formatDay(until)}` : 'Repeats for the next two years'}>
          <span>until</span>
          <input
            type="date"
            value={until ? isoOf(until) : ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              const [y, m, d] = v.split('-').map(Number);
              set({ repeatUntil: v ? dayFromYMD(y!, m! - 1, d!) : 0 }, 'Set repeat end');
            }}
          />
        </label>
      )}
    </div>
  );
}
