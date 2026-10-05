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
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            saveTitle();
            onClose();
          }
        }}
      />
      <div className="editor-meta">
        {formatRange(task.start, task.end)} · {workdays(task.start, task.end)} workdays
      </div>
      <div className="swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={'swatch' + (c === task.color ? ' on' : '')}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => updateTask(task.id, { color: c }, 'Recolor task')}
          />
        ))}
      </div>
      <textarea
        className="editor-notes"
        placeholder="Notes"
        defaultValue={task.notes}
        rows={2}
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
