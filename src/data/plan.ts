// The people limit, as this sheet sees it: the workspace's plan from the
// server, with this sheet's own people counted live (the server hears about
// them a few seconds later). A sheet outside a workspace gets the free
// allowance on its own.

import { FREE_PEOPLE, personKey } from '../lib/plans.ts';
import { getAccess, getSheetId, reloadAccess } from './access.ts';
import { createUser, store } from './store.ts';

export interface PeopleLimit {
  name: string;
  limit: number;
  used: number;
  enforced: boolean;
  /** In a workspace (an admin can redeem a licence for it). */
  workspace: { id: string; name: string } | null;
}

export const peopleLimit = (): PeopleLimit => {
  const access = getAccess();
  const sheet = getSheetId();
  const here = new Set(store.getRowIds('users').map((id) => personKey(sheet, id, store.getRow('users', id))));
  const plan = access?.plan;
  if (plan) return { name: plan.name, limit: plan.limit, used: plan.elsewhere + here.size, enforced: plan.enforced, workspace: access?.workspace ?? null };
  return { name: 'Free', limit: FREE_PEOPLE, used: here.size, enforced: !!access?.limitsOn, workspace: access?.workspace ?? null };
};

/** Room for one more person on the plan. */
export const canAddPerson = () => {
  const p = peopleLimit();
  return !p.enforced || p.used < p.limit;
};

/** Add a person, or say the plan is full (the timeline shows why). */
export const addPerson = (name = 'New person'): string | null => {
  if (!canAddPerson()) {
    window.dispatchEvent(new CustomEvent('prepweek:limit'));
    return null;
  }
  const id = createUser(name);
  // The plan's count catches up once the sheet has told the server.
  setTimeout(() => void reloadAccess(), 5000);
  return id;
};
