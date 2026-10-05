import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { readView, store } from '../data/store.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { formatRange, today } from '../lib/dates.ts';
import { Calendar, Folder, Layers, People, Search } from '../ui/icons.tsx';
import type { TimelineModel } from './model.ts';
import type { ViewConfig } from '../data/store.ts';

export interface Command {
  label: string;
  /** Extra words to match on. */
  keywords?: string;
  keys?: string;
  run(): void;
}

interface Item {
  id: string;
  group: 'Commands' | 'People' | 'Projects' | 'Views' | 'Tasks';
  label: string;
  hint?: string;
  keys?: string;
  icon?: ReactNode;
  color?: string;
  text: string;
  run(): void;
}

/**
 * Fuzzy score: every query character must appear in order. Matches at the
 * start of a word, and consecutive runs, score higher; 0 = no match.
 */
export const fuzzy = (query: string, text: string): number => {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length / 10 + (at === 0 || t[at - 1] === ' ' ? 200 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const c of q) {
    const found = t.indexOf(c, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || t[found - 1] === ' ' ? 4 : 0);
    ti = found + 1;
  }
  return score;
};

interface Props {
  model: TimelineModel;
  commands: Command[];
  onFocusPerson(id: string): void;
  onFilterProject(id: string): void;
  onApplyView(c: ViewConfig): void;
  onOpenTask(id: string): void;
  onClose(): void;
}

const MAX_TASKS = 8;

export function CommandPalette({ model, commands, onFocusPerson, onFilterProject, onApplyView, onOpenTask, onClose }: Props) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // Everything except tasks; tasks are searched per keystroke below.
  const base = useMemo<Item[]>(() => {
    const out: Item[] = commands.map((c, i) => ({
      id: `c${i}`,
      group: 'Commands',
      label: c.label,
      keys: c.keys,
      text: `${c.label} ${c.keywords ?? ''}`,
      run: c.run,
    }));
    for (const u of model.allUsers())
      out.push({
        id: `u${u.id}`,
        group: 'People',
        label: u.name,
        hint: u.team ? `${u.team} · focus` : 'Focus',
        color: u.color,
        text: `${u.name} ${u.team}`,
        run: () => onFocusPerson(u.id),
      });
    for (const p of model.projects)
      if (!p.archived)
        out.push({
          id: `p${p.id}`,
          group: 'Projects',
          label: p.name,
          hint: p.client ? `${p.client} · filter` : 'Filter',
          color: p.color,
          icon: <Folder size={14} />,
          text: `${p.name} ${p.client}`,
          run: () => onFilterProject(p.id),
        });
    for (const id of store.getSortedRowIds('views', 'order'))
      out.push({
        id: `v${id}`,
        group: 'Views',
        label: store.getCell('views', id, 'name') as string,
        hint: 'Saved view',
        icon: <Layers size={14} />,
        text: store.getCell('views', id, 'name') as string,
        run: () => onApplyView(readView(id)),
      });
    return out;
  }, [commands, model, onFocusPerson, onFilterProject, onApplyView]);

  const items = useMemo(() => {
    const query = q.trim();
    const scored = base
      .map((it) => ({ it, s: fuzzy(query, it.text) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0));
    // With no query: commands and saved views.
    if (!query) return [...base.filter((i) => i.group === 'Commands'), ...base.filter((i) => i.group === 'Views')];
    const hits = scored.slice(0, 30);
    if (query.length >= 2) {
      const now = today();
      const tasks: { t: { id: string; title: string; start: number; end: number; userId: string; project: string }; s: number }[] = [];
      for (const row of model.rows)
        for (const t of row.tasks) {
          if (t.id !== t.series) continue; // one hit per recurring series
          const s = fuzzy(query, `${t.title} ${t.project}`);
          if (s > 0) tasks.push({ t, s: s - Math.min(200, Math.abs(t.start - now) / 3) });
        }
      tasks.sort((a, b) => b.s - a.s);
      for (const { t, s } of tasks.slice(0, MAX_TASKS)) {
        const who = model.rows[model.indexOfUser(t.userId)]?.name ?? '';
        hits.push({
          s,
          it: {
            id: `t${t.id}`,
            group: 'Tasks',
            label: t.title || 'Untitled',
            hint: [who, formatRange(t.start, t.end)].filter(Boolean).join(' · '),
            icon: <Calendar />,
            text: t.title,
            run: () => onOpenTask(t.id),
          },
        });
      }
    }
    // Groups stay together; the group with the best match comes first.
    const best = new Map<string, number>();
    for (const h of hits) best.set(h.it.group, Math.max(best.get(h.it.group) ?? 0, h.s));
    return hits
      .sort((a, b) => best.get(b.it.group)! - best.get(a.it.group)! || a.it.group.localeCompare(b.it.group) || b.s - a.s)
      .map((h) => h.it);
  }, [q, base, model, onOpenTask]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.pal-item.hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    // After the palette has closed (and released focus).
    requestAnimationFrame(() => it.run());
  };

  let lastGroup = '';
  return createPortal(
    <div className="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="pal-search">
          <Search />
          <input
            autoFocus
            placeholder="Type a command, person, project or task…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = items.length || 1;
                setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[hi]);
              } else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onClose();
              }
            }}
            aria-activedescendant={items[hi] ? `pal-${items[hi].id}` : undefined}
          />
        </div>
        <div className="pal-list" ref={list} role="listbox">
          {items.length === 0 && <p className="pal-empty">Nothing matches “{q}”.</p>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <div key={it.id}>
                {head && <div className="pal-group">{head}</div>}
                <button
                  id={`pal-${it.id}`}
                  role="option"
                  aria-selected={i === hi}
                  className={'pal-item' + (i === hi ? ' hi' : '')}
                  onMouseMove={() => i !== hi && setHi(i)}
                  onClick={() => run(it)}
                >
                  <span className="pal-icon" style={it.color ? { ['--c' as string]: it.color } : undefined}>
                    {it.icon ?? (it.group === 'People' ? <People /> : it.color ? <span className="dot" /> : null)}
                  </span>
                  <span className="pal-label">{it.label}</span>
                  {it.hint && <span className="pal-hint">{it.hint}</span>}
                  {it.keys && <kbd>{it.keys}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to run
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
