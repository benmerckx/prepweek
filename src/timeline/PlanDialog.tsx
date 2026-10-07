// Shown when the plan has no room for another person.

import { createPortal } from 'react-dom';
import { peopleLimit } from '../data/plan.ts';
import { useBackToClose, useEscape } from '../lib/useBackToClose.ts';
import { Close } from '../ui/icons.tsx';

export function PlanDialog({ onClose }: { onClose(): void }) {
  useBackToClose(true, onClose);
  useEscape(onClose);
  const p = peopleLimit();
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
              <b>Got PrepWeek on AppSumo?</b> Press <i>Activate</i> on AppSumo, then pick this workspace. Each tier plans for more people.
            </li>
            <li>
              <b>Planning for someone you no longer need?</b> Remove them from the sheet to make room.
            </li>
          </ul>
          <div className="share-actions">
            <a className="btn primary" href="/appsumo">
              Redeem an AppSumo licence
            </a>
            <button className="btn" onClick={onClose}>
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
