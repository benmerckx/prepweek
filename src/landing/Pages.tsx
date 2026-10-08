// Small public pages around the home page: redeeming an AppSumo licence,
// help, and the roadmap. Same look as the home page (landing.css).

import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { getMe } from "../data/account.ts";
import { APPSUMO_TIERS, FREE_PEOPLE, type PlanInfo } from "../lib/plans.ts";
import { loadChunk } from "../lib/chunks.ts";
import { Logo, Wordmark } from "../ui/brand.tsx";

const SignInDialog = lazy(() =>
  loadChunk(() => import("../timeline/Account.tsx")).then((m) => ({
    default: m.SignInDialog,
  })),
);

/** Where questions go. */
export const SUPPORT_EMAIL = "support@prepweek.com";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · PrepWeek`;
  }, [title]);
  const signedIn = !!getMe()?.user;
  return (
    <div className="lp lp-page">
      <nav className="lp-nav scrolled">
        <div className="lp-wrap lp-nav-inner">
          <a className="lp-brand" href="/" aria-label="PrepWeek home">
            <Logo size={24} />
            <Wordmark className="lp-brand-name" size={24} />
          </a>
          <span className="lp-nav-links">
            <a href="/#features">Features</a>
            <a href="/help">Help</a>
            <a href="/roadmap">Roadmap</a>
          </span>
          <span className="lp-nav-actions">
            <a className="lp-btn primary" href="/app">
              {signedIn ? "Open PrepWeek" : "Start planning"}
            </a>
          </span>
        </div>
      </nav>
      <main className="lp-wrap lp-page-main">{children}</main>
      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-inner">
          <span className="lp-dim">
            Questions? {<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>}
          </span>
          <span className="lp-foot-links">
            <a href="/help">Help</a>
            <a href="/roadmap">Roadmap</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

// --- AppSumo ------------------------------------------------------------------------------

interface Pending {
  license: {
    key: string;
    tier: number;
    status: string;
    workspace: { id: string; name: string } | null;
  } | null;
  signedIn: boolean;
  workspaces: { id: string; name: string; plan: PlanInfo }[];
}

const TIERS = Object.entries(APPSUMO_TIERS).map(([tier, people]) => ({
  tier: Number(tier),
  people,
}));

export function AppSumoPage() {
  const [state, setState] = useState<Pending | null | "error">(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ name: string; plan: PlanInfo } | null>(
    null,
  );
  const [signingIn, setSigningIn] = useState(false);
  const load = () =>
    fetch("/api/appsumo/pending", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<Pending>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then((p) => {
        setState(p);
        setPick(
          (cur) => cur || p.license?.workspace?.id || p.workspaces[0]?.id || "",
        );
      })
      .catch(() => setState("error"));
  useEffect(() => void load(), []);

  const redeem = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/appsumo/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: pick }),
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        plan?: PlanInfo;
        error?: string;
      };
      if (!res.ok || !data.plan)
        throw new Error(data.error ?? `Something went wrong (${res.status})`);
      setDone({
        name:
          (state as Pending).workspaces.find((w) => w.id === pick)?.name ??
          "Your workspace",
        plan: data.plan,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const p = state && state !== "error" ? state : null;
  const lic = p?.license;
  let body: ReactNode;
  if (state === null) body = <p className="lp-dim">One moment…</p>;
  else if (state === "error")
    body = (
      <p>
        We couldn’t load your licence. Please reload the page, or write to us.
      </p>
    );
  else if (done)
    body = (
      <>
        <h2>You’re all set 🎉</h2>
        <p>
          <b>{done.name}</b> is on {done.plan.name} now: plan for up to{" "}
          {done.plan.limit} people, with as many logins as you like.
        </p>
        <a className="lp-btn primary big" href="/app">
          Open PrepWeek
        </a>
      </>
    );
  else if (!lic)
    body = (
      <>
        <h2>Bought PrepWeek on AppSumo?</h2>
        <ol className="lp-redeem-steps">
          <li>
            Open <b>My products</b> on AppSumo and find PrepWeek.
          </li>
          <li>
            Press <b>Activate</b>. AppSumo sends you back here with your
            licence.
          </li>
          <li>
            Sign in (or make an account with any email) and pick the workspace
            it’s for.
          </li>
        </ol>
      </>
    );
  else if (lic.status === "deactivated")
    body = (
      <>
        <h2>This licence isn’t active</h2>
        <p>
          It was refunded or replaced by an upgrade. If you upgraded, press
          Activate on AppSumo again for the new one.
        </p>
      </>
    );
  else if (!p!.signedIn)
    body = (
      <>
        <h2>Your Tier {lic.tier} licence is ready</h2>
        <p>
          Sign in or create your account to apply it. Any email works; you’ll
          get a sign-in link.
        </p>
        <button
          className="lp-btn primary big"
          onClick={() => setSigningIn(true)}
        >
          Sign in to apply it
        </button>
      </>
    );
  else
    body = (
      <>
        <h2>Apply your Tier {lic.tier} licence</h2>
        <p>
          It covers {APPSUMO_TIERS[lic.tier] ?? APPSUMO_TIERS[1]} planned people
          in one workspace, with unlimited logins and sheets.
          {lic.workspace && (
            <>
              {" "}
              It’s applied to <b>{lic.workspace.name}</b> now; you can move it.
            </>
          )}
        </p>
        {p!.workspaces.length ? (
          <div
            className="lp-redeem-pick"
            role="radiogroup"
            aria-label="Workspace"
          >
            {p!.workspaces.map((w) => (
              <label key={w.id} className={pick === w.id ? "on" : ""}>
                <input
                  type="radio"
                  name="ws"
                  checked={pick === w.id}
                  onChange={() => setPick(w.id)}
                />
                <span>
                  <b>{w.name}</b>
                  <span className="lp-dim">
                    {w.plan.name} · {w.plan.used} of {w.plan.limit} people
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p>
            You aren’t an admin of a workspace yet. Open PrepWeek once to get
            yours, then come back here.
          </p>
        )}
        {error && <p className="lp-redeem-error">{error}</p>}
        <button
          className="lp-btn primary big"
          disabled={busy || !pick}
          onClick={() => void redeem()}
        >
          {busy ? "Applying…" : "Apply licence"}
        </button>
      </>
    );

  return (
    <Shell title="AppSumo">
      <section className="lp-redeem">
        <span className="lp-eyebrow">Welcome, Sumo-lings</span>
        <div className="lp-redeem-card">{body}</div>
        <div className="lp-tiers">
          <div>
            <b>Free</b>
            <span>{FREE_PEOPLE} people</span>
          </div>
          {TIERS.map((t) => (
            <div key={t.tier} className={lic?.tier === t.tier ? "on" : ""}>
              <b>Tier {t.tier}</b>
              <span>{t.people} people</span>
            </div>
          ))}
        </div>
        <p className="lp-dim lp-redeem-note">
          Every tier: unlimited logins and sheets, all features, and every
          update to them. Counts people you plan for, not people who sign in.
        </p>
      </section>
      {signingIn && (
        <Suspense fallback={null}>
          <SignInDialog next="/appsumo" onClose={() => setSigningIn(false)} />
        </Suspense>
      )}
    </Shell>
  );
}

// --- Help ---------------------------------------------------------------------------------

const HELP: { title: string; items: [string, ReactNode][] }[] = [
  {
    title: "Getting started",
    items: [
      [
        "How do I plan something?",
        "Add people with “+ Add person”, then drag across someone’s row to make a block over those days. Click a block to name it and set a project, color, time or notes.",
      ],
      [
        "Do I need an account?",
        "No. Start planning right away; the plan is saved in your browser and has its own address. Sign up to keep it in a workspace, invite your team and use it on all your devices.",
      ],
      [
        "How do I move from Teamweek or Toggl Plan?",
        "Export your tasks as CSV from Teamweek / Toggl Plan (⋯ menu, Export tasks), then in PrepWeek open ⋯ → Import from Teamweek and drop the file. People are matched by email; importing again updates instead of duplicating.",
      ],
    ],
  },
  {
    title: "Planning",
    items: [
      [
        "Can a task be for several people?",
        "Yes: add people in the task’s People field. Everyone gets a block in their row; edits, comments and files are shared.",
      ],
      [
        "How do I plan time off and holidays?",
        "Make a block and set its Type to Time off. For a day off for everyone, add a milestone and switch on “Day off for everyone”. Neither counts as booked.",
      ],
      [
        "How do dependencies work?",
        "In a task, “Waits for” picks the task it comes after. An arrow links them, and when the first one moves later, everything waiting for it moves along.",
      ],
      [
        "Repeating tasks, checklists, times?",
        "All in a task’s details: Repeat (every workday, week, 2 weeks, month or year), a checklist, and a start and end time.",
      ],
    ],
  },
  {
    title: "Teams and sharing",
    items: [
      [
        "How do I invite my team?",
        "Open your avatar menu → People in your workspace, and invite by email. Members see and edit the workspace’s sheets.",
      ],
      [
        "Can I share a view-only link?",
        "Yes: ⋯ → Share… → turn on private links, then copy the view link. Reset links any time to cut off old ones.",
      ],
      [
        "What’s the daily digest?",
        "An email on workday mornings with what’s on your plate and what others changed on your work. Switch it off in your avatar menu, or with the link in any digest.",
      ],
    ],
  },
  {
    title: "Your data",
    items: [
      [
        "Does it work offline?",
        "Yes. Your plan lives on your device and syncs when you’re back online; changes from others merge in.",
      ],
      [
        "Can I get my data out?",
        "⋯ → Export as CSV, any time, in the same columns as the import. ⋯ → Add to your calendar gives a live link for Google, Apple or Outlook.",
      ],
      [
        "Can I undo a mistake?",
        "Yes: ⌘Z / Ctrl+Z undoes your own changes, and the Activity panel shows who changed what.",
      ],
    ],
  },
  {
    title: "Plans and AppSumo",
    items: [
      [
        "What counts as a person?",
        `A row you plan for. Logins are unlimited: anyone can sign in, comment and plan. The free plan covers ${FREE_PEOPLE} people per workspace.`,
      ],
      [
        "How do I redeem my AppSumo code?",
        <>
          Press Activate on AppSumo, sign in, and pick your workspace. Step by
          step on the <a href="/appsumo">AppSumo page</a>.
        </>,
      ],
      [
        "Can I upgrade my AppSumo tier?",
        "Yes, on AppSumo. Press Activate again afterwards if asked; your workspace keeps its data and moves up to the new tier.",
      ],
      [
        "Refunds?",
        "AppSumo purchases are refundable through AppSumo for 60 days. After a refund the workspace returns to the free plan; nothing is deleted.",
      ],
    ],
  },
];

export function HelpPage() {
  return (
    <Shell title="Help">
      <section className="lp-doc">
        <span className="lp-eyebrow">Help</span>
        <h1>Questions, answered</h1>
        <p className="lp-doc-lede">
          Can’t find it here? Write to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>; a person who
          builds PrepWeek answers.
        </p>
        {HELP.map((g) => (
          <div key={g.title} className="lp-faq">
            <h2>{g.title}</h2>
            {g.items.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        ))}
      </section>
    </Shell>
  );
}

// --- Roadmap ------------------------------------------------------------------------------

const ROADMAP: { title: string; note: string; items: [string, string][] }[] = [
  {
    title: "Recently shipped",
    note: "Live now",
    items: [
      [
        "Time off and holidays",
        "Hatched in the timeline, not counted as booked.",
      ],
      [
        "Dependencies",
        "Arrows between tasks; moving one moves what waits for it.",
      ],
      ["Checklists", "On every task, with progress on the block."],
      [
        "Calendar feeds and CSV export",
        "Google, Apple and Outlook; export any time.",
      ],
      ["Several people per task", "A block in each row, one conversation."],
      ["Daily digest", "Your day by email on workday mornings."],
    ],
  },
  {
    title: "Next",
    note: "What we’re working on",
    items: [
      [
        "Hours and capacity",
        "Estimates in hours and each person’s working hours, so “booked” means hours, not just days.",
      ],
      [
        "Public holiday calendars",
        "Pick a country and its holidays fill in by themselves.",
      ],
      ["Templates", "Save a project’s blocks and drop them in again."],
    ],
  },
  {
    title: "Exploring",
    note: "Ideas we’re weighing, not promises",
    items: [
      ["Slack notifications", "Mentions and changes to your work in Slack."],
      ["Reports", "Planned days and hours per person, project and client."],
      [
        "Two-way calendar sync",
        "Meetings from your calendar show up as busy time.",
      ],
      ["API and webhooks", "Connect PrepWeek to your own tools."],
    ],
  },
];

export function RoadmapPage() {
  return (
    <Shell title="Roadmap">
      <section className="lp-doc">
        <span className="lp-eyebrow">Roadmap</span>
        <h1>What’s next for PrepWeek</h1>
        <p className="lp-doc-lede">
          Built in the open, in the order people ask for things. Want something?
          Tell us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
        <div className="lp-road">
          {ROADMAP.map((col) => (
            <div key={col.title} className="lp-road-col">
              <h2>{col.title}</h2>
              <span className="lp-dim">{col.note}</span>
              <ul>
                {col.items.map(([t, d]) => (
                  <li key={t}>
                    <b>{t}</b>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </Shell>
  );
}

// --- Privacy and terms --------------------------------------------------------------------

const UPDATED = "8 October 2026";

function Doc({
  title,
  lede,
  sections,
}: {
  title: string;
  lede: ReactNode;
  sections: [string, ReactNode][];
}) {
  return (
    <Shell title={title}>
      <section className="lp-doc lp-legal">
        <h1>{title}</h1>
        <p className="lp-doc-lede">{lede}</p>
        {sections.map(([h, body]) => (
          <div key={h} className="lp-legal-part">
            <h2>{h}</h2>
            {body}
          </div>
        ))}
        <p className="lp-dim lp-legal-date">Last updated {UPDATED}.</p>
      </section>
    </Shell>
  );
}

export function PrivacyPage() {
  return (
    <Doc
      title="Privacy"
      lede="PrepWeek stores what it needs to run your plan, nothing more. No ads, no trackers, no selling data. Here is exactly what we keep, where, and how to take it out."
      sections={[
        [
          "What we store",
          <ul>
            <li>
              <b>Your account:</b> email address, name and, if you sign in with
              Google, your profile picture.
            </li>
            <li>
              <b>Your plans:</b> everything in your sheets: people, tasks,
              projects, comments, attachments and the activity log.
            </li>
            <li>
              <b>Workspaces:</b> who is in which workspace and with what role,
              and pending invites (the invited email address).
            </li>
            <li>
              <b>Settings:</b> your daily digest choice, your time zone and the
              address you use PrepWeek at.
            </li>
            <li>
              <b>Purchases:</b> an AppSumo licence key, or a Paddle customer and
              subscription reference. Card details stay with Paddle; we never
              see them.
            </li>
          </ul>,
        ],
        [
          "On your device",
          <p>
            Your browser keeps a copy of the sheets you open so PrepWeek works
            offline, plus small preferences (theme, last sheet). We set one
            cookie to keep you signed in, and short-lived ones during Google
            sign-in and AppSumo activation. No analytics or advertising cookies.
            Signing out removes the copies of your workspace’s sheets from that
            device.
          </p>,
        ],
        [
          "Who helps us run it",
          <ul>
            <li>
              <b>Cloudflare</b> hosts PrepWeek and stores your data.
            </li>
            <li>
              <b>Mailchimp Transactional (Mandrill)</b> sends sign-in links,
              invites and the daily digest. We don’t track opens or clicks.
            </li>
            <li>
              <b>Google</b>, only if you choose “Continue with Google”.
            </li>
            <li>
              <b>Paddle</b> (our reseller for subscriptions, who also handles
              VAT and invoices) and <b>AppSumo</b> handle payments.
            </li>
          </ul>,
        ],
        [
          "Your data is yours",
          <p>
            Export everything you have access to at any time (your avatar menu →
            Export my data, or a sheet’s ⋯ menu → Import and export). Delete
            your account from the same menu: workspaces only you are in are
            deleted with their sheets, right away. Deleted sheets are wiped from
            our live storage.
          </p>,
        ],
        [
          "Questions",
          <p>
            Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            PrepWeek isn’t meant for children under 16.
          </p>,
        ],
      ]}
    />
  );
}

export function TermsPage() {
  return (
    <Doc
      title="Terms"
      lede="The short version: use PrepWeek to plan your team’s work, keep it legal, and your plans stay yours."
      sections={[
        [
          "Your account",
          <p>
            You’re responsible for what happens in your account and workspaces.
            Keep your email account safe: it’s how you sign in.
          </p>,
        ],
        [
          "Your content",
          <p>
            Your plans, comments and files belong to you. You give us permission
            to store and process them only to run PrepWeek for you and the
            people you share with. You can export or delete them any time.
          </p>,
        ],
        [
          "Fair use",
          <p>
            Don’t use PrepWeek for anything illegal, to send spam, to upload
            malware, or to break or overload the service. We may suspend
            accounts that do.
          </p>,
        ],
        [
          "Plans and payments",
          <ul>
            <li>
              The free plan covers {FREE_PEOPLE} planned people per workspace.
              Paid plans and AppSumo tiers cover more; logins are always
              unlimited.
            </li>
            <li>
              Subscriptions are sold by our online reseller Paddle.com, the
              merchant of record for these orders. Paddle handles payment, VAT,
              invoices and billing questions; their buyer terms apply to the
              purchase.
            </li>
            <li>
              Subscriptions renew until you cancel; cancelling keeps your plan
              until the end of the period you paid for.
            </li>
            <li>
              Changed your mind? Ask within 14 days of a subscription payment
              and you get it back in full.
            </li>
            <li>
              AppSumo licences are for the lifetime of PrepWeek, with refunds
              through AppSumo within 60 days. After a refund or a lapsed
              subscription the workspace goes back to the free plan; nothing is
              deleted.
            </li>
          </ul>,
        ],
        [
          "The service",
          <p>
            We work hard to keep PrepWeek running and your data safe, but it’s
            provided as is: we can’t promise it will never be down or wrong, and
            we’re not liable for indirect losses. Keep exports of anything you
            can’t afford to lose.
          </p>,
        ],
        [
          "Changes",
          <p>
            If these terms change in a way that matters, we’ll say so in the app
            or by email before it applies.
          </p>,
        ],
        [
          "Contact",
          <p>
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
          </p>,
        ],
      ]}
    />
  );
}
