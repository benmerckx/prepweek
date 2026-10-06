// The page new visitors see at / (and anyone at /welcome). Every visual is
// built from real elements in the app's own styles (blocks, patterns, the
// scrubber), not screenshots, so it stays sharp at any size and in both
// themes. Animations start when a section scrolls into view and are off for
// people who prefer reduced motion.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getMe, lastSheet, mySheets, newSheetId, rememberMySheet } from '../data/account.ts';
import { Logo } from '../ui/icons.tsx';
import { loadChunk } from '../lib/chunks.ts';

// After a deploy the old chunk is gone: reload into a page that reopens sign-in.
const SignInDialog = lazy(() => loadChunk(() => import('../timeline/Account.tsx'), '/?signin').then((m) => ({ default: m.SignInDialog })));

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

/**
 * Who's looking: a first visit, someone who already plans on this device, or
 * someone signed in. The ways in (and their labels) depend on it.
 */
interface Visitor {
  kind: 'new' | 'returning' | 'signedIn';
  name: string;
  avatar: string;
  /** Accounts are available (served by the worker). */
  accounts: boolean;
}
const visitor = (): Visitor => {
  const me = getMe();
  const user = me?.user;
  if (user) return { kind: 'signedIn', name: user.name || user.email, avatar: user.avatar, accounts: true };
  // Planning on this device already (the demo doesn't count).
  const returning = mySheets().length > 0 || ![null, 'demo'].includes(lastSheet());
  return { kind: returning ? 'returning' : 'new', name: '', avatar: '', accounts: me !== null };
};

interface Way {
  label: string;
  caption: ReactNode;
  primary?: boolean;
  href?: string;
  onClick?(): void;
}

/** The ways in, each with a line on what it does: new sheet, demo, log in. */
function WaysIn({ v, onSignIn, big = true }: { v: Visitor; onSignIn(): void; big?: boolean }) {
  const demo: Way = { label: 'Try the demo', href: '/s/demo', caption: 'Play with a sample team. Nothing you change is saved.' };
  const login: Way = { label: 'Log in', onClick: onSignIn, caption: 'Use your account to get to your sheets on any device.' };
  const ways: Way[] =
    v.kind === 'signedIn'
      ? [
          {
            label: 'Open PrepWeek',
            primary: true,
            href: '/app',
            caption: (
              <>
                {v.avatar ? <img className="lp-way-face" src={v.avatar} alt="" referrerPolicy="no-referrer" /> : null}
                Signed in as {v.name}
              </>
            ),
          },
          demo,
        ]
      : v.kind === 'returning'
        ? [{ label: 'Continue planning', primary: true, href: '/app', caption: 'Back to the sheet you last had open on this device.' }, ...(v.accounts ? [login] : []), demo]
        : [{ label: 'Start planning', primary: true, onClick: startPlanning, caption: 'A fresh sheet, right away. No account needed.' }, demo, ...(v.accounts ? [{ ...login, caption: 'Already using PrepWeek? Get back to your sheets.' }] : [])];
  return (
    <div className="lp-ways">
      {ways.map((w) => {
        const cls = 'lp-btn ' + (w.primary ? 'primary' : 'ghost') + (big ? ' big' : '');
        const body = (
          <>
            {w.label}
            {w.primary && <Arrow />}
          </>
        );
        return (
          <div key={w.label} className={'lp-way' + (w.primary ? ' primary' : '')}>
            {w.href ? (
              <a className={cls} href={w.href}>
                {body}
              </a>
            ) : (
              <button className={cls} onClick={w.onClick}>
                {body}
              </button>
            )}
            <span className="lp-way-caption">{w.caption}</span>
          </div>
        );
      })}
    </div>
  );
}

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
      { lane: 1, col: 1, span: 1, title: 'Workshop', meta: '1d', color: C.cyan, pattern: 'dots' },
      { lane: 1, col: 6, span: 2, title: 'Q4 planning', meta: '2d', color: C.violet, pattern: 'rings' },
    ],
  },
  {
    name: 'Noah Goossens',
    color: C.green,
    load: 1,
    blocks: [
      { lane: 0, col: 0, span: 4, title: 'API v3', meta: 'Initech · 4d', color: C.amber },
      { lane: 0, col: 5, span: 3, title: 'Billing revamp', meta: '3d', color: C.orange, role: 'stretch' },
      { lane: 1, col: 2, span: 1, title: 'Code review', meta: '1d', color: C.green, pattern: 'triangles' },
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
      { lane: 1, col: 8, span: 2, title: 'Security audit', meta: '2d', color: C.amber, pattern: 'triangles' },
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

/** Flat, colorful blocks around the hero copy (wide screens). */
const FLOATERS: { title: string; meta: string; color: string; pattern?: string; w: number; pos: CSSProperties }[] = [
  { title: 'Kickoff', meta: 'Mon', color: C.blue, w: 132, pos: { top: 120, left: '6%' } },
  { title: 'Holiday', meta: '5d', color: C.pink, pattern: 'stripes', w: 170, pos: { top: 250, left: '3%' } },
  { title: 'Review', meta: '1d', color: C.amber, pattern: 'rings', w: 104, pos: { top: 390, left: '9%' } },
  { title: 'Launch', meta: 'Fri', color: C.green, pattern: 'zigzag', w: 120, pos: { top: 104, right: '7%' } },
  { title: 'Workshop', meta: '2d', color: C.violet, pattern: 'dots', w: 156, pos: { top: 236, right: '3%' } },
  { title: 'Stand-up', meta: '9:30', color: C.cyan, pattern: 'waves', w: 118, pos: { top: 378, right: '10%' } },
];

function Hero({ v, onSignIn }: { v: Visitor; onSignIn(): void }) {
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
      <div className="lp-floaters" aria-hidden>
        {FLOATERS.map((f, i) => (
          <div key={f.title} className="lp-floater" style={{ ...f.pos, width: f.w, ['--i' as string]: i } as CSSProperties}>
            <Block title={f.title} meta={f.meta} color={f.color} pattern={f.pattern} />
          </div>
        ))}
      </div>
      <div className="lp-wrap lp-hero-copy">
        <a className="lp-pill lp-in" href="#import" style={{ ['--d' as string]: '0ms' }}>
          <span className="lp-pill-dot" />
          Coming from Teamweek? Import in one go
          <Arrow />
        </a>
        <h1 className="lp-in" style={{ ['--d' as string]: '60ms' }}>
          Your team’s weeks, <br className="lp-br" />
          <span className="lp-accent">at a glance.</span>
        </h1>
        <p className="lp-lede lp-in" style={{ ['--d' as string]: '120ms' }}>
          PrepWeek is a fast, visual planner for teams. Drag work onto people, stretch it across days, and everyone sees the change the
          moment you make it.
        </p>
        <div className="lp-in" style={{ ['--d' as string]: '180ms' }}>
          <WaysIn v={v} onSignIn={onSignIn} />
        </div>
        <p className="lp-note lp-in" style={{ ['--d' as string]: '240ms' }}>
          <span>
            <Tick /> Great on mobile
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

function Card({ title, text, children, className = '', delay = 0, tint }: { title: string; text: string; children: ReactNode; className?: string; delay?: number; tint: string }) {
  return (
    <Reveal className={'lp-card ' + className} delay={delay}>
      <div className="lp-card-visual" style={{ ['--tint' as string]: tint }}>
        {children}
      </div>
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
            <Block title="Review" meta="1d" color={C.violet} pattern="triangles" style={{ gridColumn: '5 / span 1' }} />
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
  { name: 'Billing revamp', client: 'Initech', color: C.orange, pattern: 'zigzag', tasks: 31, days: '48d' },
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
          <span className="lp-eyebrow" style={{ ['--c' as string]: C.blue }}>Everything in one view</span>
          <h2>Planning that keeps up with your team.</h2>
          <p>For studios, agencies and product teams who plan people, not tickets.</p>
        </Reveal>
        <div className="lp-bento">
          <Card className="wide" tint={C.blue} title="Drag, stretch, done" text="Move work between people and days with one drag. Blocks pack themselves into lanes, so nothing hides behind anything else.">
            <DragVisual />
          </Card>
          <Card tint={C.pink} title="Live, together" text="See who is looking at what. Edits, comments and @mentions reach everyone on the sheet instantly." delay={80}>
            <LiveVisual />
          </Card>
          <Card tint={C.amber} title="Months at a glance" text="The scrubber charts your team’s workload. Filter on a project and its busy weeks light up." delay={0}>
            <ScrubVisual />
          </Card>
          <Card tint={C.red} title="Projects and clients" text="Every project gets a color and a pattern, and its own page with people, dates and notes." delay={80}>
            <ProjectsVisual />
          </Card>
          <Card tint={C.green} title="Offline first" text="Your plan lives on your device. Keep planning on the train; it syncs the moment you’re back." delay={160}>
            <OfflineVisual />
          </Card>
          <Card tint={C.cyan} title="Set it once" text="Weekly stand-ups, monthly reviews, yearly renewals. Repeating work fills itself in." delay={0}>
            <RepeatVisual />
          </Card>
          <Card tint={C.violet} title="Notes that format themselves" text="Type / for headings and lists, or select text to style it. Mention a teammate and they’ll know." delay={80}>
            <NotesVisual />
          </Card>
          <Card tint={C.slate} title="Everything from the keyboard" text="Press ⌘K to jump to a person, filter on a project or run any command." delay={160}>
            <PaletteVisual />
          </Card>
        </div>
      </div>
    </section>
  );
}

// --- Mobile ------------------------------------------------------------------------------------------

const PHONE_ROWS: { name: string; color: string; blocks: { col: number; span: number; title: string; meta: string; color: string; pattern?: string; role?: 'drag' | 'tap'; done?: boolean }[] }[] = [
  { name: 'Ava Peeters', color: C.blue, blocks: [{ col: 0, span: 2, title: 'Brand refresh', meta: '2d', color: C.red }, { col: 3, span: 2, title: 'Website', meta: '2d', color: C.blue, role: 'tap' }] },
  { name: 'Noah Goossens', color: C.green, blocks: [{ col: 0, span: 3, title: 'API v3', meta: '3d', color: C.amber }] },
  { name: 'Mila Mertens', color: C.red, blocks: [{ col: 1, span: 1, title: 'Interviews', meta: '1d', color: C.violet, pattern: 'dots', role: 'drag' }, { col: 3, span: 2, title: 'Holiday', meta: '2d', color: C.pink, pattern: 'stripes' }] },
  { name: 'Lucas Janssens', color: C.amber, blocks: [{ col: 0, span: 1, title: 'Support', meta: '1d', color: C.lime, done: true }, { col: 2, span: 3, title: 'Data migration', meta: '3d', color: C.cyan }] },
  { name: 'Emma Wouters', color: C.violet, blocks: [{ col: 1, span: 3, title: 'Analytics', meta: '3d', color: C.cyan, pattern: 'waves' }] },
  { name: 'Sem Goossens', color: C.cyan, blocks: [{ col: 0, span: 2, title: 'Onboarding', meta: '2d', color: C.violet }, { col: 3, span: 1, title: 'Review', meta: '1d', color: C.orange, pattern: 'zigzag' }] },
  { name: 'Lotte Peeters', color: C.pink, blocks: [{ col: 2, span: 3, title: 'Mobile app', meta: '3d', color: C.green }] },
];

function Phone() {
  return (
    <div className="lp-phone" role="img" aria-label="PrepWeek on a phone: a block is moved with a long press, then tapping another opens its details in a sheet from the bottom.">
      <div className="lp-phone-screen">
        <div className="lp-phone-status">
          <b>9:41</b>
          <span className="lp-phone-island" />
          <span className="lp-phone-icons">
            <i />
            <i />
            <i className="bat" />
          </span>
        </div>
        <div className="lp-phone-bar">
          <b>
            Q4 roadmap
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 6.25 8 10l4-3.75" />
            </svg>
          </b>
          <span className="lp-phone-today">Today</span>
          <span className="lp-phone-btn">⋯</span>
        </div>
        <div className="lp-phone-head">
          <span />
          {['Mo 12', 'Tu 13', 'We 14', 'Th 15', 'Fr 16'].map((d, i) => (
            <span key={d} className={i === 0 ? 'today' : ''}>
              <small>{d.slice(0, 2)}</small>
              <b>{d.slice(3)}</b>
            </span>
          ))}
        </div>
        <div className="lp-phone-rows">
          <span className="lp-phone-todaycol" />
          {PHONE_ROWS.map((r) => (
            <div key={r.name} className="lp-phone-row">
              <Avatar name={r.name} color={r.color} size={26} />
              <div className="lp-phone-lane">
                {r.blocks.map((b) => (
                  <div
                    key={b.title}
                    className={'lp-phone-slot' + (b.role ? ` lp-phone-${b.role}` : '')}
                    style={{ gridColumn: `${b.col + 1} / span ${b.span}` }}
                  >
                    <Block title={b.title} meta={b.meta} color={b.color} pattern={b.pattern} done={b.done} />
                    {b.role && <span className="lp-touch" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="lp-phone-scrub">
          <Scrubber handle />
        </div>
        <div className="lp-phone-sheet">
          <span className="lp-phone-grab" />
          <b>Website</b>
          <small>Thu 15 – Fri 16 Oct · 2 workdays</small>
          <span className="lp-phone-done">
            <i /> Mark as done
          </span>
          <span className="lp-phone-field">
            <span className="pattern-swatch chip" data-pattern="dots" style={{ ['--c' as string]: C.blue }} /> Website relaunch · Acme
          </span>
          <span className="lp-phone-swatches">
            {[C.blue, C.green, C.red, C.amber, C.violet, C.cyan, C.pink].map((c, i) => (
              <i key={c} className={i === 0 ? 'on' : ''} style={{ background: c }} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

function Mobile() {
  const points = [
    ['Pinch to zoom', 'from a few days to a whole quarter'],
    ['Press and hold', 'to pick up a block and move it'],
    ['Edit in a sheet', 'that slides up under your thumb'],
    ['Install it', 'on your home screen; it works offline'],
  ];
  return (
    <section className="lp-section lp-mobile" id="mobile">
      <div className="lp-wrap lp-split">
        <Reveal className="lp-mobile-stage">
          <div className="lp-mobile-backdrop" aria-hidden />
          <Phone />
        </Reveal>
        <Reveal className="lp-split-copy" delay={100}>
          <span className="lp-eyebrow" style={{ ['--c' as string]: C.green }}>On your phone</span>
          <h2>The whole plan, in your pocket.</h2>
          <p>
            Built for small screens, not squeezed onto them. See who is on what from the train, and move things the moment plans
            change.
          </p>
          <ul className="lp-mobile-points">
            {points.map(([b, t]) => (
              <li key={b}>
                <b>{b}</b> {t}
              </li>
            ))}
          </ul>
        </Reveal>
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
          <span className="lp-eyebrow" style={{ ['--c' as string]: C.amber }}>Getting started</span>
          <h2>Planned before your coffee cools.</h2>
        </Reveal>
        <ol className="lp-steps">
          {steps.map((s, i) => (
            <Reveal key={s.n} as="li" className="lp-step" delay={i * 90}>
              <span className="lp-step-n" style={{ ['--c' as string]: [C.blue, C.amber, C.green][i] }}>
                {s.n}
              </span>
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
        <Block title="SLA renewal" meta="Imec · 1d" color={C.amber} pattern="triangles" />
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
          <span className="lp-eyebrow" style={{ ['--c' as string]: C.pink }}>Moving from Teamweek?</span>
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
  const [signingIn, setSigningIn] = useState(() => new URLSearchParams(location.search).has('signin'));
  const v = visitor();
  const signIn = () => setSigningIn(true);
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
          <a className="lp-brand" href="/" aria-label="PrepWeek home">
            <Logo size={24} />
            PrepWeek
          </a>
          <span className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#mobile">Mobile</a>
            <a href="#import">Import</a>
            <a href="/s/demo">Demo</a>
          </span>
          <span className="lp-nav-actions">
            {v.kind === 'signedIn' ? (
              <a className="lp-btn primary" href="/app" title={`Signed in as ${v.name}`}>
                {v.avatar ? <img className="lp-nav-face" src={v.avatar} alt="" referrerPolicy="no-referrer" /> : null}
                Open PrepWeek
                <Arrow />
              </a>
            ) : (
              <>
                {v.accounts && (
                  <button className="lp-btn ghost" onClick={signIn}>
                    Log in
                  </button>
                )}
                {v.kind === 'returning' ? (
                  <a className="lp-btn primary" href="/app">
                    Continue planning
                    <Arrow />
                  </a>
                ) : (
                  <button className="lp-btn primary" onClick={startPlanning}>
                    Start planning
                  </button>
                )}
              </>
            )}
          </span>
        </div>
      </nav>

      <Hero v={v} onSignIn={signIn} />
      <Features />
      <Mobile />
      <Steps />
      <Import />

      <section className="lp-section lp-final">
        <div className="lp-wrap">
        <Reveal className="lp-final-inner">

          <h2>Plan next week in the next five minutes.</h2>
          <WaysIn v={v} onSignIn={signIn} />
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
            <a href="/app">Open the app</a>
            {v.accounts && v.kind !== 'signedIn' && (
              <button className="lp-link" onClick={signIn}>
                Log in
              </button>
            )}
            <span className="lp-dim">© {new Date().getFullYear()} PrepWeek</span>
          </span>
        </div>
      </footer>

      {signingIn && (
        <Suspense fallback={null}>
          <SignInDialog next="/app" onClose={() => setSigningIn(false)} />
        </Suspense>
      )}
    </div>
  );
}
