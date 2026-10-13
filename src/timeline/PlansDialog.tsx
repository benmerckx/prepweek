// Choosing a paid plan for a workspace, or switching it. Paying happens in
// the dialog itself: our own order summary beside Paddle's inline checkout
// (its fields and buttons are styled in Paddle > Checkout > Checkout
// configuration > Styling; see docs/BILLING.md).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getMe, loadMe } from '../data/account.ts';
import { reloadAccess } from '../data/access.ts';
import { FREE_PEOPLE, PAID_PLANS, PLAN_INCLUDES } from '../lib/plans.ts';
import { getTheme } from '../lib/theme.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Check, ChevronLeft, ChevronRight, Close } from '../ui/icons.tsx';

const CURRENCY = '€';

type Checkout = {
  transactionId: string;
  token: string;
  sandbox: boolean;
  email: string;
};
/** What Paddle.js tells us about the checkout as it loads and changes. */
type CheckoutData = {
  currency_code?: string;
  items?: { product?: { name?: string }; price_name?: string; billing_cycle?: { interval: string; frequency: number } | null }[];
  totals?: { subtotal: number; discount: number; tax: number; total: number };
  recurring_totals?: { total: number } | null;
};
/** What switching would cost (worker/billing.ts), in currency units. */
type SwitchPreview = { currency: string; charge: number; credit: number; next: number; nextAt: number };
type PaddleEvent = { name?: string; data?: CheckoutData };
type PaddleJs = {
  Environment: { set(env: string): void };
  Initialize(o: { token: string; eventCallback?(e: PaddleEvent): void }): void;
  Checkout: { open(o: Record<string, unknown>): void; close(): void };
};

let paddle: Promise<PaddleJs> | null = null;
/** Paddle.js, loaded the first time someone checks out. */
const loadPaddle = (c: Checkout) =>
  (paddle ??= new Promise<PaddleJs>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    s.onload = () => {
      const P = (window as unknown as { Paddle: PaddleJs }).Paddle;
      if (c.sandbox) P.Environment.set('sandbox');
      P.Initialize({
        token: c.token,
        eventCallback: (e) => window.dispatchEvent(new CustomEvent<PaddleEvent>('prepweek:checkout', { detail: e })),
      });
      resolve(P);
    };
    s.onerror = () => {
      paddle = null;
      reject(new Error('Couldn’t load the checkout. Is something blocking cdn.paddle.com?'));
    };
    document.head.append(s);
  }));

/**
 * `pick` and `initialInterval`: from the home page's pricing, the plan
 * clicked and its period. `choose`: workspaces to pick from (the home page
 * doesn't know which one you mean when you're admin of several).
 */
export function PlansDialog({
  workspaceId: initialWorkspace,
  onClose,
  pick,
  initialInterval = 'year',
  choose,
}: {
  workspaceId: string;
  onClose(): void;
  pick?: string;
  initialInterval?: 'month' | 'year';
  choose?: { id: string; name: string }[];
}) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const ws = getMe()?.workspaces.find((w) => w.id === workspaceId);
  const paid = ws?.plan?.paid && ['active', 'trialing', 'past_due'].includes(ws.plan.paid.status) ? ws.plan.paid : null;
  const [interval, setInterval] = useState<'month' | 'year'>(initialInterval);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Paying: the plan picked, then what Paddle reports (totals, tax).
  const [paying, setPaying] = useState<(Checkout & { plan: string; interval: 'month' | 'year' }) | null>(null);
  const [data, setData] = useState<CheckoutData | null>(null);
  const payingRef = useRef(paying);
  payingRef.current = paying;
  // After paying: 'checking' until the plan is on the workspace, 'active'
  // once it is, 'late' if Paddle hasn't confirmed it yet.
  const [paidNow, setPaidNow] = useState<'' | 'checking' | 'active' | 'late'>('');
  /** Ask the server to look the payment up at Paddle (the webhook may be late). */
  const sync = async (transactionId?: string) => {
    const r = await api<{ plan: string | null }>('POST', '/api/billing/sync', { workspaceId, transactionId });
    if (r.plan) {
      await loadMe();
      await reloadAccess();
    }
    return !!r.plan;
  };
  useEffect(() => {
    const on = (e: Event) => {
      const { name, data } = (e as CustomEvent<PaddleEvent>).detail;
      if (name === 'checkout.closed') setBusy('');
      if (data && (name === 'checkout.loaded' || name === 'checkout.updated')) setData(data);
      if (name === 'checkout.completed') {
        setPaidNow('checking');
        const id = (data as { transaction_id?: string } | undefined)?.transaction_id ?? payingRef.current?.transactionId;
        // Paddle settles the payment a moment after the form says thanks.
        void (async () => {
          for (const ms of [0, 2000, 5000, 10000]) {
            await new Promise((r) => setTimeout(r, ms));
            if (await sync(id).catch(() => false)) return setPaidNow('active');
          }
          setPaidNow('late');
        })();
      }
    };
    window.addEventListener('prepweek:checkout', on);
    return () => window.removeEventListener('prepweek:checkout', on);
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // On a free workspace, a payment Paddle has but we missed shows up here.
  useEffect(() => {
    if (!paid) void sync().catch(() => {});
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The inline checkout goes into its frame once that's on the page.
  useEffect(() => {
    if (!paying) return;
    let open = true;
    loadPaddle(paying)
      .then((P) => {
        if (!open) return;
        P.Checkout.open({
          transactionId: paying.transactionId,
          customer: { email: paying.email },
          settings: {
            displayMode: 'inline',
            frameTarget: 'checkout-frame',
            frameInitialHeight: 450,
            frameStyle: 'width: 100%; min-width: 286px; background-color: transparent; border: none;',
            variant: 'one-page',
            theme: getTheme(),
            allowLogout: false,
            showAddDiscounts: false,
          },
        });
        setBusy('');
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setPaying(null);
        setBusy('');
      });
    return () => {
      open = false;
      void paddle?.then((P) => P.Checkout.close()).catch(() => {});
    };
  }, [paying]);

  // Switching a paid plan: what Paddle will charge, to confirm; then done.
  const [switching, setSwitching] = useState<{ plan: string; interval: 'month' | 'year'; preview: SwitchPreview; done?: boolean } | null>(null);
  const go = async (path: 'checkout' | 'portal', plan?: string, confirmed = false) => {
    setBusy(plan ?? path);
    setError('');
    try {
      const preview = path === 'checkout' && !!paid && !confirmed;
      const r = await api<{ url?: string; switched?: boolean; preview?: SwitchPreview } & Partial<Checkout>>('POST', `/api/billing/${path}`, {
        workspaceId,
        plan,
        interval: switching && confirmed ? switching.interval : interval,
        preview,
      });
      if (r.url) location.href = r.url;
      else if (r.preview) {
        setSwitching({ plan: plan!, interval, preview: r.preview });
        setBusy('');
      } else if (r.transactionId) {
        setData(null);
        setPaying({ ...(r as Checkout), plan: plan!, interval });
      } else {
        await loadMe();
        await reloadAccess();
        if (switching) {
          setSwitching({ ...switching, done: true });
          setBusy('');
        } else onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  };

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal plans-modal' + (paying ? ' paying' : '')} role="dialog" aria-label={paying ? 'Checkout' : 'Plans'}>
        <header className="modal-head">
          {choose && choose.length > 1 ? (
            <h2 className="plans-for">
              Plans for{' '}
              <select value={workspaceId} onChange={(e) => setWorkspaceId(e.currentTarget.value)} aria-label="Workspace">
                {choose.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </h2>
          ) : paying || switching ? (
            <h2 className="checkout-title">
              <button
                className="tb-search-btn"
                aria-label="Back to the plans"
                disabled={!!paidNow || !!switching?.done || !!busy}
                onClick={() => (setPaying(null), setSwitching(null), setError(''))}
              >
                <ChevronLeft />
              </button>
              {switching ? 'Switch plan' : 'Checkout'}
            </h2>
          ) : (
            <h2>Plans for {ws?.name ?? 'this workspace'}</h2>
          )}
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        {switching ? (
          <SwitchStep
            switching={switching}
            from={PAID_PLANS.find((p) => p.id === paid?.plan)?.name}
            busy={!!busy}
            error={error}
            onConfirm={() => void go('checkout', switching.plan, true)}
            onCancel={() => (setSwitching(null), setError(''))}
            onClose={onClose}
          />
        ) : paying ? (
          paidNow ? (
            <PaidStep state={paidNow} plan={paying.plan} onClose={onClose} />
          ) : (
            <CheckoutStep paying={paying} data={data} workspace={ws?.name} />
          )
        ) : (
        <div className="share-body">
          <p className="share-note">
            You pay for the people you plan for. Logins, sheets and every feature are unlimited on every plan; the free plan covers {FREE_PEOPLE} people.
          </p>
          <div className="kind-seg plans-interval" role="radiogroup" aria-label="Billing period">
            <button
              type="button"
              role="radio"
              aria-checked={interval === 'month'}
              className={interval === 'month' ? 'on' : ''}
              onClick={() => setInterval('month')}
            >
              Monthly
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={interval === 'year'}
              className={interval === 'year' ? 'on' : ''}
              onClick={() => setInterval('year')}
            >
              Yearly · 2 months free
            </button>
          </div>
          <div className="plans">
            {PAID_PLANS.map((p) => {
              const current = paid?.plan === p.id;
              return (
                <div key={p.id} className={'plan-card' + (current ? ' current' : pick === p.id ? ' picked' : '')}>
                  <b>{p.name}</b>
                  <span className="plan-people">{p.people} people</span>
                  <span className="plan-price">
                    {CURRENCY}
                    {interval === 'year' ? p.year : p.month}
                    <small>/{interval}</small>
                  </span>
                  {current ? (
                    <span className="plan-current">
                      <Check size={13} /> Your plan
                    </span>
                  ) : (
                    <button className="btn primary" disabled={!!busy} onClick={() => void go('checkout', p.id)}>
                      {busy === p.id ? 'One moment…' : paid ? `Switch to ${p.name}` : `Choose ${p.name}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {error && <p className="editor-error">{error}</p>}
          <div className="share-actions">
            {paid && (
              <button className="btn" disabled={!!busy} onClick={() => void go('portal')}>
                Invoices, card and cancelling
              </button>
            )}
          </div>
          <p className="share-foot">
            Payments by Paddle, our reseller: they handle VAT and invoices. Cancel any time; the plan stays until the end of the period you paid for.
          </p>
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const money = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0 }).format(n);

/**
 * Paying for a plan: what you're buying and what it costs (from Paddle, so
 * the tax for your country shows once it's known), beside Paddle's form.
 */
function CheckoutStep({
  paying,
  data,
  workspace,
}: {
  paying: { plan: string; interval: 'month' | 'year' };
  data: CheckoutData | null;
  workspace?: string;
}) {
  const plan = PAID_PLANS.find((p) => p.id === paying.plan)!;
  const listed = paying.interval === 'year' ? plan.year : plan.month;
  const cur = data?.currency_code ?? 'EUR';
  const t = data?.totals;
  const renews = new Date();
  if (paying.interval === 'year') renews.setFullYear(renews.getFullYear() + 1);
  else renews.setMonth(renews.getMonth() + 1);
  return (
    <div className="checkout">
      <aside className="checkout-summary">
        <span className="checkout-kicker">{workspace ? `For ${workspace}` : 'Your plan'}</span>
        <div className="checkout-plan">
          <b>Prepweek {plan.name}</b>
          <span>
            Up to {plan.people} people · billed {paying.interval === 'year' ? 'yearly' : 'monthly'}
          </span>
        </div>
        <ul className="checkout-includes">
          {PLAN_INCLUDES.slice(0, 4).map((x) => (
            <li key={x}>
              <Check size={13} /> {x}
            </li>
          ))}
        </ul>
        <dl className="checkout-totals">
          {t ? (
            <>
              <div>
                <dt>Subtotal</dt>
                <dd>{money(t.subtotal, cur)}</dd>
              </div>
              {t.discount > 0 && (
                <div>
                  <dt>Discount</dt>
                  <dd>−{money(t.discount, cur)}</dd>
                </div>
              )}
              <div>
                <dt>VAT</dt>
                <dd>{money(t.tax, cur)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>VAT</dt>
              <dd className="dim">Included, by country</dd>
            </div>
          )}
          <div className="checkout-total">
            <dt>Due today</dt>
            <dd>{money(t ? t.total : listed, cur)}</dd>
          </div>
        </dl>
        <p className="checkout-note">
          Renews on {renews.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} at{' '}
          {money(data?.recurring_totals?.total ?? t?.total ?? listed, cur)}. Cancel any time; a <a href="/refunds" target="_blank">refund within 14 days</a>.
        </p>
      </aside>
      <div className="checkout-pay">
        <div className="checkout-frame" />
      </div>
    </div>
  );
}

/** After paying: the plan being switched on, then done. */
function PaidStep({ state, plan, onClose }: { state: 'checking' | 'active' | 'late'; plan: string; onClose(): void }) {
  const name = PAID_PLANS.find((p) => p.id === plan)?.name ?? 'your plan';
  return (
    <div className="share-body checkout-done">
      <span className="checkout-done-mark">
        <Check size={22} />
      </span>
      <h3>{state === 'active' ? `You’re on ${name}` : 'Thanks for your payment'}</h3>
      <p>
        {state === 'checking'
          ? 'Switching the workspace to its new plan…'
          : state === 'active'
            ? 'Everyone in the workspace has the new plan now. Invoices, your card and cancelling are under Plan and billing.'
            : 'Paddle hasn’t confirmed it to us yet. It usually takes under a minute; the plan switches on by itself, and reopening Plans checks again.'}
      </p>
      <p className="checkout-receipt">A receipt is on its way to your inbox from Paddle.</p>
      <button className="btn primary" disabled={state === 'checking'} onClick={onClose}>
        {state === 'checking' ? 'One moment…' : 'Done'}
      </button>
    </div>
  );
}

/** Switching a paid plan: what it costs now and later, to confirm; then done. */
function SwitchStep({
  switching: { plan, interval, preview, done },
  from,
  busy,
  error,
  onConfirm,
  onCancel,
  onClose,
}: {
  switching: { plan: string; interval: 'month' | 'year'; preview: SwitchPreview; done?: boolean };
  from?: string;
  busy: boolean;
  error: string;
  onConfirm(): void;
  onCancel(): void;
  onClose(): void;
}) {
  const p = PAID_PLANS.find((x) => x.id === plan)!;
  const cur = preview.currency;
  const when = preview.nextAt ? new Date(preview.nextAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const now = preview.charge
    ? `${money(preview.charge, cur)} is charged now to the card Paddle has on file: the new plan for the rest of this period, less what’s left of ${from ?? 'your plan'}.`
    : preview.credit
      ? `What’s left of ${from ?? 'your plan'} is worth more than the rest of this period on ${p.name}: ${money(preview.credit, cur)} goes to your balance and comes off the next bills.`
      : 'Nothing is charged now.';
  if (done)
    return (
      <div className="share-body checkout-done">
        <span className="checkout-done-mark">
          <Check size={22} />
        </span>
        <h3>You’re on {p.name}</h3>
        <p>{preview.charge ? `${money(preview.charge, cur)} was charged; the receipt comes from Paddle.` : preview.credit ? `${money(preview.credit, cur)} was added to your balance.` : 'Nothing was charged.'}</p>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    );
  return (
    <div className="share-body switch-step">
      <div className="switch-plans">
        <span>{from ?? 'Your plan'}</span>
        <ChevronRight />
        <b>
          {p.name} · {p.people} people · {interval === 'year' ? 'yearly' : 'monthly'}
        </b>
      </div>
      <dl className="checkout-totals">
        <div className="checkout-total">
          <dt>{preview.credit ? 'Credit now' : 'Due now'}</dt>
          <dd>{money(preview.credit || preview.charge, cur)}</dd>
        </div>
        {preview.next > 0 && (
          <div>
            <dt>Then{when ? `, from ${when}` : ''}</dt>
            <dd>
              {money(preview.next, cur)}/{interval}
            </dd>
          </div>
        )}
      </dl>
      <p className="share-note">{now}</p>
      {error && <p className="editor-error">{error}</p>}
      <div className="share-actions">
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Switching…' : preview.charge ? `Pay ${money(preview.charge, cur)} and switch` : 'Switch plan'}
        </button>
      </div>
    </div>
  );
}
