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
3. **API key.** *My account → Settings → Authentication → API keys → New
   API key*. Give it these permissions (the calls in `worker/billing.ts`):
   `product.write`, `price.write`, `transaction.write`, `subscription.write`
   and `customer_portal_session.write`, plus `transaction.read` and
   `subscription.read` (to confirm a payment when the webhook is late). Set the expiry as far out as allowed (a year at most)
   and put a reminder in: billing stops working when it expires. Copy the
   key when it's shown; Paddle shows it only once.
4. **Client-side token.** Same page, *Client-side tokens* tab: create one.
   Paddle.js uses it to open the checkout; it isn't secret.
5. **Notifications.** *Events → Notifications → New destination*:
   URL `https://<your host>/api/billing/webhook`, with these events:
   `transaction.completed`, `subscription.created`, `subscription.updated`,
   `subscription.activated`, `subscription.past_due`, `subscription.paused`,
   `subscription.resumed`, `subscription.canceled`. Copy its secret key.
6. **Checkout styling.** The checkout opens inside the plans dialog
   (Paddle's inline checkout, beside our own order summary). Its fields and
   buttons are styled in *Checkout → Checkout configuration → Styling*. To
   match the app: font *System default* (or the closest sans-serif), text
   `#221f28`, secondary text `#66616f`, borders `#e4e1e9` at 1px, radius
   8px, focus `#c23c63`, primary button `#26222d` with text `#fbfafc`,
   links `#c23c63`, checkout padding off.
7. **Configure the worker:**

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

**Paid but still on Free?** The plan is set by the webhook. Check *Events →
Notifications* → the destination's logs: the URL must be
`https://<your host>/api/billing/webhook` and `PADDLE_WEBHOOK_SECRET` must be
that destination's secret (sandbox and live have their own). As a fallback
the app asks Paddle itself (`/api/billing/sync`) right after paying and
whenever an admin opens Plans on a free workspace.

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
  immediately: the difference is charged to the card on file (or credited to
  the balance when it's a step down). The dialog shows Paddle's preview of
  that amount first and switches on confirm; a failed charge leaves the plan
  as it was.
- **Invoices, card and cancelling** open Paddle's customer portal.
- **Deleting** a workspace or an account cancels its subscriptions right away.

The terms page names Paddle as reseller and the privacy page lists it as a
processor. Paddle's own review usually asks for both, plus visible prices
(the home page and the plans dialog) and a refund policy.
