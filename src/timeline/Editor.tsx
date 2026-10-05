import { useEffect, useRef } from 'react';
import { PALETTE, deleteTask, updateTask } from '../data/store.ts';
import { formatRange, workdays } from '../lib/dates.ts';
import type { TaskView } from './model.ts';

interface Props {
  task: TaskView;
  x: number;
  y: number;
  /** Render as a bottom sheet (phones). */
  sheet?: boolean;
  onClose(): void;
}

export function Editor({ task, x, y, sheet, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  /** The text field that last had focus, so picking a color can keep it. */
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // On phones only jump into the keyboard for a new (untitled) task.
    if (!sheet || !task.title) {
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
      className={'editor' + (sheet ? ' sheet' : '')}
      data-no-drag
      style={sheet ? undefined : { transform: `translate(${x}px, ${y}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
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
        {formatRange(task.start, task.end)} · {workdays(task.start, task.end)} workday{workdays(task.start, task.end) === 1 ? '' : 's'}
      </div>
      <div className="swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={'swatch' + (c === task.color ? ' on' : '')}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            // Don't take focus: the text field keeps it, so on phones the
            // keyboard stays up while you pick a color.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              updateTask(task.id, { color: c }, 'Recolor task');
              const f = lastField.current;
              if (f && document.activeElement !== f) f.focus({ preventScroll: true });
            }}
          />
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
      <div className="editor-actions">
        <button
          className="btn danger"
          onClick={() => {
            deleteTask(task.id);
            onClose();
          }}
        >
          Delete
        </button>
        <span className="hint">⌫ delete · ⌘D dup · ←→ move</span>
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
