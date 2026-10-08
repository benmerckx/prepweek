import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_HOURS, PALETTE, commit, deleteUser, getUser, isReadOnly, renameTeam, reorderUsers, store, updateUser } from '../data/store.ts';
import { isWeekend, weekdayShort, ymd } from '../lib/dates.ts';
import { formatHours, parseTime } from '../lib/times.ts';
import { useBackToClose } from '../lib/useBackToClose.ts';
import { Away, Check, ChevronDown, Trash } from '../ui/icons.tsx';
import { getMe as getAccount, getPeople, type People } from '../data/account.ts';
import { getAccess } from '../data/access.ts';
import { identityMode, rowForEmail } from '../data/identity.ts';
import type { RowLayout, TimelineModel } from './model.ts';
import { isPopoverOpen } from '../ui/Select.tsx';

interface SidebarProps {
  model: TimelineModel;
  rows: RowLayout[];
  tops: number[];
  r0: number;
  r1: number;
  focused: boolean;
  today: number;
  /** Phones: bottom-sheet editor. */
  sheet: boolean;
  onFocusPerson(id: string, additive: boolean): void;
  onToggleTeam(team: string): void;
}

/** A person being dragged to a new place in the list. */
interface Lift {
  id: string;
  /** Top of the lifted row, in sidebar coordinates. */
  y: number;
  /** Gap index in `rows` where it would drop. */
  gap: number;
}

const LONG_PRESS = 350;

export const Sidebar = memo(function Sidebar({ model, rows, tops, r0, r1, focused, today, sheet, onFocusPerson, onToggleTeam }: SidebarProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  const [editing, setEditing] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** Set after a drag so the click that ends it doesn't open the editor. */
  const suppressClick = useRef(false);
  const latest = useRef({ rows, tops });
  latest.current = { rows, tops };

  const gapAt = (y: number) => {
    const { rows, tops } = latest.current;
    for (let i = 0; i < rows.length; i++) if (y < tops[i]! + rows[i]!.height / 2) return i;
    return rows.length;
  };

  const drop = (id: string, gap: number) => {
    const { rows } = latest.current;
    const grouped = rows.some((r) => r.kind === 'team');
    let after: string | null = null;
    let before: string | null = null;
    let team: string | undefined;
    for (let j = gap - 1; j >= 0; j--) {
      const r = rows[j]!;
      // Your own row is pinned on top, not part of the shared order.
      if (r.pinned) continue;
      if (r.kind === 'team') {
        team = r.team;
        break;
      }
      if (r.userId !== id && after === null) after = r.userId;
      if (after !== null && !grouped) break;
    }
    for (let j = gap; j < rows.length; j++) {
      const r = rows[j]!;
      if (r.pinned) continue;
      if (r.kind === 'team') break;
      if (r.userId !== id) {
        before = r.userId;
        break;
      }
    }
    const order = model.displayOrder();
    const was = order.indexOf(id);
    const list = order.filter((u) => u !== id);
    let at: number;
    if (after) at = list.indexOf(after) + 1;
    else if (before) at = list.indexOf(before);
    else if (team !== undefined) {
      const first = list.findIndex((u) => (getUser(u)?.team ?? '') === team);
      at = first >= 0 ? first : Math.min(was, list.length);
    } else at = Math.min(was, list.length);
    list.splice(at, 0, id);
    const moved = grouped && team !== undefined ? { id, team } : undefined;
    if (list.some((u, i) => u !== order[i]) || (moved && (getUser(id)?.team ?? '') !== team)) reorderUsers(list, moved);
  };

  // Reorder gesture: drag a row (mouse), or long-press then drag (touch).
  const onPointerDown = (e: React.PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.person');
    if (!el || e.button !== 0 || isReadOnly() || (e.target as HTMLElement).closest('.avatar, input')) return;
    const id = el.dataset.user!;
    const box = wrap.current!.getBoundingClientRect();
    const i = latest.current.rows.findIndex((r) => r.userId === id);
    // Your own row stays on top: nothing to drag.
    if (i < 0 || latest.current.rows[i]!.pinned) return;
    const grab = e.clientY - box.top - latest.current.tops[i]!;
    const touch = e.pointerType !== 'mouse';
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    let lastY = y0;
    let raf = 0;
    const scroller = wrap.current!.closest<HTMLElement>('.scroller');

    const update = () => {
      const b = wrap.current!.getBoundingClientRect();
      const y = lastY - b.top;
      setLift({ id, y: y - grab, gap: gapAt(y) });
    };
    // Auto-scroll near the top/bottom edge while lifting.
    const tick = () => {
      raf = 0;
      if (!started || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const edge = 48;
      const v = lastY < r.top + 80 + edge ? -1 : lastY > r.bottom - edge ? 1 : 0;
      if (v) {
        scroller.scrollTop += v * 12;
        update();
        raf = requestAnimationFrame(tick);
      }
    };
    const start = () => {
      started = true;
      navigator.vibrate?.(10);
      update();
    };
    const timer = touch ? setTimeout(start, LONG_PRESS) : undefined;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      lastY = ev.clientY;
      if (!started) {
        const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
        if (touch) {
          if (d > 8) end();
          return;
        }
        if (d < 5) return;
        start();
      }
      update();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // Once lifted on touch, the finger drags the row, not the page.
    const noScroll = (ev: TouchEvent) => started && ev.cancelable && ev.preventDefault();
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (started) {
        const b = wrap.current!.getBoundingClientRect();
        drop(id, gapAt(ev.clientY - b.top));
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false));
      }
      end();
    };
    const cancel = () => end();
    function end() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      started = false;
      setLift(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', noScroll);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', noScroll, { passive: false });
  };

  const openEditor = (id: string, el: HTMLElement) => {
    if (suppressClick.current || isReadOnly()) return;
    setEditing({ id, anchor: el.getBoundingClientRect() });
  };

  const out = [];
  for (let i = r0; i <= r1 && i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === 'team') {
      out.push(<TeamHeader key={r.userId} row={r} top={tops[i]!} onToggle={onToggleTeam} />);
      continue;
    }
    const lifted = lift?.id === r.userId;
    out.push(
      <SidebarRow
        key={r.userId}
        row={r}
        top={lifted ? lift.y : tops[i]!}
        lifted={lifted}
        focused={focused}
        today={today}
        daysOff={model.daysOff}
        onFocusPerson={onFocusPerson}
        onEdit={openEditor}
      />,
    );
  }
  // The lifted row stays mounted even when scrolled out of the window.
  if (lift && !out.some((el) => el.key === lift.id)) {
    const r = rows.find((x) => x.userId === lift.id);
    if (r)
      out.push(
        <SidebarRow key={r.userId} row={r} top={lift.y} lifted focused={focused} today={today} daysOff={model.daysOff} onFocusPerson={onFocusPerson} onEdit={openEditor} />,
      );
  }

  return (
    <div className={'sb-rows' + (lift ? ' reordering' : '')} ref={wrap} onPointerDown={onPointerDown}>
      {out}
      {lift && (
        <div
          className="drop-line"
          style={{ transform: `translateY(${lift.gap < rows.length ? tops[lift.gap]! : tops[rows.length]!}px)` }}
        />
      )}
      {editing && store.hasRow('users', editing.id) && (
        <PersonEditor key={editing.id} id={editing.id} anchor={editing.anchor} model={model} sheet={sheet} onClose={() => setEditing(null)} />
      )}
    </div>
  );
});

const TeamHeader = memo(function TeamHeader({ row, top, onToggle }: { row: RowLayout; top: number; onToggle(team: string): void }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className={'team-head' + (row.collapsed ? ' collapsed' : '')} style={{ transform: `translateY(${top}px)`, height: row.height }}>
      {renaming && row.team ? (
        <input
          className="person-input"
          autoFocus
          defaultValue={row.team}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== row.team) renameTeam(row.team, v);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          className="team-toggle"
          aria-expanded={!row.collapsed}
          onClick={() => onToggle(row.team)}
          onDoubleClick={() => row.team && setRenaming(true)}
          title={row.collapsed ? 'Show team' : 'Collapse team (double-click to rename)'}
        >
          <span className="team-chev">
            <ChevronDown size={14} />
          </span>
          <span className="team-name">{row.name}</span>
          <span className="team-count">{row.count}</span>
        </button>
      )}
    </div>
  );
});

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

const LOAD_DAYS = 28;

/**
 * How booked someone is over the next four weeks, in hours against their
 * working day: an estimate spreads over the block's workdays, a timed task
 * counts its time, and a task without either fills the day (two of those on
 * one day don't make it 200%: that's parallel work, shown apart). Done work,
 * weekends, days off for everyone and their own time off don't count. Also
 * until when they're away if they're off today.
 */
const upcomingLoad = (row: RowLayout, today: number, daysOff: ReadonlySet<number>) => {
  const end = today + LOAD_DAYS - 1;
  const cap = row.hours || DEFAULT_HOURS;
  const workday = (d: number) => !isWeekend(d) && !daysOff.has(d);
  const hours = new Map<number, number>();
  const full = new Map<number, number>();
  const away = new Set<number>();
  // Tasks are sorted by start; none is longer than maxSpan.
  let lo = 0;
  let hi = row.tasks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (row.tasks[mid]!.start < today - row.maxSpan - 1) lo = mid + 1;
    else hi = mid;
  }
  let awayEnd = -1;
  for (let i = lo; i < row.tasks.length && row.tasks[i]!.start <= end + 60; i++) {
    const t = row.tasks[i]!;
    if (t.end < today) continue;
    if (t.off) {
      // Stretches of time off, to tell when they're back (looks past the window).
      for (let d = t.start; d <= t.end; d++) away.add(d);
      continue;
    }
    if (t.start > end || t.done) continue;
    const timed = parseTime(t.time);
    let perDay = 0;
    if (t.estimate > 0) {
      let n = 0;
      for (let d = t.start; d <= t.end; d++) if (workday(d)) n++;
      perDay = t.estimate / 60 / (n || t.end - t.start + 1);
    } else if (timed?.end != null) perDay = (timed.end - timed.start) / 60;
    for (let d = Math.max(t.start, today); d <= Math.min(t.end, end); d++) {
      if (perDay) hours.set(d, (hours.get(d) ?? 0) + perDay);
      else full.set(d, (full.get(d) ?? 0) + 1);
    }
  }
  let booked = 0;
  let over = 0;
  let total = 0;
  for (let d = today; d <= end; d++) {
    if (!workday(d) || away.has(d)) continue;
    total++;
    const h = hours.get(d) ?? 0;
    const f = full.get(d) ?? 0;
    booked += Math.max(f ? cap : 0, h);
    if (h > cap + 0.01 || f > 1) over++;
  }
  if (away.has(today)) {
    // Last day off, carrying on over weekends and days off in between.
    awayEnd = today;
    for (let d = today + 1; d < today + 90; d++) {
      if (away.has(d)) awayEnd = d;
      else if (workday(d)) break;
    }
  }
  const capacity = total * cap;
  return { pct: capacity ? booked / capacity : 0, over: total ? over / total : 0, overDays: over, booked, capacity, cap, awayEnd };
};

/** "Mon 12": the first workday after `day`. */
const backOn = (day: number, daysOff: ReadonlySet<number>) => {
  let d = day + 1;
  while (isWeekend(d) || daysOff.has(d)) d++;
  return `${weekdayShort(d)} ${ymd(d).d}`;
};

interface RowProps {
  row: RowLayout;
  top: number;
  lifted?: boolean;
  focused: boolean;
  today: number;
  daysOff: ReadonlySet<number>;
  onFocusPerson(id: string, additive: boolean): void;
  onEdit(id: string, el: HTMLElement): void;
}

const SidebarRow = memo(function SidebarRow({ row, top, lifted, focused, today, daysOff, onFocusPerson, onEdit }: RowProps) {
  const load = useMemo(() => upcomingLoad(row, today, daysOff), [row.tasks, row.hours, today, daysOff]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = row.name.split(/\s+/)[0];
  return (
    <div
      className={'person' + (focused ? ' in-focus' : '') + (lifted ? ' lifted' : '') + (row.pinned ? ' pinned' : '')}
      data-user={row.userId}
      style={{ transform: `translateY(${top}px)`, height: row.height }}
    >
      <button
        className="avatar"
        style={{ ['--c' as string]: row.color }}
        title={focused ? 'Show everyone' : `Focus on ${first} (⌘/Shift-click to add)`}
        aria-label={focused ? 'Show everyone' : `Focus on ${row.name}`}
        aria-pressed={focused}
        onClick={(e) => onFocusPerson(row.userId, e.metaKey || e.ctrlKey || e.shiftKey)}
      >
        {row.avatar ? <img src={row.avatar} alt="" referrerPolicy="no-referrer" /> : initials(row.name)}
      </button>
      <button className="person-name" onClick={(e) => onEdit(row.userId, e.currentTarget.parentElement!)} title={`${row.name} · click to edit, drag to reorder`}>
        <span className="person-full">{row.name}</span>
        <span className="person-first">{first}</span>
        {load.awayEnd >= 0 ? (
          <span className="person-sub away" title="Time off today">
            <Away size={12} />
            Away, back {backOn(load.awayEnd, daysOff)}
          </span>
        ) : (
          <span
            className={'person-sub' + (load.pct > 1.005 ? ' over' : '')}
            title={
              `Next 4 weeks: ${formatHours(load.booked)} booked of ${formatHours(load.capacity)} (${formatHours(load.cap)} a day; time off and days off not counted)` +
              (load.overDays ? `. Overbooked on ${load.overDays} ${load.overDays === 1 ? 'day' : 'days'}.` : '')
            }
          >
            <span className="load">
              <span className="load-fill" style={{ width: `${Math.min(100, Math.round(load.pct * 100))}%` }} />
              <span className="load-over" style={{ width: `${Math.round(load.over * 100)}%` }} />
            </span>
            {Math.round(load.pct * 100)}% booked
          </span>
        )}
      </button>
    </div>
  );
});

// --- Person editor ----------------------------------------------------------------

const EDITOR_W = 300;

/**
 * The row's email ties it to the account that logs in with it: that person
 * gets their mentions and notifications, and is "me" on this row.
 */
function AccountField({ id }: { id: string }) {
  const u = getUser(id)!;
  const [email, setEmail] = useState(u.email ?? '');
  const [members, setMembers] = useState<People['members']>([]);
  const signedIn = identityMode() === 'account';
  const mine = getAccount()?.user?.email ?? '';
  const ws = getAccess()?.workspace;
  useEffect(() => {
    if (!signedIn || !ws) return;
    let live = true;
    getPeople(ws.id)
      .then((p) => live && setMembers(p.members))
      .catch(() => {});
    return () => void (live = false);
  }, [signedIn, ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (v: string) => {
    v = v.trim();
    if (v !== (u.email ?? '')) updateUser(id, { email: v }, 'Edit email');
  };
  const isMine = !!mine && email.trim().toLowerCase() === mine.toLowerCase();
  const member = members.find((m) => m.email.toLowerCase() === email.trim().toLowerCase());
  /** Tie this row to my login (and untie the row that had it). */
  const thisIsMe = () => {
    const prev = rowForEmail(mine);
    commit('This is me', [['users', id], ...(prev && prev !== id ? [['users', prev] as ['users', string]] : [])], () => {
      if (prev && prev !== id) store.setCell('users', prev, 'email', '');
      store.setCell('users', id, 'email', mine);
      // A row nobody named yet takes your name.
      const name = getAccount()?.user?.name;
      if (name && /^new person$/i.test(u.name)) store.setCell('users', id, 'name', name);
    });
    setEmail(mine);
  };

  return (
    <>
      <label className="pe-field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          placeholder="Their login email"
          list={members.length ? 'pe-members' : undefined}
          onChange={(e) => setEmail(e.currentTarget.value)}
          onBlur={(e) => save(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {members.length > 0 && (
          <datalist id="pe-members">
            {members.map((m) => (
              <option key={m.id} value={m.email}>
                {m.name}
              </option>
            ))}
          </datalist>
        )}
      </label>
      {signedIn && (
        <div className="pe-account">
          {isMine ? (
            <span className="pe-linked">
              <Check size={13} /> This is you
            </span>
          ) : member ? (
            <span className="pe-linked">
              <Check size={13} /> {member.name}’s account
            </span>
          ) : (
            <span>{email.trim() ? 'No account with this email in the workspace yet' : 'Not tied to an account'}</span>
          )}
          {!isMine && !isReadOnly() && (
            <button className="link-btn" onClick={thisIsMe}>
              This is me
            </button>
          )}
        </div>
      )}
    </>
  );
}

function PersonEditor({ id, anchor, model, sheet, onClose }: { id: string; anchor: DOMRect; model: TimelineModel; sheet: boolean; onClose(): void }) {
  useBackToClose(true, onClose);
  const ref = useRef<HTMLDivElement>(null);
  const u = getUser(id)!;
  const teams = useMemo(() => [...new Set(model.allUsers().map((x) => x.team).filter(Boolean))].sort(), [model]);
  const tasks = useMemo(() => store.getRowIds('tasks').filter((t) => store.getCell('tasks', t, 'userId') === id).length, [id]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !isPopoverOpen()) onClose();
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', away, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', away, true);
    };
  }, [onClose]);

  const save = (field: 'name' | 'team' | 'email', v: string) => {
    v = v.trim();
    if (field === 'name' && !v) return;
    if (v !== (u[field] ?? '')) updateUser(id, { [field]: v }, field === 'name' ? 'Rename person' : field === 'team' ? 'Move to team' : 'Edit email');
  };
  const top = Math.max(8, Math.min(anchor.top, innerHeight - 380));

  return createPortal(
    <div
      ref={ref}
      className={'editor person-editor' + (sheet ? ' sheet' : '')}
      style={sheet ? undefined : { position: 'fixed', left: Math.min(anchor.right + 8, innerWidth - EDITOR_W - 8), top }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="pe-head">
        <span className="avatar big" style={{ ['--c' as string]: u.color }}>
          {u.avatar ? <img src={u.avatar} alt="" referrerPolicy="no-referrer" /> : initials(u.name)}
        </span>
        <input
          className="editor-title"
          autoFocus={!sheet}
          defaultValue={u.name}
          aria-label="Name"
          onBlur={(e) => save('name', e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
      <label className="pe-field">
        <span>Team</span>
        <input
          defaultValue={u.team ?? ''}
          placeholder="No team"
          list="pe-teams"
          onBlur={(e) => save('team', e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <datalist id="pe-teams">
          {teams.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      <label className="pe-field">
        <span>Works</span>
        <span className="pe-hours">
          <input
            type="number"
            inputMode="decimal"
            min={0.5}
            max={24}
            step={0.5}
            defaultValue={u.hours || DEFAULT_HOURS}
            aria-label="Working hours a day"
            onBlur={(e) => {
              const h = Math.round(Math.min(24, Math.max(0.5, Number(e.currentTarget.value) || DEFAULT_HOURS)) * 2) / 2;
              e.currentTarget.value = String(h);
              if (h !== (u.hours || DEFAULT_HOURS)) updateUser(id, { hours: h === DEFAULT_HOURS ? 0 : h }, 'Change working hours');
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          hours a day
        </span>
      </label>
      <AccountField id={id} />
      <div className="swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={'swatch' + (c === u.color ? ' on' : '')}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            aria-pressed={c === u.color}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateUser(id, { color: c }, 'Recolor person')}
          >
            {c === u.color && <Check size={13} />}
          </button>
        ))}
      </div>
      <p className="pe-hint">Drag a name up or down to reorder; drop it under another team to move it there.</p>
      <div className="editor-actions">
        <button
          className="btn danger"
          onClick={() => {
            if (tasks && !confirm(`Remove ${u.name} and their ${tasks} tasks? You can undo this.`)) return;
            onClose();
            deleteUser(id);
          }}
        >
          <Trash />
          Remove
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
