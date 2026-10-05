import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseCsv } from './csv.ts';
import { buildPlan, detectDateOrder, FIELD_LABELS, FIELDS, guessMapping, type DateOrder, type Field, type Mapping } from './teamweek.ts';
import { applyImport, getUser, store } from '../data/store.ts';
import { formatDay, formatRange } from '../lib/dates.ts';
import { useBackToClose } from '../lib/useBackToClose.ts';

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

const SHOWN_FIELDS: Field[] = ['title', 'assignee', 'email', 'start', 'end', 'project', 'status', 'notes', 'tags', 'color', 'estimate'];

export function ImportDialog({ initialFile, onClose, onImported }: Props) {
  useBackToClose(true, onClose);
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [ambiguous, setAmbiguous] = useState(false);
  const [includeDone, setIncludeDone] = useState(false);
  const [unassigned, setUnassigned] = useState<'skip' | 'row'>('skip');
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const load = async (f: File) => {
    setError('');
    try {
      const rows = parseCsv(await f.text());
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
    }
  };

  if (initialFile && !started.current) {
    started.current = true;
    void load(initialFile);
  }

  const existing = useMemo(
    () => store.getRowIds('users').map((id) => ({ id, name: getUser(id)!.name, email: getUser(id)!.email })),
    [],
  );
  const plan = useMemo(
    () => (file ? buildPlan(file.rows, { mapping, dateOrder, includeDone, unassigned }, existing) : null),
    [file, mapping, dateOrder, includeDone, unassigned, existing],
  );

  const newPeople = plan?.people.filter((p) => !p.existingId) ?? [];
  const matched = plan?.people.filter((p) => p.existingId) ?? [];
  const sample = plan?.tasks.slice(0, 6) ?? [];
  const nameOf = (key: string) => plan?.people.find((p) => p.key === key)?.name ?? '';

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import" role="dialog" aria-label="Import from Teamweek">
        <header className="modal-head">
          <h2>Import from Teamweek / Toggl Plan</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {!file ? (
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
            <p className="dz-title">Drop your task export here</p>
            <button className="btn primary" onClick={() => input.current?.click()}>
              Choose CSV file
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
            <ol className="dz-help">
              <li>
                In Toggl Plan (formerly Teamweek), open the <b>Team</b> or <b>Plan</b> view.
              </li>
              <li>
                Use the <b>⋯</b> menu (top right) → <b>Export tasks</b>, pick the workspace, a team or a project, and the dates.
              </li>
              <li>Drop the downloaded .csv here. Exporting needs an Owner or Admin account.</li>
            </ol>
            <p className="dz-note">
              Re-importing the same export updates those tasks instead of duplicating them. Everything is one undo step.
            </p>
          </div>
        ) : (
          <div className="import-body">
            <div className="import-file">
              <b>{file.name}</b> · {file.rows.length.toLocaleString()} rows
              <button className="linkbtn" onClick={() => setFile(null)}>
                Choose another
              </button>
            </div>

            <section>
              <h3>Columns</h3>
              <div className="mapping">
                {SHOWN_FIELDS.map((f) => (
                  <label key={f} className={(f === 'start' || f === 'assignee' || f === 'title') && mapping[f] === undefined ? 'missing' : ''}>
                    <span>{FIELD_LABELS[f]}</span>
                    <select
                      value={mapping[f] ?? -1}
                      onChange={(e) => {
                        const v = Number(e.currentTarget.value);
                        setMapping((m) => ({ ...m, [f]: v < 0 ? undefined : v }));
                      }}
                    >
                      <option value={-1}>—</option>
                      {file.header.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </section>

            <section className="import-options">
              <label className={ambiguous ? 'warn' : ''}>
                <span>Dates are</span>
                <select value={dateOrder} onChange={(e) => setDateOrder(e.currentTarget.value as DateOrder)}>
                  <option value="dmy">day / month / year</option>
                  <option value="mdy">month / day / year</option>
                </select>
                {ambiguous && <em>Can’t tell from the file, please check</em>}
              </label>
              <label>
                <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.currentTarget.checked)} />
                Include completed tasks
              </label>
              <label>
                <span>Tasks without assignee</span>
                <select value={unassigned} onChange={(e) => setUnassigned(e.currentTarget.value as 'skip' | 'row')}>
                  <option value="skip">Skip</option>
                  <option value="row">Put on an “Unassigned” row</option>
                </select>
              </label>
            </section>

            {plan && (
              <section className="import-summary">
                <h3>
                  {plan.tasks.length.toLocaleString()} tasks for {plan.people.length} {plan.people.length === 1 ? 'person' : 'people'}
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
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!plan || plan.tasks.length === 0}
                onClick={() => {
                  if (!plan) return;
                  applyImport(plan);
                  onImported(plan.range);
                }}
              >
                Import {plan?.tasks.length.toLocaleString() ?? ''} tasks
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
