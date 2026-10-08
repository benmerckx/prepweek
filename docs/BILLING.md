# Paid plans (Paddle)

Subscriptions run on [Paddle Billing](https://www.paddle.com/billing). Paddle
is the merchant of record: it sells the subscription to the customer, charges
and pays out the right VAT or sales tax, sends invoices and handles billing
support. That's what makes it easy to sell to businesses all over the EU and
beyond as a small team.

Plans and prices live in `src/lib/plans.ts` (in euros by default):

| Plan | People | Month | Year |
| --- | --- | --- | --- |
| Team | 15 | €29 | €290 |
| Studio | 40 | €69 | €690 |
| Agency | 100 | €129 | €1290 |

A paid plan adds to AppSumo licences on the same workspace ("Team + AppSumo").
There's no catalog to set up: the worker makes the product and price in Paddle
the first time someone picks a plan, and remembers their ids. Changing an
amount in `plans.ts` makes a new price for new checkouts and switches;
existing subscriptions keep theirs.

## Setting it up

Try it in the sandbox first (sandbox-vendors.paddle.com); the same steps work
on a live account.

1. **Domain.** In Paddle, *Checkout → Website approval*: add your domain
   (live accounts need it approved before checkouts open).
2. **Default payment link.** *Checkout → Checkout settings*: set it to
   `https://<your host>/app`. Paddle requires one before transactions can be
   made.
3. **API key.** *Developer tools → Authentication*: create an API key with
   write access to products, prices, transactions, customers (portal sessions)
   and subscriptions.
4. **Client-side token.** Same page: create a client-side token. Paddle.js
   uses it to open the checkout; it isn't secret.
5. **Notifications.** *Developer tools → Notifications → New destination*:
   URL `https://<your host>/api/billing/webhook`, with these events:
   `transaction.completed`, `subscription.created`, `subscription.updated`,
   `subscription.activated`, `subscription.past_due`, `subscription.paused`,
   `subscription.resumed`, `subscription.canceled`. Copy its secret key.
6. **Configure the worker:**

   ```sh
   wrangler secret put PADDLE_API_KEY
   wrangler secret put PADDLE_WEBHOOK_SECRET   # the destination's secret key
   ```

   and in `wrangler.toml` `[vars]`:

   ```toml
   PADDLE_CLIENT_TOKEN = "test_…"   # or live_…
   PADDLE_ENV = "production"        # leave out for the sandbox
   BILLING_CURRENCY = "eur"         # optional
   PLAN_LIMITS = "on"               # make the limits count
   ```

Without `PADDLE_API_KEY` and `PADDLE_CLIENT_TOKEN`, choosing a plan says paid
plans aren't set up yet; the free plan and AppSumo work as before.

## How it works

- **Checkout.** A workspace admin opens *People in … → Upgrade* and picks a
  plan and monthly or yearly. The worker makes a Paddle transaction carrying
  the workspace id (`custom_data`), and the page opens Paddle's checkout
  overlay for it. Afterwards Paddle sends the customer to `/app?billing=done`,
  which waits for the notification that turns the plan on.
- **Notifications.** Signed with `Paddle-Signature` (HMAC of
  `ts:body`, checked within 10 minutes). `transaction.completed` and
  `subscription.*` update the workspace's subscription: plan, status, period
  end. Notifications can arrive out of order, so an older one never overwrites
  a newer one. `active`, `trialing` and `past_due` count as paid (Paddle retries
  failed payments before cancelling); `paused` and `canceled` drop back to the
  free plan. Nothing is deleted.
- **Switching plans** happens in place (`PATCH /subscriptions/…`), prorated
  immediately.
- **Invoices, card and cancelling** open Paddle's customer portal.
- **Deleting** a workspace or an account cancels its subscriptions right away.

The terms page names Paddle as reseller and the privacy page lists it as a
processor. Paddle's own review usually asks for both, plus visible prices
(the home page and the plans dialog) and a refund policy.
