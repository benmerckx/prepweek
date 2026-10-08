// Planning fields in the task details: work or time off, what a task waits
// for (dependencies), and its checklist.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addCheck,
  addLink,
  checksOf,
  deleteCheck,
  getUser,
  groupMembers,
  linksOf,
  removeLink,
  store,
  updateCheck,
  updateTask,
  type TaskRow,
} from '../data/store.ts';
import { monthShort, weekdayShort, ymd } from '../lib/dates.ts';
import { Away, Check, Close, Plus, Waits } from '../ui/icons.tsx';
import type { TaskView } from './model.ts';

/** "We 8 Oct". */
const formatDay = (day: number) => `${weekdayShort(day)} ${ymd(day).d} ${monthShort(ymd(day).m)}`;

/** Re-render when a table changes. */
const useTable = (table: string) => {
  const [, bump] = useState(0);
  useEffect(() => {
    const id = store.addTableListener(table, () => bump((n) => n + 1));
    return () => void store.delListener(id);
  }, [table]);
};

/** Work or time off. */
export function KindField({ task }: { task: TaskView }) {
  const set = (off: boolean) => off !== task.off && updateTask(task.series, { kind: off ? 'off' : '' }, off ? 'Mark as time off' : 'Mark as work');
  return (
    <div className="kind-seg" role="radiogroup" aria-label="Type">
      <button type="button" role="radio" aria-checked={!task.off} className={!task.off ? 'on' : ''} onClick={() => set(false)}>
        Work
      </button>
      <button type="button" role="radio" aria-checked={task.off} className={task.off ? 'on' : ''} onClick={() => set(true)}>
        <Away size={13} />
        Time off
      </button>
    </div>
  );
}

/** The task to show for a thread: its first row. */
const rowOf = (thread: string): (TaskRow & { id: string }) | null => {
  const id = groupMembers(thread)[0];
  return id ? { id, ...(store.getRow('tasks', id) as TaskRow) } : null;
};
const who = (t: TaskRow) => getUser(t.userId)?.name ?? '';

/**
 * What this task waits for (it can't start before those end), and what
 * waits for it. Linking moves the waiting task later when it would start
 * too early; moving a task later moves what waits for it along.
 */
export function LinksField({ task, readOnly, onOpen }: { task: TaskView; readOnly?: boolean; onOpen(id: string): void }) {
  useTable('links');
  useTable('tasks');
  const { waitsFor, blocking } = linksOf(task.thread);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [error, setError] = useState('');
  const query = q.trim().toLowerCase();
  const linked = new Set([task.thread, ...waitsFor.map((l) => l.from), ...blocking.map((l) => l.to)]);
  // Nearest in time first: what ends around when this one starts.
  const options = useMemo(() => {
    if (!open) return [];
    const seen = new Set<string>();
    const out: (TaskRow & { id: string; thread: string })[] = [];
    for (const id of store.getRowIds('tasks')) {
      const t = store.getRow('tasks', id) as TaskRow;
      const thread = t.group || id;
      if (seen.has(thread) || linked.has(thread) || t.kind === 'off') continue;
      seen.add(thread);
      if (query && !(t.title || '').toLowerCase().includes(query) && !who(t).toLowerCase().includes(query)) continue;
      out.push({ ...t, id, thread });
    }
    return out.sort((a, b) => Math.abs(a.end - task.start) - Math.abs(b.end - task.start)).slice(0, 40);
  }, [open, query, task.start, linked.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string) => {
    setError(addLink(id, task.series));
    setOpen(false);
    setQ('');
  };

  const chip = (thread: string, linkId: string, side: 'before' | 'after') => {
    const t = rowOf(thread);
    if (!t) return null;
    // Waiting work that starts before what it waits for has ended.
    const late = side === 'before' ? t.end >= task.start : t.start <= task.end;
    return (
      <span key={linkId} className={'link-chip' + (late ? ' late' : '')} title={late ? 'Overlaps: this should come after the other' : undefined}>
        <button type="button" className="link-chip-open" onClick={() => onOpen(t.id)}>
          <span className="dot" style={{ background: t.color }} />
          <span className="link-chip-title">{t.title || 'Untitled'}</span>
          <span className="link-chip-sub">{side === 'before' ? `ends ${formatDay(t.end)}` : `starts ${formatDay(t.start)}`}</span>
        </button>
        {!readOnly && (
          <button type="button" className="person-chip-x" aria-label="Remove dependency" onClick={() => removeLink(linkId)}>
            <Close size={11} />
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="links-field">
      {waitsFor.map((l) => chip(l.from, l.id, 'before'))}
      {!readOnly && (
        <div className="field-pop">
          <button type="button" className="person-add" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Plus />
            <span>{waitsFor.length ? 'Add' : 'Pick a task'}</span>
          </button>
          {open && (
            <div className="combo pop">
              <input
                autoFocus
                className="combo-input"
                placeholder="Find a task or person…"
                value={q}
                onChange={(e) => {
                  setQ(e.currentTarget.value);
                  setHi(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (options[hi]) pick(options[hi].id);
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.closest('.field-pop')?.contains(e.relatedTarget as Node)) setOpen(false);
                }}
              />
              <div className="combo-list" role="listbox">
                {options.map((t, i) => (
                  <button
                    key={t.thread}
                    className={'combo-item' + (i === hi ? ' hi' : '')}
                    role="option"
                    aria-selected={false}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(t.id)}
                  >
                    <span className="dot" style={{ background: t.color }} />
                    <span className="combo-text">{t.title || 'Untitled'}</span>
                    <span className="combo-sub">
                      {who(t)} · {formatDay(t.end)}
                    </span>
                  </button>
                ))}
                {!options.length && <p className="combo-empty">No tasks found</p>}
              </div>
            </div>
          )}
        </div>
      )}
      {blocking.length > 0 && (
        <div className="links-then">
          <span className="links-then-label">
            <Waits size={13} />
            Then
          </span>
          {blocking.map((l) => chip(l.to, l.id, 'after'))}
        </div>
      )}
      {error && <p className="editor-error">{error}</p>}
    </div>
  );
}

/** Checklist items: tick, rename in place, add with Enter. */
export function Checklist({ task, readOnly, autoFocus }: { task: TaskView; readOnly?: boolean; autoFocus?: boolean }) {
  useTable('checks');
  const items = checksOf(task.thread);
  const add = useRef<HTMLInputElement>(null);
  if (readOnly && !items.length) return null;
  const done = items.filter((c) => c.done).length;
  return (
    <section className="checklist">
      <h3 className="editor-section-title">
        Checklist
        {items.length > 0 && (
          <span className="checklist-count">
            {done}/{items.length}
          </span>
        )}
      </h3>
      {items.length > 0 && (
        <div className="checklist-bar" aria-hidden>
          <span style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      )}
      <ul>
        {items.map((c) => (
          <li key={c.id} className={c.done ? 'done' : ''}>
            <button
              type="button"
              className={'check-box' + (c.done ? ' on' : '')}
              aria-pressed={c.done}
              aria-label={c.done ? `Untick ${c.text}` : `Tick ${c.text}`}
              disabled={readOnly}
              onClick={() => updateCheck(c.id, { done: !c.done }, c.done ? 'Untick item' : 'Tick item')}
            >
              <Check size={11} />
            </button>
            <input
              className="check-text"
              defaultValue={c.text}
              readOnly={readOnly}
              aria-label="Checklist item"
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (!v) deleteCheck(c.id);
                else if (v !== c.text) updateCheck(c.id, { text: v });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add.current?.focus();
                }
              }}
            />
            {!readOnly && (
              <button type="button" className="person-chip-x" aria-label={`Remove ${c.text}`} onClick={() => deleteCheck(c.id)}>
                <Close size={11} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <input
          ref={add}
          autoFocus={autoFocus}
          className="check-add"
          placeholder={items.length ? 'Add an item' : 'Add a step, a to-do…'}
          onKeyDown={(e) => {
            const v = e.currentTarget.value.trim();
            if (e.key === 'Enter' && v) {
              e.preventDefault();
              addCheck(task.thread, v);
              e.currentTarget.value = '';
            }
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v) {
              addCheck(task.thread, v);
              e.currentTarget.value = '';
            }
          }}
        />
      )}
    </section>
  );
}
