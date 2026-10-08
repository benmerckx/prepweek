// Shown when the plan has no room for another person.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { getMe } from '../data/account.ts';
import { PlansDialog } from './PlansDialog.tsx';
import { peopleLimit } from '../data/plan.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Close } from '../ui/icons.tsx';

export function PlanDialog({ onClose }: { onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const p = peopleLimit();
  const [plans, setPlans] = useState(false);
  const admin = !!p.workspace && getMe()?.workspaces.find((w) => w.id === p.workspace!.id)?.role === 'admin';
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share plan-modal" role="dialog" aria-label="Plan full">
        <header className="modal-head">
          <h2>
            {p.name} covers {p.limit} people
          </h2>
          <button className="tb-search-btn" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </header>
        <div className="share-body">
          <p className="share-note">
            {p.workspace ? <b>{p.workspace.name}</b> : 'This plan'} has {p.used} people planned, the most {p.name} covers. Everyone can still sign
            in, comment and plan; this only counts the rows of people you plan for.
          </p>
          <ul className="cal-how">
            <li>
              <b>Plan for more people:</b> Team covers 15, Studio 40, Agency 100. Or press <i>Activate</i> on AppSumo if you have a code.
            </li>
            <li>
              <b>Planning for someone you no longer need?</b> Remove them from the sheet to make room.
            </li>
          </ul>
          <div className="share-actions">
            {admin ? (
              <button className="btn primary" onClick={() => setPlans(true)}>
                See plans
              </button>
            ) : (
              <span className="share-note">Ask an admin of {p.workspace?.name ?? 'the workspace'} to upgrade.</span>
            )}
            <button className="btn" onClick={onClose}>
              Not now
            </button>
          </div>
          {plans && p.workspace && <PlansDialog workspaceId={p.workspace.id} onClose={() => setPlans(false)} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
