// Projects and clients, as pages of the sheet (see lib/route.ts): lists with
// what's planned for each, and a page per project and per client with notes,
// people and work. "Open in plan" filters the timeline to them.

import { Suspense, lazy, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  PALETTE,
  createClient,
  createProject,
  deleteClient,
  deleteProject,
  getUser,
  isReadOnly,
  recolorProject,
  setProjectClient,
  store,
  updateClient,
  updateProject,
  type TaskRow,
} from '../data/store.ts';
import { formatDay, formatRange, today, workdays } from '../lib/dates.ts';
import { navigate, routePath, type Route } from '../lib/route.ts';
import { SectionTabs } from './Toolbar.tsx';
import type { Client, Project, ProjectStats, TimelineModel } from './model.ts';
import { Archive, Check, ChevronDown, Plus, Search as SearchIc, Trash } from '../ui/icons.tsx';

const RichNotes = lazy(() => import('./RichNotes.tsx'));

interface Props {
  model: TimelineModel;
  route: Route;
  /** Show the plan filtered to these projects. */
  onOpenInPlan(projectIds: string[]): void;
  onOpenTask(id: string): void;
}

const useVersion = (model: TimelineModel) => useSyncExternalStore(model.subscribe, () => model.version);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
const dates = (s?: ProjectStats) => (s && s.tasks ? formatRange(s.first, s.last) : '—');

/** An in-app link (real href, so it opens in a new tab with ⌘-click). */
function Go({ to, className, children }: { to: Route; className?: string; children: ReactNode }) {
  return (
    <a
      href={routePath(to)}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function Faces({ ids, max = 4 }: { ids: Iterable<string>; max?: number }) {
  const people = [...ids].map((id) => getUser(id)).filter((u) => !!u);
  return (
    <span className="faces" title={people.map((u) => u.name).join(', ')}>
      {people.slice(0, max).map((u) => (
        <span key={u.name + u.color} className="avatar" style={{ ['--c' as string]: u.color }}>
          {initials(u.name)}
        </span>
      ))}
      {people.length > max && <span className="faces-more">+{people.length - max}</span>}
    </span>
  );
}

function Swatches({ value, onPick }: { value: string; onPick(c: string): void }) {
  return (
    <div className="swatches">
      {PALETTE.map((c) => (
        <button key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={c === value} onClick={() => onPick(c)}>
          {c === value && <Check size={13} />}
        </button>
      ))}
    </div>
  );
}

/** Text that saves on blur / Enter. */
function Field({ value, onSave, className, placeholder, list, label }: { value: string; onSave(v: string): void; className?: string; placeholder?: string; list?: string; label: string }) {
  return (
    <input
      key={value}
      className={className}
      defaultValue={value}
      placeholder={placeholder}
      list={list}
      aria-label={label}
      readOnly={isReadOnly()}
      onBlur={(e) => e.currentTarget.value.trim() !== value && onSave(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function ClientList({ model }: { model: TimelineModel }) {
  return (
    <datalist id="page-clients">
      {model.clients
        .filter((c) => !c.archived)
        .map((c) => (
          <option key={c.id} value={c.name} />
        ))}
    </datalist>
  );
}

function Stat({ label, value, small }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <span className={'stat-value' + (small ? ' small' : '')}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Notes({ value, onSave }: { value: string; onSave(md: string): void }) {
  return (
    <section className="page-card">
      <h2 className="page-h2">Notes</h2>
      <Suspense fallback={<div className="rich-notes loading">{value || 'Notes'}</div>}>
        <RichNotes value={value} readOnly={isReadOnly()} placeholder="Briefing, contacts, links…" onSave={onSave} />
      </Suspense>
    </section>
  );
}

// --- Project table (projects page, client page) -----------------------------------------

type SortKey = 'name' | 'client' | 'tasks' | 'days' | 'upcoming' | 'last';

function ProjectTable({ projects, stats, showClient = true }: { projects: Project[]; stats: Map<string, ProjectStats>; showClient?: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: showClient ? 'client' : 'name', dir: 1 });
  const val = (p: Project): string | number => {
    const s = stats.get(p.id);
    switch (sort.key) {
      case 'name':
        return p.name.toLowerCase();
      case 'client':
        return (p.client || '￿').toLowerCase() + '\u0000' + p.name.toLowerCase();
      case 'tasks':
        return s?.tasks ?? 0;
      case 'days':
        return s?.days ?? 0;
      case 'upcoming':
        return s?.upcoming ?? 0;
      case 'last':
        return s?.tasks ? s.last : -Infinity;
    }
  };
  const rows = [...projects].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const th = (key: SortKey, label: string, cls = '') => (
    <th className={cls}>
      <button
        className={'th-sort' + (sort.key === key ? ' on' : '')}
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === 'name' || key === 'client' ? 1 : -1 }))}
      >
        {label}
        {sort.key === key && (
          <span className={'th-arrow' + (sort.dir === 1 ? '' : ' flip')}>
            <ChevronDown size={12} />
          </span>
        )}
      </button>
    </th>
  );
  if (!rows.length) return null;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {th('name', 'Project')}
            {showClient && th('client', 'Client', 'hide-sm')}
            {th('tasks', 'Tasks', 'num')}
            {th('days', 'Planned', 'num hide-sm')}
            {th('upcoming', 'Upcoming', 'num hide-sm')}
            {th('last', 'Dates', 'hide-sm')}
            <th className="hide-sm">People</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const s = stats.get(p.id);
            return (
              <tr key={p.id} className={p.archived ? 'archived' : ''} onClick={() => navigate({ section: 'projects', id: p.id })}>
                <td>
                  <Go to={{ section: 'projects', id: p.id }} className="cell-name">
                    <span className="dot" style={{ background: p.color }} />
                    {p.name}
                    {p.archived && <span className="badge">Archived</span>}
                  </Go>
                </td>
                {showClient && (
                  <td className="hide-sm">
                    {p.clientId && p.client ? (
                      <Go to={{ section: 'clients', id: p.clientId }} className="cell-link">
                        {p.client}
                      </Go>
                    ) : (
                      <span className="dim">{p.client || '—'}</span>
                    )}
                  </td>
                )}
                <td className="num">{s?.tasks ?? 0}</td>
                <td className="num hide-sm">{s?.days ? `${s.days}d` : '—'}</td>
                <td className="num hide-sm">{s?.upcoming || '—'}</td>
                <td className="hide-sm nowrap">{dates(s)}</td>
                <td className="hide-sm">{s && <Faces ids={s.people} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Projects ----------------------------------------------------------------------------

function ProjectsPage({ model }: { model: TimelineModel }) {
  const v = useVersion(model);
  const stats = useMemo(() => model.projectStats(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const q = query.trim().toLowerCase();
  const list = model.projects.filter((p) => (archived || !p.archived) && (!q || p.name.toLowerCase().includes(q) || p.client.toLowerCase().includes(q)));
  const archivedCount = model.projects.filter((p) => p.archived).length;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="page-sub">
            {plural(model.projects.length - archivedCount, 'active project')}
            {archivedCount > 0 && ` · ${archivedCount} archived`}
          </p>
        </div>
        <label className="page-search">
          <SearchIc />
          <input placeholder="Find a project or client" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        </label>
      </header>
      {!isReadOnly() && (
        <form
          className="page-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            createProject({ name: name.trim(), client: client.trim() });
            setName('');
          }}
        >
          <input placeholder="New project" value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="New project name" />
          <input placeholder="Client (optional)" list="page-clients" value={client} onChange={(e) => setClient(e.currentTarget.value)} aria-label="Client" />
          <button className="btn primary" disabled={!name.trim()}>
            <Plus />
            Add project
          </button>
          <ClientList model={model} />
        </form>
      )}
      {list.length ? (
        <ProjectTable projects={list} stats={stats} />
      ) : (
        <p className="page-empty">
          {q ? 'No projects match.' : 'No projects yet. Projects group work across people; give tasks a project from the task panel, or add one here.'}
        </p>
      )}
      {archivedCount > 0 && (
        <button className="link-btn page-more" onClick={() => setArchived((a) => !a)}>
          {archived ? 'Hide archived projects' : `Show ${plural(archivedCount, 'archived project')}`}
        </button>
      )}
    </>
  );
}

function WorkList({ tasks, onOpenTask }: { tasks: (TaskRow & { id: string })[]; onOpenTask(id: string): void }) {
  const [past, setPast] = useState(false);
  const now = today();
  const upcoming = tasks.filter((t) => t.end >= now).sort((a, b) => a.start - b.start);
  const earlier = tasks.filter((t) => t.end < now).sort((a, b) => b.start - a.start);
  const row = (t: TaskRow & { id: string }) => {
    const u = getUser(t.userId);
    const days = workdays(t.start, t.end) || t.end - t.start + 1;
    return (
      <li key={t.id}>
        <button className={'work-row' + (t.done ? ' done' : '')} onClick={() => onOpenTask(t.id)}>
          <span className="work-date">{t.start === t.end ? formatDay(t.start) : formatRange(t.start, t.end)}</span>
          <span className="work-title">
            {t.done && <Check size={12} />}
            {t.title || 'Untitled'}
          </span>
          <span className="work-who">
            {u && (
              <span className="avatar" style={{ ['--c' as string]: u.color }}>
                {initials(u.name)}
              </span>
            )}
            <span className="hide-sm">{u?.name ?? '—'}</span>
          </span>
          <span className="work-days">{days}d</span>
        </button>
      </li>
    );
  };
  return (
    <section className="page-card">
      <h2 className="page-h2">Upcoming work</h2>
      {upcoming.length ? <ul className="work-list">{upcoming.slice(0, 200).map(row)}</ul> : <p className="page-empty small">Nothing planned from today on.</p>}
      {earlier.length > 0 && (
        <>
          <button className="link-btn page-more" onClick={() => setPast((p) => !p)}>
            {past ? 'Hide earlier work' : `Show ${plural(earlier.length, 'earlier task')}`}
          </button>
          {past && <ul className="work-list past">{earlier.slice(0, 300).map(row)}</ul>}
        </>
      )}
    </section>
  );
}

function PeopleCard({ tasks }: { tasks: TaskRow[] }) {
  const now = today();
  const by = new Map<string, { days: number; upcoming: number }>();
  for (const t of tasks) {
    const e = by.get(t.userId) ?? { days: 0, upcoming: 0 };
    const d = workdays(t.start, t.end) || t.end - t.start + 1;
    e.days += d;
    if (t.end >= now) e.upcoming += d;
    by.set(t.userId, e);
  }
  const rows = [...by].map(([id, e]) => ({ id, u: getUser(id), ...e })).filter((r) => r.u).sort((a, b) => b.upcoming - a.upcoming || b.days - a.days);
  if (!rows.length) return null;
  return (
    <section className="page-card">
      <h2 className="page-h2">People</h2>
      <ul className="people-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="avatar" style={{ ['--c' as string]: r.u!.color }}>
              {initials(r.u!.name)}
            </span>
            <span className="people-name">{r.u!.name}</span>
            <span className="dim">{r.upcoming ? `${r.upcoming}d ahead · ` : ''}{r.days}d total</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const tasksOf = (projectIds: Set<string>) =>
  store
    .getRowIds('tasks')
    .map((id) => ({ id, ...(store.getRow('tasks', id) as TaskRow) }))
    .filter((t) => projectIds.has(t.projectId ?? ''));

function ProjectPage({ model, id, onOpenInPlan, onOpenTask }: { model: TimelineModel; id: string } & Pick<Props, 'onOpenInPlan' | 'onOpenTask'>) {
  const v = useVersion(model);
  const p = model.getProject(id);
  const stats = useMemo(() => model.projectStats(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => tasksOf(new Set([id])), [v, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Missing what="project" back={{ section: 'projects' }} />;
  const s = stats.get(id);
  const ro = isReadOnly();
  return (
    <>
      <nav className="crumbs">
        <Go to={{ section: 'projects' }}>Projects</Go>
        {p.clientId && p.client && (
          <>
            <span>/</span>
            <Go to={{ section: 'clients', id: p.clientId }}>{p.client}</Go>
          </>
        )}
      </nav>
      <header className="page-head">
        <div className="page-title">
          <span className="dot big" style={{ background: p.color }} />
          <Field className="title-input" value={p.name} label="Project name" onSave={(v) => v && updateProject(id, { name: v }, 'Rename project')} />
          {p.archived && <span className="badge">Archived</span>}
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => onOpenInPlan([id])}>
            Open in plan
          </button>
        </div>
      </header>
      <div className="stats">
        <Stat label="tasks" value={s?.tasks ?? 0} />
        <Stat label="planned" value={`${s?.days ?? 0}d`} />
        <Stat label="upcoming" value={s?.upcoming ?? 0} />
        <Stat label={s?.people.size === 1 ? 'person' : 'people'} value={s?.people.size ?? 0} />
        <Stat label="dates" value={dates(s)} small />
      </div>
      <div className="page-grid">
        <div className="page-main">
          <Notes value={p.notes ?? ''} onSave={(md) => updateProject(id, { notes: md }, 'Edit project notes')} />
          <WorkList tasks={tasks} onOpenTask={onOpenTask} />
        </div>
        <aside className="page-side">
          <section className="page-card">
            <h2 className="page-h2">Details</h2>
            <label className="page-field">
              <span>Client</span>
              <Field value={p.client} label="Client" placeholder="No client" list="page-clients" onSave={(v) => setProjectClient(id, v)} />
            </label>
            <ClientList model={model} />
            {!ro && (
              <>
                <div className="page-field">
                  <span>Color</span>
                  <Swatches value={p.color} onPick={(c) => recolorProject(id, c)} />
                </div>
                <div className="page-buttons">
                  <button className="btn" onClick={() => updateProject(id, { archived: !p.archived }, p.archived ? 'Restore project' : 'Archive project')}>
                    <Archive size={14} />
                    {p.archived ? 'Restore' : 'Archive'}
                  </button>
                  <button
                    className="btn danger ghost"
                    onClick={() => {
                      if (s?.tasks && !confirm(`Delete “${p.name}”? Its ${plural(s.tasks, 'task')} are kept, without a project.`)) return;
                      deleteProject(id);
                      navigate({ section: 'projects' });
                    }}
                  >
                    <Trash size={14} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </section>
          <PeopleCard tasks={tasks} />
        </aside>
      </div>
    </>
  );
}

// --- Clients -----------------------------------------------------------------------------

interface ClientTotals {
  projects: number;
  tasks: number;
  days: number;
  upcoming: number;
  last: number;
  people: Set<string>;
}
const clientTotals = (model: TimelineModel, stats: Map<string, ProjectStats>) => {
  const out = new Map<string, ClientTotals>();
  for (const p of model.projects) {
    if (!p.clientId) continue;
    const t = out.get(p.clientId) ?? { projects: 0, tasks: 0, days: 0, upcoming: 0, last: -Infinity, people: new Set<string>() };
    if (!p.archived) t.projects++;
    const s = stats.get(p.id);
    if (s) {
      t.tasks += s.tasks;
      t.days += s.days;
      t.upcoming += s.upcoming;
      t.last = Math.max(t.last, s.last);
      for (const u of s.people) t.people.add(u);
    }
    out.set(p.clientId, t);
  }
  return out;
};

function ClientsPage({ model }: { model: TimelineModel }) {
  const v = useVersion(model);
  const totals = useMemo(() => clientTotals(model, model.projectStats()), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState('');
  const q = query.trim().toLowerCase();
  const list = model.clients.filter((c) => (archived || !c.archived) && (!q || c.name.toLowerCase().includes(q)));
  const archivedCount = model.clients.filter((c) => c.archived).length;
  const loose = model.projects.filter((p) => !p.clientId && !p.archived).length;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="page-sub">
            {plural(model.clients.length - archivedCount, 'client')}
            {loose > 0 && ` · ${plural(loose, 'project')} without a client`}
          </p>
        </div>
        <label className="page-search">
          <SearchIc />
          <input placeholder="Find a client" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        </label>
      </header>
      {!isReadOnly() && (
        <form
          className="page-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            createClient(name);
            setName('');
          }}
        >
          <input placeholder="New client" value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="New client name" />
          <button className="btn primary" disabled={!name.trim()}>
            <Plus />
            Add client
          </button>
        </form>
      )}
      {list.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Projects</th>
                <th className="num hide-sm">Tasks</th>
                <th className="num hide-sm">Planned</th>
                <th className="num hide-sm">Upcoming</th>
                <th className="hide-sm">Last planned</th>
                <th className="hide-sm">People</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const t = totals.get(c.id);
                return (
                  <tr key={c.id} className={c.archived ? 'archived' : ''} onClick={() => navigate({ section: 'clients', id: c.id })}>
                    <td>
                      <Go to={{ section: 'clients', id: c.id }} className="cell-name">
                        <span className="dot" style={{ background: c.color }} />
                        {c.name}
                        {c.archived && <span className="badge">Archived</span>}
                      </Go>
                    </td>
                    <td className="num">{t?.projects ?? 0}</td>
                    <td className="num hide-sm">{t?.tasks ?? 0}</td>
                    <td className="num hide-sm">{t?.days ? `${t.days}d` : '—'}</td>
                    <td className="num hide-sm">{t?.upcoming || '—'}</td>
                    <td className="hide-sm nowrap">{t && t.last > -Infinity ? formatDay(t.last) : '—'}</td>
                    <td className="hide-sm">{t && <Faces ids={t.people} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="page-empty">{q ? 'No clients match.' : 'No clients yet. Clients group projects; add one here or give a project a client.'}</p>
      )}
      {archivedCount > 0 && (
        <button className="link-btn page-more" onClick={() => setArchived((a) => !a)}>
          {archived ? 'Hide archived clients' : `Show ${plural(archivedCount, 'archived client')}`}
        </button>
      )}
    </>
  );
}

function ClientPage({ model, id, onOpenInPlan, onOpenTask }: { model: TimelineModel; id: string } & Pick<Props, 'onOpenInPlan' | 'onOpenTask'>) {
  const v = useVersion(model);
  const c: Client | undefined = model.getClient(id);
  const stats = useMemo(() => model.projectStats(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = model.projects.filter((p) => p.clientId === id);
  const ids = useMemo(() => new Set(projects.map((p) => p.id)), [v, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => tasksOf(ids), [ids]);
  const [name, setName] = useState('');
  if (!c) return <Missing what="client" back={{ section: 'clients' }} />;
  const t = clientTotals(model, stats).get(id);
  const ro = isReadOnly();
  const active = projects.filter((p) => !p.archived);
  return (
    <>
      <nav className="crumbs">
        <Go to={{ section: 'clients' }}>Clients</Go>
      </nav>
      <header className="page-head">
        <div className="page-title">
          <span className="dot big" style={{ background: c.color }} />
          <Field className="title-input" value={c.name} label="Client name" onSave={(v) => v && updateClient(id, { name: v }, 'Rename client')} />
          {c.archived && <span className="badge">Archived</span>}
        </div>
        <div className="page-actions">
          <button className="btn primary" disabled={!active.length} onClick={() => onOpenInPlan(active.map((p) => p.id))}>
            Open in plan
          </button>
        </div>
      </header>
      <div className="stats">
        <Stat label={active.length === 1 ? 'project' : 'projects'} value={active.length} />
        <Stat label="tasks" value={t?.tasks ?? 0} />
        <Stat label="planned" value={`${t?.days ?? 0}d`} />
        <Stat label="upcoming" value={t?.upcoming ?? 0} />
        <Stat label={t?.people.size === 1 ? 'person' : 'people'} value={t?.people.size ?? 0} />
      </div>
      <div className="page-grid">
        <div className="page-main">
          <section className="page-card flush">
            <h2 className="page-h2">Projects</h2>
            {projects.length ? <ProjectTable projects={projects} stats={stats} showClient={false} /> : <p className="page-empty small">No projects for this client yet.</p>}
            {!ro && (
              <form
                className="page-new inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  createProject({ name: name.trim(), client: c.name });
                  setName('');
                }}
              >
                <input placeholder={`New project for ${c.name}`} value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="New project name" />
                <button className="btn" disabled={!name.trim()}>
                  <Plus />
                  Add
                </button>
              </form>
            )}
          </section>
          <Notes value={c.notes ?? ''} onSave={(md) => updateClient(id, { notes: md }, 'Edit client notes')} />
          <WorkList tasks={tasks} onOpenTask={onOpenTask} />
        </div>
        <aside className="page-side">
          {!ro && (
            <section className="page-card">
              <h2 className="page-h2">Details</h2>
              <div className="page-field">
                <span>Color</span>
                <Swatches value={c.color} onPick={(col) => updateClient(id, { color: col }, 'Recolor client')} />
              </div>
              <div className="page-buttons">
                <button className="btn" onClick={() => updateClient(id, { archived: !c.archived }, c.archived ? 'Restore client' : 'Archive client')}>
                  <Archive size={14} />
                  {c.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  className="btn danger ghost"
                  onClick={() => {
                    if (projects.length && !confirm(`Delete “${c.name}”? Its ${plural(projects.length, 'project')} are kept, without a client.`)) return;
                    deleteClient(id);
                    navigate({ section: 'clients' });
                  }}
                >
                  <Trash size={14} />
                  Delete
                </button>
              </div>
            </section>
          )}
          <PeopleCard tasks={tasks} />
        </aside>
      </div>
    </>
  );
}

function Missing({ what, back }: { what: string; back: Route }) {
  return (
    <div className="page-empty">
      This {what} doesn’t exist (any more). <Go to={back}>Back to the list</Go>
    </div>
  );
}

export function Pages({ model, route, onOpenInPlan, onOpenTask }: Props) {
  return (
    <main className="page">
      <div className="page-inner">
        <div className="page-tabs">
          <SectionTabs current={route.section} />
        </div>
        {route.section === 'projects' &&
          (route.id ? <ProjectPage key={route.id} model={model} id={route.id} onOpenInPlan={onOpenInPlan} onOpenTask={onOpenTask} /> : <ProjectsPage model={model} />)}
        {route.section === 'clients' &&
          (route.id ? <ClientPage key={route.id} model={model} id={route.id} onOpenInPlan={onOpenInPlan} onOpenTask={onOpenTask} /> : <ClientsPage model={model} />)}
      </div>
    </main>
  );
}
