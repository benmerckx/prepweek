import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Attachments, attachFiles } from './Attachments.tsx';
import { deleteTask, getTask, isReadOnly, linksOf, updateTask } from '../data/store.ts';
import { restoreArchived } from '../data/archive.ts';
import { RULES, RULE_LABELS, type Rule } from '../lib/recur.ts';
import { formatDay } from '../lib/dates.ts';
import type { TaskView, TimelineModel } from './model.ts';
import { ProjectField, TagField } from './Projects.tsx';
import { Discussion } from './Discussion.tsx';

import { DateField, EstimateField, LookField, PeopleField, TimeField } from './TaskFields.tsx';
import { Checklist, KindField, LinksField } from './Planning.tsx';
import { DatePicker, Select, isPopoverOpen, type Option } from '../ui/Select.tsx';
import { Away, Calendar, Check, Clock, Close, Folder, Hourglass, People as PeopleIcon, Plus, Repeat, Swatch, Tag, Trash, Waits } from '../ui/icons.tsx';
import { loadChunk } from '../lib/chunks.ts';

// Lexical loads on first use, not on page load.
const RichNotes = lazy(() => loadChunk(() => import('./RichNotes.tsx')));

/** Details a task often doesn't need: offered as "+ Time", "+ Tags"… */
type Extra = 'estimate' | 'time' | 'tags' | 'repeat' | 'waits' | 'checks' | 'off';
const EXTRAS: Extra[] = ['estimate', 'time', 'tags', 'repeat', 'checks', 'waits', 'off'];
const EXTRA_LABELS: Record<Extra, string> = {
  estimate: 'Estimate',
  time: 'Time',
  tags: 'Tags',
  repeat: 'Repeat',
  checks: 'Checklist',
  waits: 'Waits for',
  off: 'Time off',
};

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
  /** The task now has another id (a moved occurrence of a series). */
  onRetarget(id: string): void;
  /** Play the open animation (not when switching between blocks). */
  enter?: boolean;
}

/** On a task from the archive: what it is, and the way back into the plan. */
function ArchivedNote({ task }: { task: TaskView }) {
  const n = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? '' : 's'}` : '');
  const extras = [n(task.comments, 'comment'), n(task.files, 'file'), task.checks ? `${task.checked}/${task.checks} checked` : ''].filter(Boolean).join(', ');
  return (
    <div className="editor-archived">
      <p>
        <b>Archived.</b> It finished a while ago, so it's kept out of the live plan{extras ? `, with its ${extras}` : ''}. Restore it to change it.
      </p>
      {!isReadOnly() && (
        <button type="button" className="btn" onClick={() => restoreArchived(task.series)}>
          Restore to edit
        </button>
      )}
    </div>
  );
}

export function Editor({ task, model, sheet, side, readOnly, onClose, onRetarget, enter = true }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Optional details show once they have a value, or once asked for.
  const [extra, setExtra] = useState<Set<Extra>>(() => new Set());
  const hasValue: Record<Extra, boolean> = {
    estimate: task.estimate > 0,
    time: !!task.time,
    tags: task.tags.length > 0,
    repeat: !!task.repeat,
    waits: linksOf(task.thread).waitsFor.length + linksOf(task.thread).blocking.length > 0,
    checks: task.checks > 0,
    off: task.off,
  };
  const show = (k: Extra) => hasValue[k] || extra.has(k);
  const hidden = (task.off ? (['time', 'repeat'] as Extra[]) : EXTRAS).filter((k) => !show(k));
  const titleRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [dropping, setDropping] = useState(false);
  const attach = async (files: File[]) => {
    if (!files.length) return;
    setError((await attachFiles(task.thread, files)) ?? '');
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

  // What's typed, kept outside the input: saving on close runs after React
  // has already let go of the input (its ref is null by then).
  const typed = useRef(task.title);
  const saved = useRef(task.title);
  const saveTitle = () => {
    const v = typed.current.trim();
    if (v === saved.current || !getTask(task.id)) return;
    saved.current = v;
    updateTask(task.id, { title: v }, 'Rename task');
  };
  // Closing another way (Esc, clicking elsewhere) keeps what was typed too.
  const saveTitleRef = useRef(saveTitle);
  saveTitleRef.current = saveTitle;
  useEffect(() => () => saveTitleRef.current(), []);

  return (
    <div
      ref={ref}
      className={'editor' + (enter ? ' enter' : '') + (sheet ? ' sheet' : '') + (side ? ' side' : '') + (dropping ? ' dropping' : '') + (readOnly ? ' readonly' : '')}
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
      {sheet && <SheetGrab sheet={ref} onClose={onClose} />}
      <button type="button" className="editor-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
        <Close />
      </button>
      {task.archived && <ArchivedNote task={task} />}
      <fieldset className="editor-fieldset" disabled={readOnly}>
        <div className="editor-head">
          <button
            type="button"
            className={'done-check' + (task.done ? ' on' : '')}
            aria-pressed={task.done}
            aria-label={task.done ? 'Done; mark as not done' : 'Mark as done'}
            title={task.done ? 'Done' : 'Mark as done'}
            onClick={() => updateTask(task.series, { done: !task.done }, task.done ? 'Reopen task' : 'Complete task')}
          >
            <Check size={13} />
          </button>
          <input
            ref={titleRef}
            className="editor-title"
            placeholder="What's the plan?"
            defaultValue={task.title}
            onChange={(e) => (typed.current = e.currentTarget.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                saveTitle();
                onClose();
              }
            }}
          />
        </div>
        <div className="editor-props">
          <Prop icon={<PeopleIcon />} label="People">
            <PeopleField task={task} onRetarget={onRetarget} readOnly={readOnly} />
          </Prop>
          <Prop icon={<Calendar size={15} />} label="Dates">
            <DateField task={task} onRetarget={onRetarget} />
          </Prop>
          {!task.off && show('estimate') && (
            <Prop icon={<Hourglass size={15} />} label="Estimate">
              <EstimateField task={task} autoFocus={extra.has('estimate') && !hasValue.estimate} />
            </Prop>
          )}
          {show('time') && (
            <Prop icon={<Clock size={15} />} label="Time">
              <TimeField task={task} />
            </Prop>
          )}
          {task.off && (
            <Prop icon={<Away size={15} />} label="Type">
              <KindField task={task} />
            </Prop>
          )}
          {!task.off && (
            <>
              <Prop icon={<Folder size={15} />} label="Project">
                <ProjectField task={task} model={model} />
              </Prop>
              {show('waits') && (
                <Prop icon={<Waits size={15} />} label="Waits for">
                  <LinksField task={task} readOnly={readOnly} onOpen={onRetarget} />
                </Prop>
              )}
              {show('tags') && (
                <Prop icon={<Tag size={15} />} label="Tags">
                  <TagField task={task} model={model} />
                </Prop>
              )}
            </>
          )}
          {show('repeat') && (
            <Prop icon={<Repeat size={15} />} label="Repeat">
              <RepeatField task={task} />
            </Prop>
          )}
          {!task.off && (
            <Prop icon={<Swatch size={15} />} label="Color">
              <LookField task={task} readOnly={readOnly} />
            </Prop>
          )}
        </div>
        {!readOnly && hidden.length > 0 && (
          <div className="editor-more" aria-label="Add details">
            {hidden.map((k) => (
              <button
                key={k}
                type="button"
                className="editor-more-chip"
                onClick={() => {
                  if (k === 'off') updateTask(task.series, { kind: 'off' }, 'Mark as time off');
                  else setExtra((x) => new Set(x).add(k));
                }}
              >
                <Plus size={13} />
                {EXTRA_LABELS[k]}
              </button>
            ))}
          </div>
        )}
        <section className="editor-notes-section">
          <h3 className="editor-section-title">Description</h3>
          <Suspense fallback={<div className="rich-notes loading">{task.notes || 'Add details…'}</div>}>
            <RichNotes
              key={task.series}
              value={task.notes}
              readOnly={readOnly}
              placeholder="Add details  ·  type / for lists and headings"
              onSave={(md) => updateTask(task.series, { notes: md }, 'Edit notes')}
            />
          </Suspense>
        </section>
        {!task.off && show('checks') && <Checklist task={task} readOnly={readOnly} autoFocus={extra.has('checks')} />}
      </fieldset>
      {/* An archived task's files and comments come back with it. */}
      {!task.archived && <Attachments taskId={task.thread} onError={setError} />}
      {error && <p className="editor-error">{error}</p>}
      {!task.archived && <Discussion taskId={task.thread} collapsed={sheet && !task.comments} />}
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

/**
 * The bottom sheet's handle: the sheet follows the finger down, and closes
 * when let go far enough down (or flicked); otherwise it springs back.
 */
function SheetGrab({ sheet, onClose }: { sheet: RefObject<HTMLDivElement | null>; onClose(): void }) {
  const drag = useRef<{ id: number; y0: number; dy: number; t: number; v: number } | null>(null);
  const move = (dy: number) => {
    const el = sheet.current;
    if (el) el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  const settle = (close: boolean) => {
    const el = sheet.current;
    if (!el) return;
    el.classList.remove('dragging-sheet');
    el.classList.add('settling');
    move(close ? el.offsetHeight + 40 : 0);
    setTimeout(() => {
      el.classList.remove('settling');
      if (close) onClose();
    }, 220);
  };
  return (
    <div
      className="sheet-grab"
      aria-hidden
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, v: 0 };
        sheet.current?.classList.add('dragging-sheet');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dy = e.clientY - d.y0;
        const dt = Math.max(1, e.timeStamp - d.t);
        d.v = (dy - d.dy) / dt;
        d.dy = dy;
        d.t = e.timeStamp;
        move(dy);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        drag.current = null;
        const h = sheet.current?.offsetHeight ?? 400;
        settle(d.dy > Math.min(140, h * 0.3) || (d.dy > 20 && d.v > 0.5));
      }}
      onPointerCancel={() => {
        drag.current = null;
        settle(false);
      }}
    />
  );
}

/** One row of the details: a label and its field. */
function Prop({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">
        {icon}
        {label}
      </span>
      <div className="prop-field">{children}</div>
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
