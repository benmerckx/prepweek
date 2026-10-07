# AppSumo launch

Everything needed to sell PrepWeek on the AppSumo Marketplace: how the code
works, what to set in AppSumo's Partner Portal and Cloudflare, a launch
checklist, and draft copy for the listing.

## How it works

| Piece | Where |
|---|---|
| Plans: Free 5 people, AppSumo Tier 1/2/3 = 15/40/100 | `src/lib/plans.ts` |
| Counting people per workspace (sheets report their people rows) | `SheetDurableObject#watchPeople`, `DirectoryDurableObject.plan` |
| Licences table, webhook events, redeeming | `worker/directory.ts` (Plans and licences) |
| OAuth callback, webhook, redeem API | `worker/appsumo.ts` |
| Redeem page `/appsumo`, help `/help`, roadmap `/roadmap` | `src/landing/Pages.tsx` |
| “Plan full” dialog, plan in the workspace dialog | `src/timeline/PlanDialog.tsx`, `src/timeline/Account.tsx` |

A **person** is a row you plan for, not a login: logins and sheets are
unlimited on every plan. The same person on two sheets counts once (matched by
email, else by name).

The licence lifecycle:

1. **Purchase**: AppSumo sends a `purchase` webhook. The licence is stored,
   not attached to any workspace yet.
2. **Activate**: the buyer presses *Activate* on AppSumo and lands on
   `/auth/appsumo/callback?code=…`. We exchange the code for their licence key,
   keep it in a cookie, and open `/appsumo`. They sign in (or sign up) and pick
   the workspace; its plan moves to their tier.
3. **Upgrade / downgrade**: a webhook with a new `license_key` and the old one
   as `prev_license_key`. The new key takes over the old one's workspace.
4. **Deactivate** (refund): the licence stops counting and the workspace is
   back on Free. Nothing is deleted; adding more people is blocked until there
   is room.

## Setup

In AppSumo's **Partner Portal → Licensing**:

- OAuth redirect URL: `https://<your domain>/auth/appsumo/callback`
- Webhook URL: `https://<your domain>/api/appsumo/webhook`
- Send a test webhook: it should answer `{"success":true,…}`.

In Cloudflare:

```sh
wrangler secret put APPSUMO_CLIENT_SECRET   # OAuth client secret
wrangler secret put APPSUMO_API_KEY         # also signs the webhooks
```

and in `wrangler.toml` under `[vars]`:

```toml
APPSUMO_CLIENT_ID = "<OAuth client id>"
PLAN_LIMITS = "on"   # at launch: enforce the people limits
```

While `PLAN_LIMITS` is `"off"` (the default) plans show but nothing is
blocked, so current users aren't capped before launch. Turning it on applies
the Free limit to every workspace without a licence: give your own and early
users' workspaces a licence first (or keep it off until then).

Email must work (Mandrill: `MANDRILL_API_KEY`, `EMAIL_FROM`): buyers sign in
with a magic link.

### Testing locally

The callback and API can point at a stand-in for appsumo.com with
`APPSUMO_BASE`:

```sh
npx wrangler dev --local --var APPSUMO_BASE:http://localhost:8790 \
  --var APPSUMO_CLIENT_ID:cid --var APPSUMO_CLIENT_SECRET:csecret \
  --var APPSUMO_API_KEY:apikey --var PLAN_LIMITS:on
```

A webhook is signed as `hex(HMAC-SHA256(APPSUMO_API_KEY, timestamp + body))`
in `X-Appsumo-Signature`, with the timestamp in `X-Appsumo-Timestamp`.

### Known limits

- Limits are checked in the app (the Add person button), not refused by the
  sync server, and importing a Teamweek file isn't capped. Fine for honest
  customers; tighten later if needed.
- People are counted per workspace. A sheet outside any workspace gets the
  free allowance on its own.

## Launch checklist

- [ ] Partner Portal: listing submitted, OAuth redirect and webhook URLs set,
      test webhook passes.
- [ ] Secrets and `APPSUMO_CLIENT_ID` set; `PLAN_LIMITS = "on"`.
- [ ] Mandrill sending from a verified domain; sign in with a fresh email works.
- [ ] Buy your own Tier 1 with a test account, activate, apply, upgrade,
      refund: check the workspace plan at each step.
- [ ] `support@prepweek.com` (in `src/landing/Pages.tsx`) receives mail, and
      someone reads it every few hours during the first two weeks.
- [ ] Help and roadmap pages read right; nothing on the roadmap you won't build.
- [ ] GIFs recorded (shot list below).
- [ ] The AppSumo price is the lowest anywhere (their rule): no cheaper
      lifetime offer elsewhere.

## Listing copy (draft)

**Name:** PrepWeek

**One-liner:** See who's doing what, week by week: the team planner Teamweek
fans kept asking for.

**Short description:** PrepWeek puts everyone's work on one timeline. Drag a
block onto someone, stretch it over the days it takes, and your whole team
sees it the moment you let go. Bring your Teamweek / Toggl Plan history over
in one go.

**Who it's for:** agencies, studios and small teams who plan people across
projects week by week; anyone moving off Teamweek or Toggl Plan.

**Why PrepWeek:**

- A timeline you read at a glance: people down the side, weeks across the
  top, colored blocks for the work.
- Live for the whole team, works offline, fast with years of history.
- One task for several people, time off and holidays, dependencies with
  arrows, checklists, repeating tasks, start and end times.
- Projects and clients, tags, saved views, comments with @mentions, an
  activity log and undo.
- Import your Teamweek / Toggl Plan export; export to CSV any time; a live
  calendar link for Google, Apple and Outlook.
- A daily email digest of your day, and the full planner on your phone.
- Unlimited logins: you pay for the people you plan, not for seats.

**Deal terms (suggested; AppSumo sets the final prices):**

| Tier | Price | People planned | Everything else |
|---|---|---|---|
| 1 | $59 | 15 | Unlimited logins and sheets, all features |
| 2 | $119 | 40 | Same |
| 3 | $199 | 100 | Same |

Lifetime access to the plan and all future updates to it. 60-day money-back
guarantee through AppSumo. Not included: future paid add-ons that cost us to
run (for example SSO or third-party integrations with their own fees).

**GIF / video shot list:**

1. Dragging across a row to make a block, then stretching it.
2. Two browsers side by side: a change appears live in the other.
3. A task for two people: the block shows up in both rows.
4. Dependencies: moving the first task pushes the next one along.
5. Time off on someone's row; the sidebar says “Away, back Mo 12”.
6. Importing a Teamweek CSV: thousands of tasks in seconds.
7. The phone: dragging and the bottom sheet.

## Support replies (drafts)

**Couldn't redeem:** “Sorry about that! Open My products on AppSumo, press
Activate on PrepWeek, and sign in with the email you want to use. If it still
says something's wrong, reply with the email and the first four characters of
your licence and I'll apply it by hand.”

**Upgraded but still on the old tier:** “Upgrades come through within a
minute or two. If yours didn't, press Activate on AppSumo once more; your
workspace keeps all its data.”

**Refund:** “Refunds go through AppSumo within 60 days of purchase. Your
workspace goes back to the free plan: nothing is deleted, and you can export
everything as CSV from the ⋯ menu.”
