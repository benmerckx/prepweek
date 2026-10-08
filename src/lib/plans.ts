// Plans: how many people a workspace may plan for. Shared by the app and
// the worker so both count the same way.
//
// A "person" is a row on a sheet (planned people, not logins: anyone can
// sign in). The same person on two sheets of a workspace counts once when
// they have an email or a real name; unnamed rows count each.

/** People a workspace without a licence can plan for. */
export const FREE_PEOPLE = 5;

/** AppSumo licence tiers: the people each covers. */
export const APPSUMO_TIERS: Record<number, number> = { 1: 15, 2: 40, 3: 100 };
export const appsumoPeople = (tier: number) => APPSUMO_TIERS[Math.min(3, Math.max(1, Math.round(tier) || 1))]!;

/** Paid plans (Paddle): people covered and prices per month / per year. */
export const PAID_PLANS = [
  { id: 'team', name: 'Team', people: 15, month: 29, year: 290 },
  { id: 'studio', name: 'Studio', people: 40, month: 69, year: 690 },
  { id: 'agency', name: 'Agency', people: 100, month: 129, year: 1290 },
] as const;
export type PaidPlanId = (typeof PAID_PLANS)[number]['id'];
export const paidPlan = (id: string) => PAID_PLANS.find((p) => p.id === id);

export interface PlanInfo {
  /** "Free", "AppSumo Tier 2", … */
  name: string;
  /** People the plan covers. */
  limit: number;
  /** People on the workspace's sheets now. */
  used: number;
  /** Of those, on other sheets than the one asked about (to add this sheet's own, live). */
  elsewhere: number;
  /** Limits are on (PLAN_LIMITS="on"); off, plans are shown but nothing is blocked. */
  enforced: boolean;
  /** A paid plan: which one, and whether it's in good standing. */
  paid?: { plan: string; status: string; until: number } | null;
}

const UNNAMED = /^(new person|unnamed|)$/i;

/** One key per person row, so the same person on two sheets counts once. */
export const personKey = (sheet: string, rowId: string, row: { name?: unknown; email?: unknown }) => {
  const email = String(row.email ?? '').trim().toLowerCase();
  if (email) return `e:${email}`;
  const name = String(row.name ?? '').trim().toLowerCase();
  return UNNAMED.test(name) ? `r:${sheet}/${rowId}` : `n:${name}`;
};
