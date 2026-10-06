import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PALETTE,
  createProject,
  deleteProject,
  joinTags,
  recolorProject,
  updateProject,
  updateTask,
} from '../data/store.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Check, ChevronDown, Close, Folder, Plus, Tag, Trash } from '../ui/icons.tsx';
import type { Project, TaskView, TimelineModel } from './model.ts';

/** Projects grouped under their client ('' = no client), in order. */
export const byClient = (projects: Project[]): [string, Project[]][] => {
  const groups = new Map<string, Project[]>();
  for (const p of projects) {
    const g = groups.get(p.client);
    if (g) g.push(p);
    else groups.set(p.client, [p]);
  }
  // Projects without a client go last.
  return [...groups].sort((a, b) => (a[0] === '') !== (b[0] === '') ? (a[0] === '' ? 1 : -1) : a[0].localeCompare(b[0]));
};

// --- Editor: project ---------------------------------------------------------

/**
 * The task's project as a chip; opens an inline searchable list. Picking a
 * project also gives the task the project's color, like Teamweek.
 */
export function ProjectField({ task, model }: { task: TaskView; model: TimelineModel }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const project = model.getProject(task.projectId);
  const query = q.trim().toLowerCase();
  const options = useMemo(
    () =>
      model.projects.filter(
        (p) => !p.archived && (!query || p.name.toLowerCase().includes(query) || p.client.toLowerCase().includes(query)),
      ),
    [model.projects, query],
  );
  const exact = options.some((p) => p.name.toLowerCase() === query);
  // Rows: [none] + options + [create]
  const rows: ({ kind: 'none' } | { kind: 'project'; p: Project } | { kind: 'create' })[] = [
    ...(query ? [] : [{ kind: 'none' as const }]),
    ...options.map((p) => ({ kind: 'project' as const, p })),
    ...(query && !exact ? [{ kind: 'create' as const }] : []),
  ];

  const pick = (row: (typeof rows)[number]) => {
    if (row.kind === 'none') updateTask(task.id, { projectId: '' }, 'Remove from project');
    else if (row.kind === 'project') updateTask(task.id, { projectId: row.p.id, color: row.p.color }, 'Set project');
    else {
      const id = createProject({ name: q.trim(), color: task.color });
      updateTask(task.id, { projectId: id }, 'Set project');
    }
    setOpen(false);
    setQ('');
  };

  const chip = (
    <button className={'field-chip' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)} title="Project" aria-expanded={open}>
      <Folder size={14} />
      {project ? (
        <>
          <span className="dot" style={{ background: project.color }} />
          <span className="field-chip-text">
            {project.name}
            {project.client && <span className="dim"> · {project.client}</span>}
          </span>
        </>
      ) : (
        <span className="field-chip-text dim">No project</span>
      )}
      <ChevronDown size={14} />
    </button>
  );
  if (!open) return chip;
  // A popover over the panel, not an inline list that pushes everything down.
  return (
    <div className="field-pop">
      {chip}
      <div className="combo pop">
        <input
          autoFocus
          className="combo-input"
          placeholder="Find or create a project…"
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = rows[hi];
              if (row) pick(row);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              setQ('');
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.closest('.field-pop')?.contains(e.relatedTarget as Node)) {
              setOpen(false);
              setQ('');
            }
          }}
        />
        <div className="combo-list" role="listbox">
          {rows.map((row, i) => {
            const on = row.kind === 'project' ? row.p.id === task.projectId : row.kind === 'none' && !task.projectId;
            return (
              <button
                key={row.kind === 'project' ? row.p.id : row.kind}
                className={'combo-item' + (i === hi ? ' hi' : '')}
                role="option"
                aria-selected={on}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(row)}
              >
                {row.kind === 'none' && <span className="dim">No project</span>}
                {row.kind === 'project' && (
                  <>
                    <span className="dot" style={{ background: row.p.color }} />
                    <span className="combo-text">{row.p.name}</span>
                    {row.p.client && <span className="combo-sub">{row.p.client}</span>}
                  </>
                )}
                {row.kind === 'create' && (
                  <>
                    <Plus />
                    <span className="combo-text">
                      Create <b>{q.trim()}</b>
                    </span>
                  </>
                )}
                {on && (
                  <span className="tb-check">
                    <Check size={14} />
                  </span>
                )}
              </button>
            );
          })}
          {rows.length === 0 && <div className="combo-empty">No projects</div>}
        </div>
      </div>
    </div>
  );
}

// --- Editor: tags -------------------------------------------------------------

export function TagField({ task, model }: { task: TaskView; model: TimelineModel }) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (tags: string[], label: string) => updateTask(task.id, { tags: joinTags(tags) }, label);
  const add = (raw: string) => {
    const v = raw.replace(/^#/, '').trim();
    if (v) set([...task.tags, v], 'Tag task');
    setDraft('');
  };
  const have = new Set(task.tags.map((t) => t.toLowerCase()));
  const d = draft.replace(/^#/, '').trim().toLowerCase();
  const suggestions = focused
    ? model
        .allTags()
        .filter((t) => !have.has(t.toLowerCase()) && (!d || t.toLowerCase().includes(d)))
        .slice(0, 6)
    : [];

  return (
    <div className="tags-field" onClick={() => input.current?.focus()}>
      <Tag size={14} />
      {task.tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          <button
            aria-label={`Remove ${t}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              set(
                task.tags.filter((x) => x !== t),
                'Untag task',
              );
            }}
          >
            <Close size={11} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        className="tags-input"
        placeholder={task.tags.length ? '' : 'Add tags'}
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (draft.trim()) add(draft);
        }}
        onChange={(e) => {
          const v = e.currentTarget.value;
          // Typing a comma commits the tag before it.
          if (v.includes(',')) {
            const parts = v.split(',');
            const last = parts.pop()!;
            const next = [...task.tags, ...parts.map((p) => p.trim()).filter(Boolean)];
            set(next, 'Tag task');
            setDraft(last);
          } else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            e.stopPropagation();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && task.tags.length) {
            set(task.tags.slice(0, -1), 'Untag task');
          }
        }}
      />
      {suggestions.length > 0 && (
        <div className="tag-suggest">
          {suggestions.map((t) => (
            <button key={t} className="tag-chip ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)}>
              + {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Manage projects ----------------------------------------------------------

export function ProjectsDialog({ model, onClose }: { model: TimelineModel; onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const counts = useMemo(() => model.projectCounts(), [model.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const clients = [...new Set(model.projects.map((p) => p.client).filter(Boolean))].sort();
  const active = model.projects.filter((p) => !p.archived);
  const archived = model.projects.filter((p) => p.archived);
  const add = () => {
    if (!name.trim()) return;
    createProject({ name: name.trim(), client: client.trim() });
    setName('');
  };

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal projects" role="dialog" aria-label="Projects">
        <header className="modal-head">
          <h2>Projects</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <form
          className="proj-new"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input autoFocus placeholder="New project name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <input placeholder="Client (optional)" list="proj-clients" value={client} onChange={(e) => setClient(e.currentTarget.value)} />
          <button className="btn primary" disabled={!name.trim()}>
            <Plus />
            Add
          </button>
        </form>
        <datalist id="proj-clients">
          {clients.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="proj-list">
          {active.length === 0 && (
            <p className="proj-empty">
              No projects yet. Projects group work across people (and clients group projects). Give tasks a project from the task
              editor, then filter the timeline by it.
            </p>
          )}
          {byClient(active).map(([c, ps]) => (
            <section key={c || '-'}>
              <h3 className="proj-client">{c || 'No client'}</h3>
              {ps.map((p) => (
                <ProjectRowEdit key={p.id} p={p} count={counts.get(p.id) ?? 0} />
              ))}
            </section>
          ))}
          {archived.length > 0 && (
            <section>
              <button className="proj-archived-toggle" onClick={() => setShowArchived((s) => !s)}>
                <ChevronDown size={14} />
                Archived ({archived.length})
              </button>
              {showArchived && archived.map((p) => <ProjectRowEdit key={p.id} p={p} count={counts.get(p.id) ?? 0} />)}
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProjectRowEdit({ p, count }: { p: Project; count: number }) {
  const [colors, setColors] = useState(false);
  const save = (field: 'name' | 'client', v: string) => {
    v = v.trim();
    if (field === 'name' && !v) return;
    if (v !== p[field]) updateProject(p.id, { [field]: v }, field === 'name' ? 'Rename project' : 'Set client');
  };
  return (
    <div className={'proj-row' + (p.archived ? ' archived' : '')}>
      <div className="proj-color">
        <button
          className="proj-swatch"
          style={{ background: p.color }}
          aria-label="Project color"
          onClick={() => setColors((c) => !c)}
        />
        {colors && (
          <div className="proj-palette" onMouseLeave={() => setColors(false)}>
            {PALETTE.map((c) => (
              <button
                key={c}
                className={'swatch' + (c === p.color ? ' on' : '')}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => {
                  recolorProject(p.id, c);
                  setColors(false);
                }}
              >
                {c === p.color && <Check size={13} />}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        className="proj-name"
        defaultValue={p.name}
        key={`n${p.name}`}
        aria-label="Project name"
        onBlur={(e) => save('name', e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <input
        className="proj-clientin"
        defaultValue={p.client}
        key={`c${p.client}`}
        placeholder="Client"
        list="proj-clients"
        aria-label="Client"
        onBlur={(e) => save('client', e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span className="proj-count">{count === 1 ? '1 task' : `${count} tasks`}</span>
      <button className="btn small" onClick={() => updateProject(p.id, { archived: !p.archived }, p.archived ? 'Restore project' : 'Archive project')}>
        {p.archived ? 'Restore' : 'Archive'}
      </button>
      <button
        className="tb-search-btn"
        aria-label={`Delete ${p.name}`}
        title="Delete project (tasks are kept)"
        onClick={() => (count === 0 || confirm(`Delete “${p.name}”? Its ${count} tasks are kept, without a project.`)) && deleteProject(p.id)}
      >
        <Trash />
      </button>
    </div>
  );
}
