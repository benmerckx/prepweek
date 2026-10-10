# Admin dashboard

`/admin` shows how Prepweek is doing: people, workspaces, plans and
subscriptions (from the directory), and traffic, usage, errors and request
times (usage statistics). Only the addresses in `ADMIN_EMAILS` can open it.

## Setting it up

1. **Who's an admin:** `ADMIN_EMAILS` in `wrangler.toml` (`[vars]`), one or
   more addresses, comma separated. Log in with one of them and open `/admin`.
2. **Usage statistics** are recorded from the first deploy with the
   `EVENTS` binding (`wrangler.toml`, Workers Analytics Engine, dataset
   `prepweek_events`). To read them back on the dashboard, add two more
   secrets:
   - `CF_ACCOUNT_ID`: your account id (on the Workers overview page).
   - `CF_API_TOKEN`: an API token (My Profile → API Tokens → Create Token →
     Custom) with the permission **Account → Account Analytics → Read**.

Without step 2 the dashboard shows the directory's numbers and says what's
missing.

## What's counted

Cookieless and anonymous (see `worker/stats.ts`, and the privacy page):

- every request the worker handles: route, status, time;
- page views, with a daily visitor code (address + browser + date, hashed:
  it can't be turned back and changes every day, so "visits" counts a
  visitor once a day);
- uncaught errors in browsers and on the server;
- a few events: sign-ups, plans loaded on the server (the main hosting cost
  driver), digests sent, daily puzzle plays, solves, shares and reveals;
- signed-in people who opened the app that day (a daily code, not their id).

Analytics Engine keeps points for three months; the dashboard reads up to 90
days. On the Workers Paid plan the first 10 million points a month are
included.
