// Hovering a block with a mouse shows its details in a card that follows the
// cursor, below and to the right of it (held in at the screen's right edge,
// above the cursor near the bottom): when, who, the project, a peek at the
// notes and what's on its thread. Read-only and out of the way: it never
// takes the pointer, and it goes as soon as you press, drag or scroll.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { visibleTasks, type TimelineModel } from './model.ts';
import { dateFromDay, workdays } from '../lib/dates.ts';
import { formatDuration, formatTime } from '../lib/times.ts';
import { initials } from './Sidebar.tsx';
import { Archive, Away, Calendar, Check, Clock, Comment, ListCheck, Notes, Paperclip, Repeat } from '../ui/icons.tsx';

/** "Wed 14 Oct", in the user's language. */
const longDay = (d: number) => dateFromDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Room between the cursor and the card. */
const OFFSET_X = 14;
const OFFSET_Y = 18;
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
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  /** Where the cursor is (viewport px). */
  const at = useRef({ x: 0, y: 0 });

  // Moved on every pointer move without rendering: just the card's position.
  const place = () => {
    const el = ref.current;
    if (!el) return;
    const { x, y } = at.current;
    // Always to the right of the cursor, stopping at the screen's edge.
    el.style.left = `${Math.round(Math.max(MARGIN, Math.min(x + OFFSET_X, innerWidth - el.offsetWidth - MARGIN)))}px`;
    // Below the cursor in the top half of the screen, above it in the bottom
    // half: decided by where the cursor is, so it never jumps once shown.
    const below = y < innerHeight / 2;
    el.style.top = below ? `${Math.round(y + OFFSET_Y)}px` : 'auto';
    el.style.bottom = below ? 'auto' : `${Math.round(innerHeight - y + OFFSET_Y / 2)}px`;
    el.style.visibility = 'visible';
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let over: HTMLElement | null = null;
    const hide = () => {
      over = null;
      setHover(null);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      at.current = { x: e.clientX, y: e.clientY };
      if (e.buttons || document.body.dataset.dragging) {
        if (over) hide();
        return;
      }
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
      if (el !== over) {
        over = el;
        setHover(el ? el.dataset.task! : null);
      }
      place();
    };
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerleave', hide);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerleave', hide);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [bodyRef]);

  const task = hover && hover !== editing ? model.findTask(hover) : undefined;
  // Once rendered (or re-rendered at another size), put it by the cursor.
  useLayoutEffect(() => {
    if (task) place();
  });

  if (!hover || !task) return null;

  // Everyone the task is for (a block in each of their rows).
  const people = model.rows.filter((r) => r.kind === 'person' && visibleTasks(r, task.start, task.end).some((t) => t.thread === task.thread && t.start === task.start));
  const span = task.end - task.start + 1;
  const days = workdays(task.start, task.end) || span;
  const notes = plain(task.notes);
  const sub = [task.project, task.client].filter(Boolean).join(' · ');

  return createPortal(
    <div ref={ref} className={'hovercard' + (task.done ? ' done' : '') + (task.off ? ' off' : '')} role="tooltip" style={{ ['--c' as string]: task.color }}>
      {/* The top looks like the block itself: its tint, its ink. */}
      <div className="hc-head" data-pattern={(!task.off && !task.done && task.pattern) || undefined}>
        <div className="hc-title">
          {task.off ? <Away size={14} /> : task.done && <Check size={14} />}
          <span>{task.title || (task.off ? 'Time off' : 'Untitled')}</span>
        </div>
        {sub && <div className="hc-sub">{sub}</div>}
      </div>
      <div className="hc-facts">
        <div className="hc-fact">
          <Calendar size={13} />
          <span>{task.start === task.end ? longDay(task.start) : `${longDay(task.start)} → ${longDay(task.end)}`}</span>
          <span className="hc-faint">{days === span ? (days === 1 ? '1 day' : `${days} days`) : days === 1 ? '1 workday' : `${days} workdays`}</span>
        </div>
        {(task.time || task.estimate > 0) && (
          <div className="hc-fact">
            <Clock size={13} />
            <span>{[task.time && formatTime(task.time), task.estimate > 0 && `${formatDuration(task.estimate)} estimated`].filter(Boolean).join(' · ')}</span>
          </div>
        )}
        {task.repeat && (
          <div className="hc-fact">
            <Repeat size={13} />
            <span>Repeats</span>
          </div>
        )}
        {notes && <p className="hc-notes">{notes}</p>}
      </div>
      <div className="hc-foot">
        <span className="hc-who">
          <span className="hc-avatars">
            {people.slice(0, 4).map((p) => (
              <span key={p.userId} className="avatar" style={{ ['--c' as string]: p.color }}>
                {p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" /> : initials(p.name)}
              </span>
            ))}
          </span>
          <span className="hc-names">{people.length <= 2 ? people.map((p) => p.name).join(' & ') : `${people.length} people`}</span>
        </span>
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
          {task.archived && (
            <span title="Archived">
              <Archive size={13} />
            </span>
          )}
        </span>
      </div>
      {task.tags.length > 0 && (
        <div className="hc-tags">
          {task.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
