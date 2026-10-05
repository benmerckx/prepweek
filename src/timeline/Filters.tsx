import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createView, deleteView, readView, store, updateView, type ViewConfig } from '../data/store.ts';
import { Check, ChevronDown, Close, FilterIcon, Folder, Layers, Plus } from '../ui/icons.tsx';
import type { TimelineModel } from './model.ts';
import { byClient } from './Projects.tsx';

export interface FilterState {
  projects: string[]; // project ids; '' = tasks without a project
  tags: string[]; // lower-cased
}
export const NO_FILTER: FilterState = { projects: [], tags: [] };

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Funnel menu: filter blocks by project (grouped by client) and by tag. */
export function FilterMenu({
  model,
  filter,
  onFilter,
  onManageProjects,
}: {
  model: TimelineModel;
  filter: FilterState;
  onFilter(f: FilterState): void;
  onManageProjects(): void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const n = filter.projects.length + filter.tags.length;
  const counts = useMemo(() => (open ? model.projectCounts() : new Map<string, number>()), [open, model.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => (open ? model.allTags() : []), [open, model.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = model.projects.filter((p) => !p.archived || filter.projects.includes(p.id));

  const Item = ({ id, label, color, sub }: { id: string; label: string; color?: string; sub?: string }) => {
    const on = filter.projects.includes(id);
    return (
      <button className={'tb-person' + (on ? ' on' : '')} onClick={() => onFilter({ ...filter, projects: toggle(filter.projects, id) })}>
        {color ? <span className="tb-person-dot" style={{ background: color }} /> : <span className="tb-person-dot empty" />}
        <span className="fl-label">{label}</span>
        {sub && <span className="fl-count">{sub}</span>}
        {on && (
          <span className="tb-check">
            <Check size={14} />
          </span>
        )}
      </button>
    );
  };

  return (
    <details className="tb-filter tb-dd" ref={ref} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={'btn icon' + (n ? ' active' : '')} aria-label="Filter" title="Filter by project or tag">
        <FilterIcon />
        {n > 0 && <span className="tb-badge">{n}</span>}
      </summary>
      <div className="tb-menu fl-menu">
        <div className="fl-head">
          <span>Filter</span>
          {n > 0 && (
            <button className="link-btn" onClick={() => onFilter({ projects: [], tags: [] })}>
              Clear
            </button>
          )}
        </div>
        {open && (
          <div className="fl-scroll">
            <div className="menu-label">Projects</div>
            {projects.length === 0 && <p className="fl-empty">No projects yet.</p>}
            {byClient(projects).map(([client, ps]) => (
              <div key={client || '-'} className="fl-group">
                {client && <div className="fl-client">{client}</div>}
                {ps.map((p) => (
                  <Item key={p.id} id={p.id} label={p.name} color={p.color} sub={String(counts.get(p.id) ?? 0)} />
                ))}
              </div>
            ))}
            {projects.length > 0 && <Item id="" label="No project" sub={String(counts.get('') ?? 0)} />}
            <button
              className="menu-item"
              onClick={() => {
                ref.current?.removeAttribute('open');
                onManageProjects();
              }}
            >
              <Folder />
              Manage projects…
            </button>
            <div className="menu-sep" />
            <div className="menu-label">Tags</div>
            {tags.length === 0 ? (
              <p className="fl-empty">No tags yet. Add them in the task editor.</p>
            ) : (
              <div className="fl-tags">
                {tags.map((t) => {
                  const on = filter.tags.includes(t.toLowerCase());
                  return (
                    <button
                      key={t}
                      className={'tag-chip' + (on ? ' on' : '')}
                      aria-pressed={on}
                      onClick={() => onFilter({ ...filter, tags: toggle(filter.tags, t.toLowerCase()) })}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

// --- Saved views ----------------------------------------------------------------

/** Canonical form for comparing a view with the current state (zoom aside). */
const norm = (c: ViewConfig) =>
  JSON.stringify([
    [...(c.focus ?? [])].sort(),
    (c.query ?? '').trim().toLowerCase(),
    [...(c.projects ?? [])].sort(),
    [...(c.tags ?? [])].sort(),
    !!c.hideWeekends,
    !!c.dense,
  ]);

// getTable() returns a fresh object each call, so snapshot a counter.
let viewsVersion = 0;
const viewsSnapshot = () => viewsVersion;
const subscribeViews = (fn: () => void) => {
  const id = store.addTableListener('views', () => {
    viewsVersion++;
    fn();
  });
  return () => void store.delListener(id);
};

export function ViewsMenu({ current, onApply }: { current: ViewConfig; onApply(c: ViewConfig): void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const version = useSyncExternalStore(subscribeViews, viewsSnapshot);
  const [naming, setNaming] = useState<string | null>(null);
  const views = useMemo(
    () =>
      Object.entries(store.getTable('views'))
        .map(([id, r]) => ({ id, name: r.name as string, order: r.order as number, config: readView(id) }))
        .sort((a, b) => a.order - b.order),
    [version],
  );
  const cur = norm(current);
  const active = views.find((v) => norm(v.config) === cur);
  const isDefault = cur === norm({ hideWeekends: current.hideWeekends, dense: current.dense });
  const close = () => {
    ref.current?.removeAttribute('open');
    setNaming(null);
  };
  const label = active?.name ?? (isDefault ? 'Everything' : 'Custom view');

  return (
    <details className="tb-views tb-dd" ref={ref} onToggle={(e) => !e.currentTarget.open && setNaming(null)}>
      <summary className="btn views-btn" title="Saved views">
        <Layers />
        <span className="views-name">{label}</span>
        <ChevronDown size={14} />
      </summary>
      <div className="tb-menu views-menu">
        <div className="menu-label">Views</div>
        <button
          className={'tb-person' + (isDefault ? ' on' : '')}
          onClick={() => {
            onApply({ focus: [], query: '', projects: [], tags: [] });
            close();
          }}
        >
          <span className="fl-label">Everything</span>
          <span className="fl-count">Everyone, no filters</span>
          {isDefault && (
            <span className="tb-check">
              <Check size={14} />
            </span>
          )}
        </button>
        {views.map((v) => (
          <div key={v.id} className={'view-item' + (v === active ? ' on' : '')}>
            <button
              className="tb-person"
              onClick={() => {
                onApply(v.config);
                close();
              }}
            >
              <span className="fl-label">{v.name}</span>
              <span className="fl-count">{describe(v.config)}</span>
              {v === active && (
                <span className="tb-check">
                  <Check size={14} />
                </span>
              )}
            </button>
            <button
              className="view-del"
              aria-label={`Delete view ${v.name}`}
              title="Delete view"
              onClick={() => confirm(`Delete the view “${v.name}”?`) && deleteView(v.id)}
            >
              <Close size={13} />
            </button>
          </div>
        ))}
        <div className="menu-sep" />
        {naming !== null ? (
          <form
            className="view-save"
            onSubmit={(e) => {
              e.preventDefault();
              const name = naming.trim();
              if (!name) return;
              const same = views.find((v) => v.name.toLowerCase() === name.toLowerCase());
              if (same) updateView(same.id, { config: current });
              else createView(name, current);
              close();
            }}
          >
            <input
              autoFocus
              placeholder="Name this view"
              value={naming}
              onChange={(e) => setNaming(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))}
            />
            <button className="btn primary small" disabled={!naming.trim()}>
              Save
            </button>
          </form>
        ) : (
          <button className="menu-item" disabled={!!active} onClick={() => setNaming('')}>
            <Plus />
            Save current view…
          </button>
        )}
        <p className="fl-empty">Views keep focus, search, filters and layout. Everyone on this sheet sees them.</p>
      </div>
    </details>
  );
}

/** "3 people · 2 projects · #urgent" */
const describe = (c: ViewConfig) => {
  const parts: string[] = [];
  const n = c.focus?.length ?? 0;
  if (n) parts.push(n === 1 ? '1 person' : `${n} people`);
  const p = c.projects?.length ?? 0;
  if (p) parts.push(p === 1 ? (store.getCell('projects', c.projects![0]!, 'name') as string) || 'No project' : `${p} projects`);
  if (c.tags?.length) parts.push(c.tags.map((t) => `#${t}`).join(' '));
  if (c.query) parts.push(`“${c.query}”`);
  if (c.hideWeekends) parts.push('workdays');
  return parts.join(' · ') || 'Everyone';
};
