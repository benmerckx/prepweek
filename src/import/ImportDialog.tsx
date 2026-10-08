import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseCsv } from './csv.ts';
import { buildPlan, detectDateOrder, FIELD_LABELS, guessMapping, type DateOrder, type Field, type Mapping } from './teamweek.ts';
import { getSheetId } from '../data/access.ts';
import { peopleLimit } from '../data/plan.ts';
import { applyImport, getUser, store, type ImportMode } from '../data/store.ts';
import { personKey } from '../lib/plans.ts';
import { formatDay, formatRange } from '../lib/dates.ts';
import { useBackToClose } from '../lib/useBackToClose.ts';
import { Close, Upload } from '../ui/icons.tsx';
import { Select } from '../ui/Select.tsx';

interface Props {
  /** A file dropped on the app opens the dialog with it preloaded. */
  initialFile?: File | null;
  onClose(): void;
  onImported(range: [number, number] | null): void;
}

interface Loaded {
  name: string;
  header: string[];
  rows: string[][];
}

const SHOWN_FIELDS: Field[] = ['title', 'assignee', 'email', 'start', 'end', 'startTime', 'endTime', 'project', 'client', 'status', 'notes', 'tags', 'segment', 'attachments', 'repeats', 'color', 'estimate', 'taskId'];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

export function ImportDialog({ initialFile, onClose: close, onImported }: Props) {
  /** Reading and parsing the file. */
  const [reading, setReading] = useState(false);
  /** Writing the import: 0..1, null when not importing. */
  const [progress, setProgress] = useState<number | null>(null);
  // Can't be closed halfway through writing.
  const onClose = () => progress === null && close();
  useBackToClose(true, onClose);
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [ambiguous, setAmbiguous] = useState(false);
  // Done tasks are kept (shown as done): they're the history of the plan.
  const [includeDone, setIncludeDone] = useState(true);
  const [keepRepeats, setKeepRepeats] = useState(true);
  const [unassigned, setUnassigned] = useState<'skip' | 'row'>('skip');
  const [mode, setMode] = useState<ImportMode>('add');
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const load = async (f: File) => {
    setError('');
    setReading(true);
    try {
      const text = await f.text();
      await nextFrame(); // show "Reading…" before parsing a big file
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('That file has no data rows.');
      const [header, ...data] = rows;
      const m = guessMapping(header!);
      if (m.start === undefined && m.end === undefined) {
        throw new Error('Couldn’t find a date column. Is this a Teamweek / Toggl Plan task export?');
      }
      const dates = data.slice(0, 500).flatMap((r) => [r[m.start ?? -1] ?? '', r[m.end ?? -1] ?? '']);
      const d = detectDateOrder(dates);
      setFile({ name: f.name, header: header!, rows: data });
      setMapping(m);
      setDateOrder(d.order);
      setAmbiguous(d.ambiguous);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  if (initialFile && !started.current) {
    started.current = true;
    void load(initialFile);
  }

  const current = useMemo(
    () => ({
      people: store.getRowIds('users').map((id) => ({ id, name: getUser(id)!.name, email: getUser(id)!.email })),
      tasks: store.getRowCount('tasks'),
    }),
    [],
  );
  // Replacing starts from an empty sheet, so nobody "matches".
  /** "—" (not in the file) or one of its columns. */
  const columnOptions = useMemo(
    () => [{ value: '-1', label: '—' }, ...(file?.header ?? []).map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))],
    [file],
  );
  // A column of hours ("Estimated hours") rather than Teamweek's minutes.
  const estimateUnit = /hour|uur|stund|heure/i.test(file?.header[mapping.estimate ?? -1] ?? '') ? 'h' : 'min';
  const full = useMemo(
    () => (file ? buildPlan(file.rows, { mapping, dateOrder, includeDone, keepRepeats, unassigned, estimateUnit }, mode === 'add' ? current.people : []) : null),
    [file, mapping, dateOrder, includeDone, keepRepeats, unassigned, estimateUnit, mode, current],
  );
  // The plan's people limit: past it, only the people with the most tasks
  // come in (the server would remove the rest anyway).
  const limit = useMemo(peopleLimit, []);
  const { plan, left } = useMemo(() => {
    if (!full || !limit.enforced) return { plan: full, left: null };
    const sheet = getSheetId();
    const here = new Set(current.people.map((p) => personKey(sheet, p.id, p)));
    const room = Math.max(0, limit.limit - (limit.used - (mode === 'replace' ? here.size : 0)));
    const fresh = full.people.filter((p) => !p.existingId).sort((a, b) => b.tasks - a.tasks);
    if (fresh.length <= room) return { plan: full, left: null };
    const out = new Set(fresh.slice(room).map((p) => p.key));
    const tasks = full.tasks.filter((t) => !out.has(t.personKey));
    return {
      plan: { ...full, people: full.people.filter((p) => !out.has(p.key)), tasks },
      left: { room, people: out.size, tasks: full.tasks.length - tasks.length },
    };
  }, [full, limit, mode, current]);

  const newPeople = plan?.people.filter((p) => !p.existingId) ?? [];
  const matched = plan?.people.filter((p) => p.existingId) ?? [];
  const sample = plan?.tasks.slice(0, 6) ?? [];
  const nameOf = (key: string) => plan?.people.find((p) => p.key === key)?.name ?? '';
  const sheetEmpty = current.people.length === 0 && current.tasks === 0;

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import" role="dialog" aria-label="Import from Teamweek">
        <header className="modal-head">
          <h2>Import from Teamweek / Toggl Plan</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>

        {!file ? (
          <div className="sources single">
            <div
              className={'dropzone' + (dragOver ? ' over' : '')}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) void load(f);
              }}
            >
              <span className="source-logo" aria-hidden>
                <Upload />
              </span>
              <p className="dz-title">{reading ? 'Reading your file…' : 'Drop your CSV export here'}</p>
              <button className="btn primary big" disabled={reading} onClick={() => input.current?.click()}>
                {reading ? <span className="spinner" aria-hidden /> : null}
                {reading ? 'Reading…' : 'Choose CSV file'}
              </button>
              <input
                ref={input}
                type="file"
                accept=".csv,text/csv,text/plain"
                hidden
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) void load(f);
                }}
              />
              {error && <p className="import-error">{error}</p>}
            </div>
            <ol className="dz-help">
              <li>
                In Toggl Plan (formerly Teamweek), open the <b>Team</b> or <b>Plan</b> view.
              </li>
              <li>
                Open the <b>⋯</b> menu at the top right, choose <b>Export tasks</b>, then pick the workspace (or a team or project) and the dates.
              </li>
              <li>Drop the downloaded .csv here. Exporting needs an Owner or Admin account.</li>
            </ol>
          </div>
        ) : (
          <div className="import-body">
            <div className="import-file">
              <b>{file.name}</b> · {plural(file.rows.length, 'row')}
              <button className="linkbtn" onClick={() => setFile(null)}>
                Choose another
              </button>
            </div>

            {!sheetEmpty && (
              <section>
                <h3>What should happen to this sheet?</h3>
                <div className="choice" role="radiogroup" aria-label="Import mode">
                  <button role="radio" aria-checked={mode === 'add'} className={'choice-card' + (mode === 'add' ? ' on' : '')} onClick={() => setMode('add')}>
                    <span className="choice-title">Add to sheet</span>
                    <span className="choice-sub">
                      Keep everything. People are matched by email or name. Tasks from an earlier import of this export are updated, not duplicated.
                    </span>
                  </button>
                  <button
                    role="radio"
                    aria-checked={mode === 'replace'}
                    className={'choice-card danger' + (mode === 'replace' ? ' on' : '')}
                    onClick={() => setMode('replace')}
                  >
                    <span className="choice-title">Replace sheet</span>
                    <span className="choice-sub">
                      Remove the current {plural(current.people.length, 'person', 'people')} and {plural(current.tasks, 'task')} first. Milestones stay.
                    </span>
                  </button>
                </div>
              </section>
            )}

            <details className="columns" open={ambiguous || mapping.title === undefined || mapping.assignee === undefined}>
              <summary>
                <h3>Columns</h3>
              </summary>
              <div className="mapping">
                {SHOWN_FIELDS.map((f) => (
                  <label key={f} className={(f === 'start' || f === 'assignee' || f === 'title') && mapping[f] === undefined ? 'missing' : ''}>
                    <span>{FIELD_LABELS[f]}</span>
                    <Select
                      label={FIELD_LABELS[f]}
                      value={String(mapping[f] ?? -1)}
                      options={columnOptions}
                      onChange={(v) => {
                        const n = Number(v);
                        setMapping((m) => ({ ...m, [f]: n < 0 ? undefined : n }));
                      }}
                    />
                  </label>
                ))}
              </div>
            </details>

            <section className="import-options">
              <label className={ambiguous ? 'warn' : ''}>
                <span>Dates are</span>
                <Select
                  label="Date order"
                  value={dateOrder}
                  options={[
                    { value: 'dmy', label: 'day / month / year' },
                    { value: 'mdy', label: 'month / day / year' },
                  ]}
                  onChange={(v) => setDateOrder(v as DateOrder)}
                />
                {ambiguous && <em>Can’t tell from the file, please check</em>}
              </label>
              <label>
                <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.currentTarget.checked)} />
                Include completed tasks (marked done)
              </label>
              {mapping.repeats !== undefined && (
                <label title="The export doesn’t say when a series ends: one ends where a newer series of the same task starts, or, when older than six months, where the task was last planned.">
                  <input type="checkbox" checked={keepRepeats} onChange={(e) => setKeepRepeats(e.currentTarget.checked)} />
                  Keep repeating tasks repeating
                </label>
              )}
              <label>
                <span>Tasks without assignee</span>
                <Select
                  label="Tasks without assignee"
                  value={unassigned}
                  options={[
                    { value: 'skip', label: 'Skip' },
                    { value: 'row', label: 'Put on an “Unassigned” row' },
                  ]}
                  onChange={(v) => setUnassigned(v as 'skip' | 'row')}
                />
              </label>
            </section>

            {plan && (
              <section className="import-summary">
                <h3>
                  {plural(plan.tasks.length, 'task')} for {plural(plan.people.length, 'person', 'people')}
                  {plan.range && <span className="dim"> · {formatRange(plan.range[0], plan.range[1])}</span>}
                </h3>
                {(plan.skipped.noDate > 0 || plan.skipped.unassigned > 0 || plan.skipped.done > 0) && (
                  <p className="dim">
                    Skipping{' '}
                    {[
                      plan.skipped.noDate && `${plan.skipped.noDate} without dates`,
                      plan.skipped.unassigned && `${plan.skipped.unassigned} unassigned`,
                      plan.skipped.done && `${plan.skipped.done} completed`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    .
                  </p>
                )}
                {plan.repeats.series + plan.repeats.once > 0 && (
                  <p className="dim">
                    {plural(plan.repeats.series, 'repeating task')} keep repeating. Teamweek doesn’t export when a series ends
                    {plan.repeats.ended > 0 && `, so ${plural(plan.repeats.ended, 'older one', 'older ones')} end where they were last planned`}.
                    {plan.repeats.once > 0 &&
                      ` ${plural(plan.repeats.once, 'task repeats', 'tasks repeat')} on a schedule prepweek can’t follow (like every 5 months): imported once, with the schedule in the notes.`}
                  </p>
                )}
                <div className="people-chips">
                  {matched.map((p) => (
                    <span key={p.key} className="chip matched" title="Already on this sheet">
                      {p.name} <b>{p.tasks}</b>
                    </span>
                  ))}
                  {newPeople.map((p) => (
                    <span key={p.key} className="chip new" title={p.email || 'Will be added'}>
                      + {p.name} <b>{p.tasks}</b>
                    </span>
                  ))}
                </div>
                {left && (
                  <p className="import-limit">
                    {left.room
                      ? `The ${limit.name} plan covers ${plural(limit.limit, 'person', 'people')}, with room for ${left.room} more: the ${left.room === 1 ? 'one' : left.room} with the most tasks ${left.room === 1 ? 'comes' : 'come'} in. ${plural(left.people, 'other person', 'other people')} and their ${plural(left.tasks, 'task')} stay out.`
                      : `The ${limit.name} plan covers ${plural(limit.limit, 'person', 'people')} and is full, so the ${plural(left.people, 'new person', 'new people')} in this file and their ${plural(left.tasks, 'task')} stay out.`}{' '}
                    <button className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent('prepweek:limit'))}>
                      More room
                    </button>
                  </p>
                )}
                {sample.length > 0 && (
                  <table className="sample">
                    <tbody>
                      {sample.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <span className="sample-dot" style={{ background: t.color }} />
                            {t.title}
                          </td>
                          <td className="dim">{nameOf(t.personKey)}</td>
                          <td className="dim">{t.start === t.end ? formatDay(t.start) : formatRange(t.start, t.end)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            )}

            <footer className="modal-foot">
              {progress !== null ? (
                <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                  <span>
                    Importing {plural(Math.round(progress * (plan?.tasks.length ?? 0)), 'task')} of {(plan?.tasks.length ?? 0).toLocaleString()}…
                  </span>
                  <span className="import-bar">
                    <span style={{ width: `${Math.max(3, progress * 100)}%` }} />
                  </span>
                </div>
              ) : (
                mode === 'replace' && <span className="foot-note">You can undo this.</span>
              )}
              <button className="btn" onClick={onClose} disabled={progress !== null}>
                Cancel
              </button>
              <button
                className={'btn ' + (mode === 'replace' ? 'destructive' : 'primary')}
                disabled={!plan || plan.tasks.length === 0 || progress !== null}
                onClick={async () => {
                  if (!plan) return;
                  setProgress(0);
                  await nextFrame(); // paint the progress bar first
                  try {
                    await applyImport(plan, mode, setProgress);
                  } finally {
                    setProgress(null);
                  }
                  onImported(plan.range);
                }}
              >
                {progress !== null && <span className="spinner" aria-hidden />}
                {progress !== null ? 'Importing…' : mode === 'replace' ? 'Replace with ' : 'Import '}
                {progress === null && plural(plan?.tasks.length ?? 0, 'task')}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
