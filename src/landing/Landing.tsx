// The page new visitors see at / (and anyone at /welcome). Every visual is
// built from real elements in the app's own styles (blocks, patterns, the
// scrubber), not screenshots, so it stays sharp at any size and in both
// themes. Animations start when a section scrolls into view and are off for
// people who prefer reduced motion.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getMe, newSheetId, rememberMySheet } from '../data/account.ts';
import { Logo } from '../ui/icons.tsx';
import './landing.css';

const SignInDialog = lazy(() => import('../timeline/Account.tsx').then((m) => ({ default: m.SignInDialog })));

const C = {
  blue: '#4f7cff',
  green: '#22a06b',
  red: '#e5484d',
  amber: '#f59e0b',
  violet: '#8b5cf6',
  cyan: '#06b6d4',
  pink: '#ec4899',
  slate: '#64748b',
  lime: '#84cc16',
  orange: '#f97316',
};

const startPlanning = () => {
  const id = newSheetId();
  rememberMySheet(id);
  location.href = `/s/${encodeURIComponent(id)}`;
};

// --- Small building blocks ---------------------------------------------------------------

/** A block, in the app's real block styles (class "task", patterns, ink). */
function Block({ title, meta, color, pattern, done, style, className = '' }: { title: string; meta?: string; color: string; pattern?: string; done?: boolean; style?: CSSProperties; className?: string }) {
  return (
    <div className={'task lp-task' + (done ? ' done' : '') + (className ? ' ' + className : '')} data-pattern={pattern} style={{ ['--c' as string]: color, ...style }}>
      <div className="task-clip">
        <div className="task-label tall">
          <span className="task-title">
            {done && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
            )}
            {title}
          </span>
          {meta && (
            <span className="task-sub">
              <span className="task-meta">{meta}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  const ini = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2);
  return (
    <span className="lp-avatar" style={{ ['--c' as string]: color, width: size, height: size, fontSize: size * 0.38 }}>
      {ini}
    </span>
  );
}

/** A teammate's pointer with their name, like live presence in the app. */
function Cursor({ name, color, className = '', style }: { name: string; color: string; className?: string; style?: CSSProperties }) {
  return (
    <span className={'lp-cursor ' + className} style={{ ['--c' as string]: color, ...style }} aria-hidden>
      <svg width="16" height="18" viewBox="0 0 16 18">
        <path d="M1.5 1.2 14 8.6l-5.6 1.3-2.7 5.6z" fill="var(--c)" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="lp-cursor-name">{name}</span>
    </span>
  );
}

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

/** Fade/slide in when scrolled into view; children animate with it. */
function Reveal({ children, className = '', as: Tag = 'div', delay = 0, id }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'li'; delay?: number; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} id={id} className={'lp-reveal' + (inView ? ' is-in' : '') + (className ? ' ' + className : '')} style={{ ['--d' as string]: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

// --- Hero: a live mini timeline ------------------------------------------------------------

const DAYS = ['Mo 5', 'Tu 6', 'We 7', 'Th 8', 'Fr 9', 'Mo 12', 'Tu 13', 'We 14', 'Th 15', 'Fr 16'];
const TODAY = 1;

interface HeroBlock {
  lane: 0 | 1;
  col: number;
  span: number;
  title: string;
  meta: string;
  color: string;
  pattern?: string;
  done?: boolean;
  /** Animated by the hero's cursors. */
  role?: 'drag' | 'stretch';
}
const PEOPLE: { name: string; color: string; load: number; blocks: HeroBlock[] }[] = [
  {
    name: 'Ava Peeters',
    color: C.blue,
    load: 0.86,
    blocks: [
      { lane: 0, col: 0, span: 3, title: 'Brand refresh', meta: 'Globex · 3d', color: C.red },
      { lane: 0, col: 4, span: 5, title: 'Website relaunch', meta: 'Acme · 5d', color: C.blue },
      { lane: 1, col: 1, span: 1, title: 'Workshop', meta: '1d', color: C.slate, pattern: 'dots' },
      { lane: 1, col: 6, span: 2, title: 'Q4 planning', meta: '2d', color: C.slate, pattern: 'grid' },
    ],
  },
  {
    name: 'Noah Goossens',
    color: C.green,
    load: 1,
    blocks: [
      { lane: 0, col: 0, span: 4, title: 'API v3', meta: 'Initech · 4d', color: C.amber },
      { lane: 0, col: 5, span: 3, title: 'Billing revamp', meta: '3d', color: C.orange, role: 'stretch' },
      { lane: 1, col: 2, span: 1, title: 'Code review', meta: '1d', color: C.violet, pattern: 'stripes' },
    ],
  },
  {
    name: 'Mila Mertens',
    color: C.red,
    load: 0.8,
    blocks: [
      { lane: 0, col: 0, span: 2, title: 'Mobile app', meta: '2d', color: C.green, done: true },
      { lane: 0, col: 3, span: 3, title: 'Customer interviews', meta: '3d', color: C.red, pattern: 'waves' },
      { lane: 1, col: 7, span: 3, title: 'Holiday', meta: '3d', color: C.pink, pattern: 'stripes' },
    ],
  },
  {
    name: 'Lucas Janssens',
    color: C.amber,
    load: 0.64,
    blocks: [
      { lane: 0, col: 1, span: 3, title: 'Marketing site', meta: '3d', color: C.violet },
      { lane: 0, col: 5, span: 2, title: 'Data migration', meta: '2d', color: C.cyan, role: 'drag' },
      { lane: 1, col: 0, span: 1, title: 'Support', meta: '1d', color: C.lime, done: true },
    ],
  },
  {
    name: 'Emma Wouters',
    color: C.violet,
    load: 0.72,
    blocks: [
      { lane: 0, col: 0, span: 2, title: 'Onboarding flow', meta: '2d', color: C.violet, pattern: 'dots' },
      { lane: 0, col: 3, span: 4, title: 'Analytics', meta: 'Acme · 4d', color: C.cyan },
      { lane: 1, col: 8, span: 2, title: 'Security audit', meta: '2d', color: C.amber, pattern: 'checks' },
    ],
  },
];

/** Weekly plateaus for the mini scrubber, from a fixed seed. */
const useSeries = () =>
  useMemo(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const colors = [C.blue, C.red, C.amber, C.green, C.violet];
    return colors.map((color, i) => {
      const weeks = Array.from({ length: 26 }, (_, w) => 0.25 + 0.5 * rnd() + 0.18 * Math.sin((w + i * 3) / 3.2));
      // Plateau per week with short S-curves between, like the app's scrubber.
      const W = 600 / 26;
      const y = (v: number) => 46 - Math.max(0.05, Math.min(1, v)) * 36 - i * 1.5;
      let d = `M0 ${y(weeks[0]!)}`;
      weeks.forEach((v, w) => {
        if (w === 0) return;
        const xb = w * W;
        const prev = y(weeks[w - 1]!);
        d += ` L${xb - 4} ${prev} C${xb} ${prev} ${xb} ${y(v)} ${xb + 4} ${y(v)}`;
      });
      d += ` L600 ${y(weeks.at(-1)!)}`;
      return { color, d };
    });
  }, []);

function Scrubber({ handle = true }: { handle?: boolean }) {
  const series = useSeries();
  return (
    <div className="lp-scrub">
      <div className="lp-scrub-months">
        {['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'].map((m, i) => (
          <span key={m} className={m === 'Jan' ? 'year' : ''} style={{ left: `${(i / 6) * 100}%` }}>
            {m === 'Jan' ? '2027' : m}
          </span>
        ))}
      </div>
      <svg className="lp-scrub-graph" viewBox="0 0 600 50" preserveAspectRatio="none" aria-hidden>
        {series.map((s, i) => (
          <path key={s.color} d={s.d} stroke={s.color} style={{ ['--i' as string]: i }} />
        ))}
      </svg>
      <span className="lp-scrub-today" />
      {handle && <span className="lp-scrub-handle" />}
    </div>
  );
}

function HeroApp() {
  return (
    <div className="lp-app" role="img" aria-label="PrepWeek's timeline: five people with their work planned across two weeks, while two teammates move and stretch blocks live.">
      <div className="lp-app-bar">
        <span className="lp-app-brand">
          <Logo size={20} />
          <span>
            <b>Q4 roadmap</b>
            <small>Codeurs</small>
          </span>
        </span>
        <span className="lp-app-tabs">
          <span className="on">Plan</span>
          <span>Projects</span>
          <span>Clients</span>
        </span>
        <span className="lp-app-today">Today</span>
        <span className="lp-app-spacer" />
        <span className="lp-app-faces">
          <Avatar name="Mila Mertens" color={C.red} size={24} />
          <Avatar name="Noah Goossens" color={C.green} size={24} />
          <Avatar name="Ava Peeters" color={C.blue} size={24} />
        </span>
        <span className="lp-app-share">Share</span>
      </div>
      <div className="lp-app-grid">
        <div className="lp-app-corner">
          <span>People</span>
          <span className="lp-count">5</span>
        </div>
        <div className="lp-app-head">
          {DAYS.map((d, i) => (
            <span key={d} className={(i === TODAY ? 'today' : '') + (i === 5 ? ' week' : '')}>
              <small>{d.slice(0, 2)}</small>
              <b>{d.slice(3)}</b>
            </span>
          ))}
        </div>
        {PEOPLE.map((p, r) => (
          <div key={p.name} className="lp-app-row" style={{ ['--r' as string]: r }}>
            <div className="lp-app-person">
              <Avatar name={p.name} color={p.color} />
              <span>
                <b>{p.name}</b>
                <small>
                  <i style={{ ['--p' as string]: p.load }} />
                  {Math.round(p.load * 100)}% booked
                </small>
              </span>
            </div>
            <div className="lp-app-lanes">
              <span className="lp-app-todaycol" />
              {p.blocks.map((b, i) => {
                const style = { gridColumn: `${b.col + 1} / span ${b.span}`, gridRow: b.lane + 1, ['--i' as string]: r * 4 + i } as CSSProperties;
                if (b.role === 'drag')
                  return (
                    <div key={b.title} className="lp-slot lp-drag" style={style}>
                      <Block title={b.title} meta={b.meta} color={b.color} pattern={b.pattern} />
                      <Cursor name="Mila" color={C.red} className="lp-drag-cursor" />
                    </div>
                  );
                if (b.role === 'stretch')
                  return (
                    <div key={b.title} className="lp-slot lp-stretch" style={{ ...style, gridColumn: `${b.col + 1} / span ${b.span + 1}` }}>
                      <div className="lp-stretch-box">
                        <Block title={b.title} meta={b.meta} color={b.color} pattern={b.pattern} className="lp-stretch-block" />
                        <span className="lp-stretch-meta" aria-hidden>
                          <span>3d</span>
                          <span>4d</span>
                        </span>
                        <Cursor name="Noah" color={C.green} className="lp-stretch-cursor" />
                      </div>
                    </div>
                  );
                return (
                  <div key={b.title} className="lp-slot" style={style}>
                    <Block title={b.title} meta={b.meta} color={b.color} pattern={b.pattern} done={b.done} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <span className="lp-app-todayline" style={{ ['--col' as string]: TODAY }} />
      </div>
      <div className="lp-app-foot">
        <span className="lp-app-range">
          <b>5–16 Oct 2026</b>
          <small>Drag the strip to scrub through time</small>
        </span>
        <Scrubber />
      </div>
    </div>
  );
}

function Hero() {
  // The app window leans back and straightens as you scroll into the page.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      el.style.setProperty('--tilt', String(Math.max(0, 1 - scrollY / 420)));
    };
    const onScroll = () => (raf ||= requestAnimationFrame(update));
    update();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  // Phones: the mini app keeps its desktop layout, scaled to the frame.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only width matters (zooming changes the height, which would loop).
    let width = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      requestAnimationFrame(() => el.style.setProperty('--lp-zoom', String((width - 10) / 880)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <header className="lp-hero">
      <div className="lp-hero-glow" aria-hidden />
      <div className="lp-wrap lp-hero-copy">
        <a className="lp-pill lp-in" href="#import" style={{ ['--d' as string]: '0ms' }}>
          <span className="lp-pill-dot" />
          Coming from Teamweek? Import in one go
          <Arrow />
        </a>
        <h1 className="lp-in" style={{ ['--d' as string]: '60ms' }}>
          Your team’s weeks, <br className="lp-br" />
          <span className="lp-grad">at a glance.</span>
        </h1>
        <p className="lp-lede lp-in" style={{ ['--d' as string]: '120ms' }}>
          PrepWeek is a fast, visual planner for teams. Drag work onto people, stretch it across days, and everyone sees the change the
          moment you make it.
        </p>
        <div className="lp-ctas lp-in" style={{ ['--d' as string]: '180ms' }}>
          <button className="lp-btn primary big" onClick={startPlanning}>
            Start planning
            <Arrow />
          </button>
          <a className="lp-btn ghost big" href="/s/demo">
            Try the demo
          </a>
        </div>
        <p className="lp-note lp-in" style={{ ['--d' as string]: '240ms' }}>
          <span>
            <Tick /> No sign-up needed
          </span>
          <span>
            <Tick /> Works offline
          </span>
          <span>
            <Tick /> Live for everyone on the sheet
          </span>
        </p>
      </div>
      <div className="lp-wrap lp-hero-stage">
        <div className="lp-hero-frame lp-in" ref={ref} style={{ ['--d' as string]: '300ms' }}>
          <HeroApp />
        </div>
      </div>
    </header>
  );
}

// --- Features -----------------------------------------------------------------------------------

function Card({ title, text, children, className = '', delay = 0 }: { title: string; text: string; children: ReactNode; className?: string; delay?: number }) {
  return (
    <Reveal className={'lp-card ' + className} delay={delay}>
      <div className="lp-card-visual">{children}</div>
      <div className="lp-card-copy">
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </Reveal>
  );
}

function DragVisual() {
  return (
    <div className="lp-mini">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="lp-mini-col" />
      ))}
      <div className="lp-mini-rows">
        <div className="lp-mini-row">
          <Avatar name="Ava Peeters" color={C.blue} size={22} />
          <div className="lp-mini-lane">
            <Block title="Website relaunch" meta="3d" color={C.blue} style={{ gridColumn: '1 / span 3' }} />
            <Block title="Review" meta="1d" color={C.slate} pattern="dots" style={{ gridColumn: '5 / span 1' }} />
          </div>
        </div>
        <div className="lp-mini-row">
          <Avatar name="Noah Goossens" color={C.green} size={22} />
          <div className="lp-mini-lane">
            <div className="lp-mini-move">
              <Block title="API v3" meta="2d" color={C.amber} />
              <Cursor name="You" color={C.violet} className="lp-mini-cursor" />
            </div>
          </div>
        </div>
        <div className="lp-mini-row">
          <Avatar name="Mila Mertens" color={C.red} size={22} />
          <div className="lp-mini-lane">
            <Block title="Customer interviews" meta="4d" color={C.red} pattern="waves" style={{ gridColumn: '2 / span 4' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveVisual() {
  return (
    <div className="lp-live">
      <div className="lp-live-block">
        <Block title="Brand refresh" meta="Globex · 3d" color={C.pink} pattern="stripes" />
        <span className="lp-live-ring" />
        <Cursor name="Ava" color={C.blue} className="lp-live-c1" />
      </div>
      <div className="lp-live-comment">
        <Avatar name="Noah Goossens" color={C.green} size={26} />
        <div>
          <b>Noah</b>
          <span>
            <em>@Ava</em> can you take Thursday? Client moved the review.
          </span>
        </div>
      </div>
      <Cursor name="Noah" color={C.green} className="lp-live-c2" />
    </div>
  );
}

function ScrubVisual() {
  return (
    <div className="lp-scrubcard">
      <div className="lp-scrubcard-filter">
        <span className="lp-chip" style={{ ['--c' as string]: C.blue }}>
          <i data-pattern="dots" />
          Website relaunch
        </span>
        <span className="lp-chip ghost">+ filter</span>
      </div>
      <Scrubber />
    </div>
  );
}

const PROJECTS = [
  { name: 'Website relaunch', client: 'Acme', color: C.blue, pattern: 'dots', tasks: 42, days: '61d' },
  { name: 'Brand refresh', client: 'Globex', color: C.red, pattern: 'stripes', tasks: 18, days: '27d' },
  { name: 'Billing revamp', client: 'Initech', color: C.orange, pattern: 'grid', tasks: 31, days: '48d' },
  { name: 'Mobile app', client: 'Acme', color: C.green, pattern: 'waves', tasks: 26, days: '39d' },
];
function ProjectsVisual() {
  return (
    <div className="lp-table">
      {PROJECTS.map((p, i) => (
        <div key={p.name} className="lp-table-row" style={{ ['--i' as string]: i }}>
          <span className="pattern-swatch chip" data-pattern={p.pattern} style={{ ['--c' as string]: p.color }} />
          <b>{p.name}</b>
          <span className="lp-dim">{p.client}</span>
          <span className="lp-num">{p.tasks}</span>
          <span className="lp-num lp-dim">{p.days}</span>
        </div>
      ))}
    </div>
  );
}

function OfflineVisual() {
  return (
    <div className="lp-offline">
      <div className="lp-status">
        <span className="lp-status-a">
          <i className="off" /> Offline · 3 changes kept
        </span>
        <span className="lp-status-b">
          <i className="on" /> Synced with everyone
        </span>
      </div>
      <div className="lp-offline-stack">
        {[C.cyan, C.violet, C.amber].map((c, i) => (
          <span key={c} className="lp-offline-dot" style={{ ['--c' as string]: c, ['--i' as string]: i }} />
        ))}
      </div>
    </div>
  );
}

function RepeatVisual() {
  return (
    <div className="lp-repeat">
      {[0, 1, 2, 3].map((w) => (
        <div key={w} className="lp-repeat-week" style={{ ['--i' as string]: w }}>
          <small>{['Oct 5', 'Oct 12', 'Oct 19', 'Oct 26'][w]}</small>
          <Block title="Stand-up" meta="9:30" color={C.cyan} pattern="dots" />
        </div>
      ))}
    </div>
  );
}

function NotesVisual() {
  return (
    <div className="lp-notes">
      <div className="lp-notes-doc">
        <b>Kickoff agenda</b>
        <ul>
          <li>Goals for Q4</li>
          <li>
            Design review with <em>@Mila</em>
          </li>
        </ul>
        <span className="lp-notes-line">
          /<span className="lp-caret" />
        </span>
      </div>
      <div className="lp-notes-menu">
        {[
          ['H', 'Heading'],
          ['•', 'Bulleted list'],
          ['1.', 'Numbered list'],
        ].map(([g, l], i) => (
          <span key={l} className={i === 1 ? 'on' : ''}>
            <i>{g}</i>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

function PaletteVisual() {
  return (
    <div className="lp-palette">
      <div className="lp-palette-input">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" strokeLinecap="round" />
        </svg>
        <span className="lp-type">brand</span>
        <kbd>⌘K</kbd>
      </div>
      <div className="lp-palette-list">
        <span className="on">
          <i className="pattern-swatch chip" data-pattern="stripes" style={{ ['--c' as string]: C.red }} />
          Brand refresh <small>Globex · filter</small>
        </span>
        <span>
          <i className="lp-palette-ico">→</i>
          Go to today <kbd>T</kbd>
        </span>
        <span>
          <i className="lp-palette-ico">◐</i>
          Hide weekends
        </span>
      </div>
    </div>
  );
}

function Features() {
  return (
    <section className="lp-section" id="features">
      <div className="lp-wrap">
        <Reveal className="lp-heading">
          <span className="lp-eyebrow">Everything in one view</span>
          <h2>Planning that keeps up with your team.</h2>
          <p>For studios, agencies and product teams who plan people, not tickets.</p>
        </Reveal>
        <div className="lp-bento">
          <Card className="wide" title="Drag, stretch, done" text="Move work between people and days with one drag. Blocks pack themselves into lanes, so nothing hides behind anything else.">
            <DragVisual />
          </Card>
          <Card title="Live, together" text="See who is looking at what. Edits, comments and @mentions reach everyone on the sheet instantly." delay={80}>
            <LiveVisual />
          </Card>
          <Card title="Months at a glance" text="The scrubber charts your team’s workload. Filter on a project and its busy weeks light up." delay={0}>
            <ScrubVisual />
          </Card>
          <Card title="Projects and clients" text="Every project gets a color and a pattern, and its own page with people, dates and notes." delay={80}>
            <ProjectsVisual />
          </Card>
          <Card title="Offline first" text="Your plan lives on your device. Keep planning on the train; it syncs the moment you’re back." delay={160}>
            <OfflineVisual />
          </Card>
          <Card title="Set it once" text="Weekly stand-ups, monthly reviews, yearly renewals. Repeating work fills itself in." delay={0}>
            <RepeatVisual />
          </Card>
          <Card title="Notes that format themselves" text="Type / for headings and lists, or select text to style it. Mention a teammate and they’ll know." delay={80}>
            <NotesVisual />
          </Card>
          <Card title="Everything from the keyboard" text="Press ⌘K to jump to a person, filter on a project or run any command." delay={160}>
            <PaletteVisual />
          </Card>
        </div>
      </div>
    </section>
  );
}

// --- Steps -----------------------------------------------------------------------------------------

function Steps() {
  const steps = [
    { n: '1', title: 'Add your people', text: 'One row per person. Group them in teams if you like.' },
    { n: '2', title: 'Drag work in', text: 'Drag across a row to plan a block. Give it a project, a color, a pattern.' },
    { n: '3', title: 'Share the link', text: 'Everyone sees the same plan, live. Sign up to keep it and invite your team.' },
  ];
  return (
    <section className="lp-section">
      <div className="lp-wrap">
        <Reveal className="lp-heading">
          <span className="lp-eyebrow">Getting started</span>
          <h2>Planned before your coffee cools.</h2>
        </Reveal>
        <ol className="lp-steps">
          {steps.map((s, i) => (
            <Reveal key={s.n} as="li" className="lp-step" delay={i * 90}>
              <span className="lp-step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --- Import ----------------------------------------------------------------------------------------

/** Counts up once the import card is visible. */
function Count({ to, run }: { to: number; run: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setN(to);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0 - 500) / 1600);
      setN(Math.round(to * (p < 0 ? 0 : 1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [run, to]);
  return <>{n.toLocaleString('en')}</>;
}

function ImportCard() {
  const ref = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setRun(true), io.disconnect()), { threshold: 0.4 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={'lp-import-card' + (run ? ' run' : '')}>
      <div className="lp-file">
        <span className="lp-file-ico">CSV</span>
        <span>
          <b>teamweek-export.csv</b>
          <small>2.4 MB</small>
        </span>
      </div>
      <div className="lp-import-bar">
        <i />
      </div>
      <div className="lp-import-stats">
        <span>
          <b>
            <Count to={12} run={run} />
          </b>
          people
        </span>
        <span>
          <b>
            <Count to={38} run={run} />
          </b>
          projects
        </span>
        <span>
          <b>
            <Count to={4820} run={run} />
          </b>
          tasks
        </span>
      </div>
      <div className="lp-import-blocks">
        <Block title="Status meeting" meta="10:30–11:00" color={C.cyan} />
        <Block title="SLA renewal" meta="Imec · 1d" color={C.amber} pattern="checks" />
        <Block title="Launch" meta="2d" color={C.green} done />
      </div>
    </div>
  );
}

function Import() {
  const points = ['People, matched by email', 'Projects and clients', 'Times, tags and done state', 'Repeating tasks keep repeating', 'Re-import updates, never duplicates'];
  return (
    <section className="lp-section lp-import" id="import">
      <div className="lp-wrap lp-split">
        <Reveal className="lp-split-copy">
          <span className="lp-eyebrow">Moving from Teamweek?</span>
          <h2>Bring your whole history along.</h2>
          <p>Drop in a Teamweek export and your planning is back where you left it, with the details intact.</p>
          <ul className="lp-checks">
            {points.map((p) => (
              <li key={p}>
                <Tick />
                {p}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={120}>
          <ImportCard />
        </Reveal>
      </div>
    </section>
  );
}

// --- Page ----------------------------------------------------------------------------------------------

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const signedIn = !!getMe()?.user;
  const accounts = getMe() !== null;
  useEffect(() => {
    document.title = 'PrepWeek: plan your team’s weeks at a glance';
    const on = () => setScrolled(scrollY > 8);
    on();
    addEventListener('scroll', on, { passive: true });
    return () => removeEventListener('scroll', on);
  }, []);

  return (
    <div className="lp">
      <nav className={'lp-nav' + (scrolled ? ' scrolled' : '')}>
        <div className="lp-wrap lp-nav-inner">
          <a className="lp-brand" href="/welcome" aria-label="PrepWeek home">
            <Logo size={24} />
            PrepWeek
          </a>
          <span className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#import">Import</a>
            <a href="/s/demo">Demo</a>
          </span>
          <span className="lp-nav-actions">
            {signedIn ? (
              <a className="lp-btn primary" href="/">
                Open PrepWeek
              </a>
            ) : (
              <>
                {accounts && (
                  <button className="lp-btn ghost" onClick={() => setSigningIn(true)}>
                    Log in
                  </button>
                )}
                <button className="lp-btn primary" onClick={startPlanning}>
                  Start planning
                </button>
              </>
            )}
          </span>
        </div>
      </nav>

      <Hero />
      <Features />
      <Steps />
      <Import />

      <section className="lp-section lp-final">
        <div className="lp-wrap">
        <Reveal className="lp-final-inner">
          <div className="lp-final-glow" aria-hidden />
          <h2>Plan next week in the next five minutes.</h2>
          <p>No account needed to start. Sign up when you want to keep your plan and invite the team.</p>
          <div className="lp-ctas">
            <button className="lp-btn primary big" onClick={startPlanning}>
              Start planning
              <Arrow />
            </button>
            <a className="lp-btn ghost big" href="/s/demo">
              Try the demo
            </a>
          </div>
        </Reveal>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-inner">
          <span className="lp-brand small">
            <Logo size={20} />
            PrepWeek
          </span>
          <span className="lp-dim">Made for teams who plan in weeks.</span>
          <span className="lp-foot-links">
            <a href="/s/demo">Demo</a>
            {accounts && !signedIn && (
              <button className="lp-link" onClick={() => setSigningIn(true)}>
                Log in
              </button>
            )}
            <span className="lp-dim">© {new Date().getFullYear()} PrepWeek</span>
          </span>
        </div>
      </footer>

      {signingIn && (
        <Suspense fallback={null}>
          <SignInDialog onClose={() => setSigningIn(false)} />
        </Suspense>
      )}
    </div>
  );
}
