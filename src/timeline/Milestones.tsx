import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Milestone } from './model.ts';
import type { Viewport } from './viewport.ts';
import type { Scale } from './scale.ts';
import { createMilestone, deleteMilestone, MILESTONE_COLORS, store, updateMilestone, isReadOnly } from '../data/store.ts';
import { formatDay } from '../lib/dates.ts';
import { useBackToClose } from '../lib/useBackToClose.ts';
import { Check, Flag, Plus, Trash } from '../ui/icons.tsx';

// Milestones are sheet-wide dated markers: a flagged pill in the header's
// milestone lane and a tinted day column through every row. Pills drag to
// move (one undo step on drop) and click to edit; clicking an empty spot in
// the lane adds one on that day.

const visible = (ms: Milestone[], d0: number, d1: number) => ms.filter((m) => m.day >= d0 - 14 && m.day <= d1);

export interface MsDrag {
  id: string;
  day: number;
}

interface BandProps {
  milestones: Milestone[];
  d0: number;
  d1: number;
  scale: Scale;
  vp: Viewport;
  drag: MsDrag | null;
  onDrag(d: MsDrag | null): void;
  onEdit(id: string, anchor: DOMRect, fresh?: boolean): void;
}

export const MilestoneBand = memo(function MilestoneBand({ milestones, d0, d1, scale, vp, drag, onDrag, onEdit }: BandProps) {
  const colW = scale.colW;
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const press = useRef<{ id: string; el: HTMLElement; pointerId: number; x: number; day: number; moved: boolean } | null>(null);
  // A pill press ends with a click on the lane (pointer capture); ignore it.
  const swallowClick = useRef(false);
  const shown = visible(milestones, d0, d1);
  const occupied = new Set(shown.map((m) => m.day));

  return (
    <div
      className="hd-ms"
      onPointerMove={(e) => {
        const p = press.current;
        if (p && e.pointerId === p.pointerId) {
          if (!p.moved && Math.abs(e.clientX - p.x) < 4) return;
          p.moved = true;
          // Move in columns so a hidden weekend is skipped, not landed on.
          const delta = Math.round((e.clientX - p.x) / colW);
          onDrag({ id: p.id, day: scale.dayOfCol(scale.col(p.day) + delta) });
          return;
        }
        if (e.pointerType === 'mouse') setHoverDay(Math.floor(vp.dayAt(e.clientX)));
      }}
      onPointerLeave={() => setHoverDay(null)}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (!p || e.pointerId !== p.pointerId) return;
        swallowClick.current = true;
        if (p.moved && drag && drag.day !== p.day) {
          updateMilestone(p.id, { day: drag.day }, 'Move milestone');
        } else if (!p.moved) {
          onEdit(p.id, p.el.getBoundingClientRect());
        }
        onDrag(null);
      }}
      onPointerCancel={() => {
        press.current = null;
        onDrag(null);
      }}
      onClick={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          return;
        }
        if (isReadOnly()) return;
        const day = Math.floor(vp.dayAt(e.clientX));
        const id = createMilestone({ day, title: '', color: MILESTONE_COLORS[0] });
        // The lane spans the body, so its left edge is day `origin`.
        const lane = e.currentTarget.getBoundingClientRect();
        onEdit(id, new DOMRect(lane.left + scale.x(day), lane.top, colW, lane.height), true);
      }}
    >
      {hoverDay !== null && !occupied.has(hoverDay) && !press.current && (
        <div className="ms-ghost" style={{ transform: `translateX(${scale.x(hoverDay)}px)`, width: colW }}>
          <Plus />
        </div>
      )}
      {shown.map((m) => {
        const day = drag?.id === m.id ? drag.day : m.day;
        return (
          <button
            key={m.id}
            data-ms={m.id}
            className={'ms-pill' + (drag?.id === m.id ? ' dragging' : '') + (m.title ? '' : ' untitled')}
            style={{ transform: `translateX(${scale.x(day)}px)`, ['--c' as string]: m.color }}
            title={`${m.title || 'Untitled milestone'} · ${formatDay(day)}`}
            onPointerDown={(e) => {
              if (e.button !== 0 || isReadOnly()) return;
              e.stopPropagation();
              (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
              press.current = { id: m.id, el: e.currentTarget, pointerId: e.pointerId, x: e.clientX, day: m.day, moved: false };
              setHoverDay(null);
            }}
          >
            <Flag size={12} />
            <span>{m.title || 'Milestone'}</span>
          </button>
        );
      })}
    </div>
  );
});

interface LinesProps {
  milestones: Milestone[];
  d0: number;
  d1: number;
  scale: Scale;
  height: number;
  drag: MsDrag | null;
}

/** A tinted day column with a colored edge for each milestone. */
export const MilestoneLines = memo(function MilestoneLines({ milestones, d0, d1, scale, height, drag }: LinesProps) {
  return (
    <>
      {milestones
        .filter((m) => {
          const day = drag?.id === m.id ? drag.day : m.day;
          return day >= d0 && day <= d1;
        })
        .map((m) => (
          <div
            key={m.id}
            className="ms-col"
            style={{
              transform: `translateX(${scale.x(drag?.id === m.id ? drag.day : m.day)}px)`,
              width: Math.max(2, scale.w(drag?.id === m.id ? drag.day : m.day, drag?.id === m.id ? drag.day : m.day)),
              height,
              ['--c' as string]: m.color,
            }}
          />
        ))}
    </>
  );
});

const EDITOR_W = 300;
const isoDay = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
const fromIso = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000);

interface EditorProps {
  id: string;
  anchor: DOMRect;
  sheet: boolean;
  /** Just created from the lane: closing without a name removes it again. */
  fresh?: boolean;
  onClose(): void;
}

export function MilestoneEditor({ id, anchor, sheet, fresh, onClose }: EditorProps) {
  // Every way out (Done, Enter, Esc, outside click, back button) saves.
  const closeRef = useRef<() => void>(onClose);
  useBackToClose(true, () => closeRef.current());
  const ref = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const m = store.hasRow('milestones', id) ? (store.getRow('milestones', id) as Omit<Milestone, 'id'>) : null;
  const [, force] = useState(0);

  useEffect(() => {
    const l = store.addRowListener('milestones', id, () => force((n) => n + 1));
    return () => void store.delListener(l);
  }, [id]);

  useEffect(() => {
    if (!sheet || !m?.title) {
      title.current?.focus({ preventScroll: true });
      title.current?.select();
    }
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', away, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps


  if (!m) return null;
  const save = () => {
    const v = title.current?.value.trim() ?? '';
    if (v !== m.title) updateMilestone(id, { title: v }, 'Rename milestone');
  };
  const close = () => {
    const name = title.current?.value.trim() ?? m.title;
    // A fresh milestone closed without a name was a misclick: drop it.
    if (fresh && !name) deleteMilestone(id);
    else save();
    onClose();
  };
  closeRef.current = close;

  return createPortal(
    <div
      ref={ref}
      className={'editor ms-editor' + (sheet ? ' sheet' : '')}
      // Below the pill, kept inside the window (the popover is EDITOR_W wide).
      style={sheet ? undefined : { position: 'fixed', left: Math.max(8, Math.min(anchor.left, innerWidth - EDITOR_W - 8)), top: anchor.bottom + 8 }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      }}
    >
      <div className="ms-editor-head" style={{ ['--c' as string]: m.color }}>
        <span className="ms-editor-flag">
          <Flag />
        </span>
        <input
          ref={title}
          className="editor-title"
          placeholder="Milestone name"
          defaultValue={m.title}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close();
          }}
        />
      </div>
      <label className="ms-date">
        <span>Date</span>
        <input type="date" value={isoDay(m.day)} onChange={(e) => e.currentTarget.value && updateMilestone(id, { day: fromIso(e.currentTarget.value) }, 'Move milestone')} />
      </label>
      <div className="swatches">
        {MILESTONE_COLORS.map((c) => (
          <button
            key={c}
            className={'swatch' + (c === m.color ? ' on' : '')}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            aria-pressed={c === m.color}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateMilestone(id, { color: c }, 'Recolor milestone')}
          >
            {c === m.color && <Check size={13} />}
          </button>
        ))}
      </div>
      <div className="editor-actions">
        <button
          className="btn danger"
          onClick={() => {
            deleteMilestone(id);
            onClose();
          }}
        >
          <Trash />
          Delete
        </button>
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
