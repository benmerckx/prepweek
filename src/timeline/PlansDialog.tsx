// Choosing a paid plan for a workspace (Paddle's checkout overlay), or switching it.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getMe, loadMe } from '../data/account.ts';
import { reloadAccess } from '../data/access.ts';
import { FREE_PEOPLE, PAID_PLANS } from '../lib/plans.ts';
import { getTheme } from '../lib/theme.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Check, Close } from '../ui/icons.tsx';

const CURRENCY = '€';

type Checkout = {
  transactionId: string;
  token: string;
  sandbox: boolean;
  email: string;
};
type PaddleJs = {
  Environment: { set(env: string): void };
  Initialize(o: { token: string; eventCallback?(e: { name?: string }): void }): void;
  Checkout: { open(o: Record<string, unknown>): void };
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
        eventCallback: (e) => e.name === 'checkout.closed' && window.dispatchEvent(new Event('prepweek:checkout-closed')),
      });
      resolve(P);
    };
    s.onerror = () => {
      paddle = null;
      reject(new Error('Couldn’t load the checkout. Is something blocking cdn.paddle.com?'));
    };
    document.head.append(s);
  }));

export function PlansDialog({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const ws = getMe()?.workspaces.find((w) => w.id === workspaceId);
  const paid = ws?.plan?.paid && ['active', 'trialing', 'past_due'].includes(ws.plan.paid.status) ? ws.plan.paid : null;
  const [interval, setInterval] = useState<'month' | 'year'>('year');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const closed = () => setBusy('');
    window.addEventListener('prepweek:checkout-closed', closed);
    return () => window.removeEventListener('prepweek:checkout-closed', closed);
  }, []);

  const go = async (path: 'checkout' | 'portal', plan?: string) => {
    setBusy(plan ?? path);
    setError('');
    try {
      const r = await api<{ url?: string; switched?: boolean } & Partial<Checkout>>('POST', `/api/billing/${path}`, { workspaceId, plan, interval });
      if (r.url) location.href = r.url;
      else if (r.transactionId) {
        const P = await loadPaddle(r as Checkout);
        P.Checkout.open({
          transactionId: r.transactionId,
          customer: { email: r.email },
          settings: {
            displayMode: 'overlay',
            theme: getTheme(),
            successUrl: `${location.origin}/app?billing=done`,
          },
        });
      } else {
        await loadMe();
        await reloadAccess();
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  };

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plans-modal" role="dialog" aria-label="Plans">
        <header className="modal-head">
          <h2>Plans for {ws?.name ?? 'this workspace'}</h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
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
                <div key={p.id} className={'plan-card' + (current ? ' current' : '')}>
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
            <a className="link-btn" href="/appsumo">
              Have an AppSumo code?
            </a>
          </div>
          <p className="share-foot">
            Payments by Paddle, our reseller: they handle VAT and invoices. Cancel any time; the plan stays until the end of the period you paid for.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
