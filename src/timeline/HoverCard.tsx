// Hovering a block with a mouse shows its details in a card below it (or
// above, near the bottom of the screen): when, who, the project, a peek at
// the notes and what's on its thread. Read-only and out of the way: it never
// takes the pointer, and it goes as soon as you press, drag or scroll.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { visibleTasks, type TimelineModel } from './model.ts';
import { formatRange, workdays } from '../lib/dates.ts';
import { formatDuration, formatTime } from '../lib/times.ts';
import { initials } from './Sidebar.tsx';
import { Archive, Away, Check, Comment, ListCheck, Notes, Paperclip, Repeat } from '../ui/icons.tsx';

/** Wait this long on a block before showing its card (ms). */
const SHOW_AFTER = 450;
/** Moving from one block to the next while a card is up: swap quicker. */
const SWAP_AFTER = 120;
const GAP = 6;
const MARGIN = 8;

/** Markdown notes as a line of plain text. */
const plain = (md: string) =>
  md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.|#+|>|\[[ x]\])\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

interface Props {
  model: TimelineModel;
  /** The timeline body, where the blocks are. */
  bodyRef: RefObject<HTMLElement | null>;
  /** The task open in the editor: its card would only repeat it. */
  editing: string | null;
}

export function HoverCard({ model, bodyRef, editing }: Props) {
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const shown = useRef(false);
  shown.current = !!hover;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let timer = 0;
    let over: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      over = null;
      setHover(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons || document.body.dataset.dragging) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
      if (el === over) return;
      clearTimeout(timer);
      over = el;
      if (!el) return setHover(null);
      timer = window.setTimeout(
        () => {
          if (over === el && el.isConnected && !document.body.dataset.dragging) setHover({ id: el.dataset.task!, rect: el.getBoundingClientRect() });
        },
        shown.current ? SWAP_AFTER : SHOW_AFTER,
      );
    };
    const onLeave = () => hide();
    body.addEventListener('pointerover', onOver);
    body.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      body.removeEventListener('pointerover', onOver);
      body.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [bodyRef]);

  const task = hover && hover.id !== editing ? model.findTask(hover.id) : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hover) return setPos(null);
    const { rect } = hover;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(rect.left, innerWidth - w - MARGIN));
    const below = rect.bottom + GAP;
    const top = below + h <= innerHeight - MARGIN || rect.top - GAP - h < MARGIN ? below : rect.top - GAP - h;
    setPos({ left, top });
  }, [hover, task]);

  if (!hover || !task) return null;

  // Everyone the task is for (a block in each of their rows).
  const people = model.rows.filter((r) => r.kind === 'person' && visibleTasks(r, task.start, task.end).some((t) => t.thread === task.thread && t.start === task.start));
  const days = workdays(task.start, task.end) || task.end - task.start + 1;
  const notes = plain(task.notes);
  const badges = task.checks > 0 || task.comments > 0 || task.files > 0 || task.repeat;

  return createPortal(
    <div
      ref={ref}
      className="hovercard"
      role="tooltip"
      style={{ ['--c' as string]: task.color, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="hc-bar" />
      <div className="hc-title">
        {task.off ? <Away size={14} /> : task.done && <Check size={14} />}
        <span>{task.title || (task.off ? 'Time off' : 'Untitled')}</span>
      </div>
      <div className="hc-chips">
        <span className="hc-chip">
          {formatRange(task.start, task.end)}
          {task.start !== task.end && <span className="hc-faint"> · {days}d</span>}
        </span>
        {task.time && <span className="hc-chip">{formatTime(task.time)}</span>}
        {task.estimate > 0 && <span className="hc-chip">{formatDuration(task.estimate)} estimated</span>}
      </div>
      {notes && <p className="hc-notes">{notes}</p>}
      <div className="hc-people">
        <div className="hc-who">
          {people.slice(0, 4).map((p) => (
            <span key={p.userId} className="hc-person">
              <span className="avatar" style={{ ['--c' as string]: p.color }}>
                {p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : initials(p.name)}
              </span>
              {people.length <= 2 && <span className="hc-name">{p.name}</span>}
            </span>
          ))}
          {people.length > 4 && <span className="hc-faint">+{people.length - 4}</span>}
        </div>
        {badges && (
          <span className="hc-badges">
            {task.checks > 0 && (
              <span title="Checklist">
                <ListCheck size={13} />
                {task.checked}/{task.checks}
              </span>
            )}
            {task.comments > 0 && (
              <span title="Comments">
                <Comment size={13} />
                {task.comments}
              </span>
            )}
            {task.files > 0 && (
              <span title="Files and links">
                <Paperclip size={13} />
                {task.files}
              </span>
            )}
            {task.notes && !notes && <Notes size={13} />}
            {task.repeat && <Repeat size={13} />}
          </span>
        )}
      </div>
      {(task.project || task.tags.length > 0 || task.done || task.archived) && (
        <div className="hc-chips">
          {task.project && (
            <span className="hc-chip">
              <span className="hc-dot" />
              {task.project}
              {task.client && <span className="hc-faint"> | {task.client}</span>}
            </span>
          )}
          {task.tags.map((t) => (
            <span key={t} className="hc-chip hc-faint">
              #{t}
            </span>
          ))}
          {task.done && (
            <span className="hc-chip">
              <Check size={12} /> Done
            </span>
          )}
          {task.archived && (
            <span className="hc-chip hc-faint">
              <Archive size={12} /> Archived
            </span>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
