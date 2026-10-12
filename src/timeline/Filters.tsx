import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createView, deleteView, readView, store, updateView, type ViewConfig } from '../data/store.ts';
import { Check, Close, FilterIcon, Folder, Layers } from '../ui/icons.tsx';
import type { TimelineModel } from './model.ts';
import { byClient } from './Projects.tsx';

export interface FilterState {
  projects: string[]; // project ids; '' = tasks without a project
  tags: string[]; // lower-cased
}
export const NO_FILTER: FilterState = { projects: [], tags: [] };

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/**
 * Funnel menu: filter blocks by project (grouped by client) and by tag, and
 * the saved views (a filter, focus, search and layout kept under a name).
 * Views are a shortcut, not a place: they live here rather than on the
 * toolbar, and the button only names one while it's applied.
 */
export function FilterMenu({
  model,
  filter,
  onFilter,
  onManageProjects,
  view,
  onApplyView,
  readOnly,
}: {
  model: TimelineModel;
  filter: FilterState;
  onFilter(f: FilterState): void;
  onManageProjects(): void;
  /** The current state, to compare with the saved views and to save. */
  view: ViewConfig;
  onApplyView(c: ViewConfig): void;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const n = filter.projects.length + filter.tags.length;
  const version = useSyncExternalStore(subscribeViews, viewsSnapshot);
  const views = useMemo(
    () =>
      Object.entries(store.getTable('views'))
        .map(([id, r]) => ({ id, name: r.name as string, order: r.order as number, config: readView(id) }))
        .sort((a, b) => a.order - b.order),
    [version],
  );
  const active = views.find((v) => norm(v.config) === norm(view));
  // Search and layout alone aren't worth saving; focus and filters are.
  const savable = !active && !!(view.focus?.length || view.projects?.length || view.tags?.length);
  const [naming, setNaming] = useState<string | null>(null);
  const close = () => {
    ref.current?.removeAttribute('open');
    setNaming(null);
  };
  const counts = useMemo(() => (open ? model.projectCounts() : new Map<string, number>()), [open, model.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => (open ? model.allTags() : []), [open, model.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = model.projects.filter((p) => !p.archived || filter.projects.includes(p.id));
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const shownProjects = query ? projects.filter((p) => p.name.toLowerCase().includes(query) || p.client.toLowerCase().includes(query)) : projects;
  // Projects without tasks only add length: tucked away until asked for
  // (a search, or one that's picked, still shows them).
  const [showEmpty, setShowEmpty] = useState(false);
  const planned = showEmpty ? projects : projects.filter((p) => (counts.get(p.id) ?? 0) > 0 || filter.projects.includes(p.id));
  const empty = projects.length - planned.length;
  const shownTags = query ? tags.filter((t) => t.toLowerCase().includes(query)) : tags;

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
    <details
      className="tb-filter tb-dd"
      ref={ref}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) {
          setQ('');
          setNaming(null);
          setShowEmpty(false);
        }
      }}
    >
      <summary className={'btn icon' + (n || active ? ' active' : '')} aria-label={active ? `Filter: view ${active.name}` : 'Filter'} title="Filter by project or tag, or open a saved view">
        <FilterIcon />
        {active ? <span className="fl-view-name">{active.name}</span> : n > 0 && <span className="tb-badge">{n}</span>}
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
        {open && views.length > 0 && (
          <div className="fl-views">
            <div className="fl-client">Saved views</div>
            {views.map((v) => (
              <div key={v.id} className={'view-item' + (v === active ? ' on' : '')}>
                <button
                  className="tb-person"
                  aria-pressed={v === active}
                  // The applied view again goes back to everything.
                  onClick={() => {
                    onApplyView(v === active ? { focus: [], query: '', projects: [], tags: [] } : v.config);
                    close();
                  }}
                >
                  <Layers size={14} />
                  <span className="fl-label">{v.name}</span>
                  <span className="fl-count">{describe(v.config)}</span>
                  {v === active && (
                    <span className="tb-check">
                      <Check size={14} />
                    </span>
                  )}
                </button>
                {!readOnly && (
                  <button
                    className="view-del"
                    aria-label={`Delete view ${v.name}`}
                    title="Delete view"
                    onClick={() => confirm(`Delete the view “${v.name}”?`) && deleteView(v.id)}
                  >
                    <Close size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {open && (
          <>
            <input
              className="fl-search"
              autoFocus
              placeholder="Find a project, client or tag…"
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))}
            />
            <div className="fl-scroll">
              {shownTags.length > 0 && <div className="fl-section">Tags</div>}
              {shownTags.length > 0 && (
                <div className="fl-tags">
                  {shownTags.map((t) => {
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
              {(!query || shownProjects.length > 0) && <div className="fl-section">Projects</div>}
              {projects.length === 0 && <p className="fl-empty">No projects yet.</p>}
              {query
                ? shownProjects.map((p) => <Item key={p.id} id={p.id} label={p.name} color={p.color} sub={p.client || String(counts.get(p.id) ?? 0)} />)
                : byClient(planned).map(([client, ps]) => (
                    <div key={client || '-'} className="fl-group">
                      {client && <div className="fl-client">{client}</div>}
                      {ps.map((p) => (
                        <Item key={p.id} id={p.id} label={p.name} color={p.color} sub={String(counts.get(p.id) ?? 0)} />
                      ))}
                    </div>
                  ))}
              {!query && projects.length > 0 && <Item id="" label="No project" sub={String(counts.get('') ?? 0)} />}
              {!query && empty > 0 && (
                <button className="fl-more" onClick={() => setShowEmpty(true)}>
                  Show {empty === 1 ? '1 project' : `${empty} projects`} without tasks
                </button>
              )}
              {query && !shownProjects.length && !shownTags.length && <p className="fl-empty">Nothing matches “{q.trim()}”.</p>}
            </div>
            {!readOnly &&
              (naming !== null ? (
                <form
                  className="view-save fl-save"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = naming.trim();
                    if (!name) return;
                    const same = views.find((v) => v.name.toLowerCase() === name.toLowerCase());
                    if (same) updateView(same.id, { config: view });
                    else createView(name, view);
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
                  <p className="fl-empty">Keeps who’s in focus, the search, filters and layout, for everyone on this sheet.</p>
                </form>
              ) : (
                savable && (
                  <button className="fl-foot" onClick={() => setNaming('')}>
                    <Layers />
                    Save as a view…
                  </button>
                )
              ))}
            <button
              className="fl-foot"
              onClick={() => {
                ref.current?.removeAttribute('open');
                onManageProjects();
              }}
            >
              <Folder />
              Manage projects
            </button>
          </>
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
