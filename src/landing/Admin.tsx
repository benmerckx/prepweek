// /admin: how Prepweek is doing. People, workspaces, plans and revenue from
// the directory; traffic, usage, errors and timings from the usage
// statistics (worker/stats.ts, worker/admin.ts). For ADMIN_EMAILS only.
//
// Charts follow one system: a single series is columns in the first
// series colour with no legend (the title names it); two series are lines
// with a legend and a crosshair readout. Every chart has its numbers in a
// table too, and hovering or focusing a mark shows its value.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Logo, Wordmark } from '../ui/brand.tsx';
import { PAID_PLANS } from '../lib/plans.ts';

const DAY = 86_400_000;

// --- What /api/admin/overview sends ---

type Row = Record<string, string | number>;
interface Overview {
  days: number;
  now: number;
  mrr: number;
  recording: boolean;
  usageError: string;
  directory: {
    users: { total: number; recent: number };
    workspaces: { total: number; recent: number };
    sheets: { total: number; recent: number; deleted: number };
    people: number;
    digestsOff: number;
    licenses: number;
    subscriptions: { plan: string; status: string; n: number }[];
    signups: { day: number; n: number }[];
    newWorkspaces: { day: number; n: number }[];
    newSheets: { day: number; n: number }[];
    recentUsers: { name: string; email: string; created: number; workspaces: number }[];
  };
  usage: Record<'totals' | 'views' | 'pages' | 'referrers' | 'requests' | 'routes' | 'errors' | 'events' | 'active', Row[]> | null;
}

// --- Formatting ---

const num = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : Math.round(n).toLocaleString('en'));
const pct = (n: number) => (n === 0 ? '0%' : n < 0.001 ? '<0.1%' : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`);
const dayLabel = (d: number) => new Date(d * DAY).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
/** Analytics Engine days ("2026-10-09 00:00:00") as day numbers. */
const dayOf = (v: string | number) => Math.floor(Date.parse(String(v).replace(' ', 'T') + 'Z') / DAY);

/** One value per day of the range, zeros where nothing happened. */
const series = (days: number, now: number, rows: { day: number; n: number }[]) => {
  const last = Math.floor(now / DAY);
  const by = new Map(rows.map((r) => [r.day, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const day = last - days + 1 + i;
    return { day, v: by.get(day) ?? 0 };
  });
};

/** Clean axis ticks: 0, step, 2·step, 3·step covering the max. */
const ticks = (max: number) => {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out = [];
  for (let t = 0; t <= max + step * 0.001; t += step) out.push(t);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
};

// --- Charts ---

const H = 150;

/** Charts draw at their card's real width, so text stays its size. */
const useWidth = (ref: RefObject<HTMLElement | null>) => {
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
};
const PAD = { l: 40, r: 8, t: 8, b: 22 };

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: { label: string; value: string; color?: string }[];
}
function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="adm-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <small>{tip.title}</small>
      {tip.lines.map((l) => (
        <span key={l.label}>
          {l.color && <i style={{ background: l.color }} />}
          <b>{l.value}</b> {l.label}
        </span>
      ))}
    </div>
  );
}

function Axes({ W, max, n, days, fmt }: { W: number; max: number; n: number; days: number[]; fmt: (v: number) => string }) {
  const ys = ticks(max);
  const top = ys[ys.length - 1]!;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const xs = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * (i + 0.5)) / n;
  return (
    <g className="adm-axes" aria-hidden>
      {ys.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
          <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {xs.map((i) => (
        <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
          {dayLabel(days[i]!)}
        </text>
      ))}
    </g>
  );
}

/** One series per day, as columns. */
function Columns({ data, label, fmt = num }: { data: { day: number; v: number }[]; label: string; fmt?: (v: number) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const n = data.length;
  const max = Math.max(0, ...data.map((d) => d.v));
  const top = ticks(max)[ticks(max).length - 1]!;
  const slot = (W - PAD.l - PAD.r) / n;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const base = H - PAD.b;
  return (
    <div className="adm-chart" ref={box} onPointerLeave={() => setTip(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, per day`}>
        <Axes W={W} max={max} n={n} days={data.map((d) => d.day)} fmt={fmt} />
        {data.map((d, i) => {
          const cx = PAD.l + slot * (i + 0.5);
          const h = base - y(d.v);
          const r = Math.min(4, bw / 2, h);
          const x0 = cx - bw / 2;
          const show = () => setTip({ x: cx, y: Math.max(0, y(d.v) - 8), title: dayLabel(d.day), lines: [{ label, value: fmt(d.v) }] });
          return (
            <g key={d.day} className="adm-bar" tabIndex={0} aria-label={`${dayLabel(d.day)}: ${fmt(d.v)} ${label}`} onPointerEnter={show} onFocus={show} onBlur={() => setTip(null)}>
              <rect className="adm-hit" x={PAD.l + slot * i} y={PAD.t} width={slot} height={base - PAD.t} />
              {d.v > 0 && (
                <path
                  d={`M${x0},${base} V${base - h + r} Q${x0},${base - h} ${x0 + r},${base - h} H${x0 + bw - r} Q${x0 + bw},${base - h} ${x0 + bw},${base - h + r} V${base} Z`}
                />
              )}
            </g>
          );
        })}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/** Two series per day, as lines (legend above, crosshair readout). */
function Lines({ data, names, fmt = num }: { data: { day: number; v: number[] }[]; names: string[]; fmt?: (v: number) => string }) {
  const [at, setAt] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const n = data.length;
  const max = Math.max(0, ...data.flatMap((d) => d.v));
  const top = ticks(max)[ticks(max).length - 1]!;
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * (i + 0.5)) / n;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const colors = ['var(--adm-s1)', 'var(--adm-s2)'];
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * n - 0.5))));
  };
  const d = at === null ? null : data[at]!;
  return (
    <div className="adm-chart" ref={box}>
      <div className="adm-legend">
        {names.map((nm, k) => (
          <span key={nm}>
            <i style={{ background: colors[k] }} />
            {nm}
          </span>
        ))}
      </div>
      <svg
        ref={ref}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${names.join(' and ')}, per day`}
        tabIndex={0}
        onPointerMove={move}
        onPointerLeave={() => setAt(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setAt((a) => Math.max(0, (a ?? n) - 1));
          if (e.key === 'ArrowRight') setAt((a) => Math.min(n - 1, (a ?? -1) + 1));
        }}
        onBlur={() => setAt(null)}
      >
        <Axes W={W} max={max} n={n} days={data.map((p) => p.day)} fmt={fmt} />
        {names.map((nm, k) => (
          <polyline key={nm} className="adm-line" style={{ stroke: colors[k] }} points={data.map((p, i) => `${x(i)},${y(p.v[k] ?? 0)}`).join(' ')} />
        ))}
        {at !== null && (
          <g>
            <line className="adm-cross" x1={x(at)} x2={x(at)} y1={PAD.t} y2={H - PAD.b} />
            {names.map((nm, k) => (
              <circle key={nm} className="adm-dot" cx={x(at)} cy={y(data[at]!.v[k] ?? 0)} r={4} style={{ fill: colors[k] }} />
            ))}
          </g>
        )}
      </svg>
      <TipBox tip={d && at !== null ? { x: x(at), y: 26, title: dayLabel(d.day), lines: names.map((nm, k) => ({ label: nm, value: fmt(d.v[k] ?? 0), color: colors[k] })) } : null} />
    </div>
  );
}

// --- Pieces ---

function Tile({ label, value, sub, status }: { label: string; value: string; sub?: ReactNode; status?: 'good' | 'critical' }) {
  return (
    <div className="adm-tile">
      <span className="adm-tile-label">{label}</span>
      <b className="adm-tile-value">{value}</b>
      {sub && (
        <span className={'adm-tile-sub' + (status ? ` ${status}` : '')}>
          {status && <span className="adm-status-icon" aria-hidden>{status === 'good' ? '✓' : '!'}</span>}
          {sub}
        </span>
      )}
    </div>
  );
}

function Card({ title, note, children, wide }: { title: string; note?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={'adm-card' + (wide ? ' wide' : '')}>
      <h3>{title}</h3>
      {note && <p className="adm-note">{note}</p>}
      {children}
    </section>
  );
}

function Table({ head, rows, empty = 'Nothing yet' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="adm-empty">{empty}</p>;
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- The page ---

const RANGES = [7, 30, 90];

export function AdminPage() {
  const [days, setDays] = useState(() => Number(new URLSearchParams(location.search).get('days')) || 30);
  const [data, setData] = useState<Overview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'login' | 'denied' | 'error'>('loading');
  const [message, setMessage] = useState('');
  useEffect(() => {
    document.title = 'Admin · Prepweek';
  }, []);
  useEffect(() => {
    let alive = true;
    setState((s) => (s === 'ready' ? 'ready' : 'loading'));
    fetch(`/api/admin/overview?days=${days}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 401) return setState('login');
        if (res.status === 403) return setState('denied');
        if (!res.ok) throw new Error(`${res.status}`);
        setData((await res.json()) as Overview);
        setState('ready');
      })
      .catch((e) => {
        if (!alive) return;
        setMessage(e instanceof Error ? e.message : String(e));
        setState('error');
      });
    history.replaceState(null, '', `/admin${days === 30 ? '' : `?days=${days}`}`);
    return () => {
      alive = false;
    };
  }, [days]);

  return (
    <div className="lp lp-page adm">
      <nav className="lp-nav scrolled">
        <div className="lp-wrap lp-nav-inner">
          <a className="lp-brand" href="/" aria-label="Prepweek home">
            <Logo size={24} />
            <Wordmark className="lp-brand-name" size={24} />
          </a>
          <span className="adm-badge">Admin</span>
          <span className="adm-nav-space" />
          <a className="lp-btn ghost" href="/app">
            Open Prepweek
          </a>
        </div>
      </nav>
      <main className="lp-wrap adm-main">
        {state === 'login' && (
          <div className="adm-gate">
            <h1>Admin</h1>
            <p>Log in with an admin account to see how Prepweek is doing.</p>
            <a className="lp-btn primary" href="/?signin">
              Log in
            </a>
          </div>
        )}
        {state === 'denied' && (
          <div className="adm-gate">
            <h1>Not for this account</h1>
            <p>Only the addresses in ADMIN_EMAILS can open the admin dashboard.</p>
          </div>
        )}
        {state === 'error' && (
          <div className="adm-gate">
            <h1>Couldn’t load the numbers</h1>
            <p>{message}</p>
          </div>
        )}
        {state === 'loading' && !data && <p className="adm-empty">Loading…</p>}
        {data && (state === 'ready' || state === 'loading') && <Dashboard data={data} days={days} setDays={setDays} loading={state === 'loading'} />}
      </main>
    </div>
  );
}

function Dashboard({ data, days, setDays, loading }: { data: Overview; days: number; setDays(d: number): void; loading: boolean }) {
  const { directory: dir, usage } = data;
  const v = useMemo(() => {
    const u = usage;
    const perDay = (rows: Row[] | undefined, pick: (r: Row) => number, filter: (r: Row) => boolean = () => true) => {
      const m = new Map<number, number>();
      for (const r of rows ?? []) if (filter(r)) m.set(dayOf(r.day!), (m.get(dayOf(r.day!)) ?? 0) + pick(r));
      return [...m].map(([day, n]) => ({ day, n }));
    };
    const views = series(days, data.now, perDay(u?.views, (r) => Number(r.views)));
    const visitors = series(days, data.now, perDay(u?.views, (r) => Number(r.visitors)));
    const reqs = series(days, data.now, perDay(u?.requests, (r) => Number(r.n)));
    const errs = series(days, data.now, perDay(u?.requests, (r) => Number(r.n), (r) => r.class === '5xx'));
    const event = (name: string) => series(days, data.now, perDay(u?.events, (r) => Number(r.n), (r) => r.name === name));
    const totalReqs = reqs.reduce((s, d) => s + d.v, 0);
    const totalErrs = errs.reduce((s, d) => s + d.v, 0);
    // Per route: requests, server errors, average and slowest time.
    const routes = new Map<string, { n: number; err: number; ms: number; slowest: number }>();
    for (const r of u?.routes ?? []) {
      const k = String(r.route);
      const cur = routes.get(k) ?? { n: 0, err: 0, ms: 0, slowest: 0 };
      cur.n += Number(r.n);
      cur.ms += Number(r.ms);
      cur.slowest = Math.max(cur.slowest, Number(r.slowest));
      if (r.class === '5xx') cur.err += Number(r.n);
      routes.set(k, cur);
    }
    return {
      views,
      visitors,
      reqs,
      errRate: reqs.map((d, i) => ({ day: d.day, v: d.v ? errs[i]!.v / d.v : 0 })),
      active: series(days, data.now, perDay(u?.active, (r) => Number(r.people))),
      wakes: event('sheet_load'),
      digests: event('digest'),
      plays: event('daily_play'),
      solves: event('daily_solve'),
      totalViews: views.reduce((s, d) => s + d.v, 0),
      // Visitor codes change every day: a visitor on three days is three visits.
      visits: Number(u?.totals?.[0]?.visits ?? 0),
      totalReqs,
      totalErrs,
      routes: [...routes].sort((a, b) => b[1].n - a[1].n),
    };
  }, [usage, days, data.now]);

  const paying = dir.subscriptions.filter((s) => ['active', 'trialing', 'past_due'].includes(s.status)).reduce((n, s) => n + s.n, 0);
  const errRate = v.totalReqs ? v.totalErrs / v.totalReqs : 0;
  const period = days === 1 ? 'today' : `last ${days} days`;

  return (
    <div className={'adm-dash' + (loading ? ' loading' : '')}>
      <div className="adm-head">
        <h1>How Prepweek is doing</h1>
        <div className="adm-range" role="radiogroup" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r} role="radio" aria-checked={days === r} className={days === r ? 'on' : ''} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>

      {data.usageError && (
        <div className="adm-notice">
          {data.usageError === 'not-configured' ? (
            <>
              <b>Traffic, usage and errors aren’t connected yet.</b> They’re {data.recording ? 'being recorded' : 'not being recorded (no EVENTS binding)'}; to read them
              back, add the secrets <code>CF_ACCOUNT_ID</code> and <code>CF_API_TOKEN</code> (an API token with “Account Analytics: Read”) in Cloudflare.
            </>
          ) : (
            <>
              <b>Couldn’t read the usage statistics.</b> {data.usageError}
            </>
          )}
        </div>
      )}

      <div className="adm-tiles">
        <Tile label="People with an account" value={num(dir.users.total)} sub={`+${num(dir.users.recent)} ${period}`} />
        <Tile label="Workspaces" value={num(dir.workspaces.total)} sub={`+${num(dir.workspaces.recent)} ${period}`} />
        <Tile label="Plans" value={num(dir.sheets.total)} sub={`${num(dir.people)} people planned`} />
        <Tile label="Paying workspaces" value={num(paying)} sub={`€${num(data.mrr)} a month${dir.licenses ? ` · ${dir.licenses} licences` : ''}`} />
        <Tile label="Visits" value={usage ? num(v.visits) : '–'} sub={usage ? `${num(v.totalViews)} page views, ${period}` : 'not connected'} />
        <Tile
          label="Server errors"
          value={usage ? pct(errRate) : '–'}
          sub={usage ? `${num(v.totalErrs)} of ${num(v.totalReqs)} requests` : 'not connected'}
          status={usage ? (errRate > 0.01 ? 'critical' : 'good') : undefined}
        />
      </div>

      <h2>Growth</h2>
      <div className="adm-grid">
        <Card title="Sign-ups per day">
          <Columns data={series(days, data.now, dir.signups)} label="sign-ups" />
        </Card>
        <Card title="New plans per day">
          <Columns data={series(days, data.now, dir.newSheets)} label="new plans" />
        </Card>
      </div>

      {usage && (
        <>
          <h2>Traffic</h2>
          <div className="adm-grid">
            <Card title="Page views and visitors per day" note="A visitor is counted once a day, without cookies." wide>
              <Lines data={v.views.map((d, i) => ({ day: d.day, v: [d.v, v.visitors[i]!.v] }))} names={['Page views', 'Visitors']} />
            </Card>
            <Card title="Pages">
              <Table
                head={['Page', 'Views', 'Visitors']}
                rows={usage.pages.map((r) => [String(r.page), num(Number(r.views)), num(Number(r.visitors))])}
              />
            </Card>
            <Card title="Where visitors come from" note="Other sites that linked here; direct visits and search engines that hide it aren’t listed.">
              <Table head={['Site', 'Views']} rows={usage.referrers.map((r) => [String(r.host), num(Number(r.views))])} />
            </Card>
          </div>

          <h2>Usage</h2>
          <div className="adm-grid">
            <Card title="People using the app per day" note="Signed-in people who opened Prepweek that day.">
              <Columns data={v.active} label="people" />
            </Card>
            <Card title="Plans loaded per day" note="Each load wakes a plan on the server: the main thing hosting costs follow.">
              <Columns data={v.wakes} label="plans loaded" />
            </Card>
            <Card title="Daily puzzle">
              <Lines data={v.plays.map((d, i) => ({ day: d.day, v: [d.v, v.solves[i]!.v] }))} names={['Played', 'Solved']} />
            </Card>
            <Card title="Digest emails sent per day">
              <Columns data={v.digests} label="digests" />
            </Card>
          </div>

          <h2>Reliability</h2>
          <div className="adm-grid">
            <Card title="Requests per day" note="Everything the server handles; the website’s own files are served without it.">
              <Columns data={v.reqs} label="requests" />
            </Card>
            <Card title="Server error rate per day" note="Share of requests answered with a 5xx error.">
              <Columns data={v.errRate} label="server errors" fmt={pct} />
            </Card>
            <Card title="By route" wide>
              <Table
                head={['Route', 'Requests', 'Server errors', 'Error rate', 'Average', 'Slowest']}
                rows={v.routes.map(([route, r]) => [
                  <code key="r">{route}</code>,
                  num(r.n),
                  num(r.err),
                  <span key="e" className={r.err / r.n > 0.01 ? 'adm-bad' : ''}>
                    {pct(r.n ? r.err / r.n : 0)}
                  </span>,
                  `${Math.round(r.n ? r.ms / r.n : 0)} ms`,
                  `${Math.round(r.slowest)} ms`,
                ])}
              />
            </Card>
            <Card title="Errors" note="Uncaught errors in browsers, and failures on the server, most frequent first." wide>
              <Table
                head={['Where', 'Message', 'Place', 'Times', 'Last']}
                rows={usage.errors.map((r) => [
                  String(r.source),
                  <span key="m" className="adm-msg">
                    {String(r.message)}
                  </span>,
                  <code key="p">{String(r.place)}</code>,
                  num(Number(r.n)),
                  ago(Date.parse(String(r.last).replace(' ', 'T') + 'Z')),
                ])}
                empty="No errors. Nice."
              />
            </Card>
          </div>
        </>
      )}

      <h2>People</h2>
      <div className="adm-grid">
        <Card title="Newest accounts" wide>
          <Table
            head={['Name', 'Email', 'Workspaces', 'Joined']}
            rows={dir.recentUsers.map((u) => [u.name, u.email, String(u.workspaces), ago(u.created)])}
          />
        </Card>
        <Card title="Subscriptions">
          <Table
            head={['Plan', 'Status', 'Workspaces']}
            rows={dir.subscriptions.map((s) => [PAID_PLANS.find((p) => p.id === s.plan)?.name ?? (s.plan || '–'), s.status || '–', String(s.n)])}
            empty="No subscriptions yet"
          />
        </Card>
        <Card title="Other numbers">
          <Table
            head={['What', 'How many']}
            rows={[
              ['Plans deleted', num(dir.sheets.deleted)],
              ['Digest turned off', num(dir.digestsOff)],
              ['New workspaces', `${num(dir.workspaces.recent)} (${period})`],
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
