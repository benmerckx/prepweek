// Paid plans with Paddle Billing (Paddle is the merchant of record, so it
// handles VAT and invoices).
//
//   POST /api/billing/checkout {workspaceId, plan, interval}  → {transactionId, token, sandbox}:
//        opened with Paddle.js on the page; with a live subscription the plan
//        is switched in place instead (prorated) → {switched: true}
//   POST /api/billing/portal {workspaceId}                    → {url}: Paddle's customer portal
//   POST /api/billing/webhook                                 Paddle notifications (signed)
//
// Products and prices are made through the API the first time they're needed
// (amounts live in lib/plans.ts), so nothing has to be set up in the catalog.
// See docs/BILLING.md for the keys and the webhook.

import { directory, fail, json, sessionUser } from "./auth.ts";
import type { Env } from "./env.ts";
import { paidPlan } from "../src/lib/plans.ts";

const sandbox = (env: Env) => env.PADDLE_ENV !== "production";
const base = (env: Env) =>
  (
    env.PADDLE_BASE ||
    (sandbox(env) ? "https://sandbox-api.paddle.com" : "https://api.paddle.com")
  ).replace(/\/$/, "");

const paddle = async <T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${base(env)}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.PADDLE_API_KEY}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as {
    data: T;
    error?: { detail?: string };
  };
  if (!res.ok) throw new Error(data.error?.detail ?? `Paddle ${res.status}`);
  return data.data;
};

/** The catalog price for a plan, made (and remembered) on first use. */
const priceFor = async (
  env: Env,
  planId: string,
  interval: "month" | "year",
) => {
  const p = paidPlan(planId)!;
  const currency = (env.BILLING_CURRENCY || "eur").toUpperCase();
  const amount = (interval === "year" ? p.year : p.month) * 100;
  const dir = directory(env);
  const mode = sandbox(env) ? "sandbox" : "live";
  const key = `${mode}:price:${p.id}:${interval}:${currency}:${amount}`;
  const known = await dir.paddleId(key);
  if (known) return known;
  const productKey = `${mode}:product:${p.id}`;
  let product = await dir.paddleId(productKey);
  if (!product) {
    product = (
      await paddle<{ id: string }>(env, "POST", "products", {
        name: `PrepWeek ${p.name}`,
        tax_category: "standard",
        custom_data: { plan: p.id },
      })
    ).id;
    await dir.setPaddleId(productKey, product);
  }
  const price = await paddle<{ id: string }>(env, "POST", "prices", {
    product_id: product,
    name: interval === "year" ? "Yearly" : "Monthly",
    description: `PrepWeek ${p.name}, ${p.people} people, billed ${interval === "year" ? "yearly" : "monthly"}`,
    unit_price: { amount: String(amount), currency_code: currency },
    billing_cycle: { interval, frequency: 1 },
    custom_data: { plan: p.id, interval },
  });
  await dir.setPaddleId(key, price.id);
  return price.id;
};

export async function billingApi(
  req: Request,
  env: Env,
  url: URL,
  seg: string[],
): Promise<Response> {
  if (seg[1] === "webhook") return webhook(req, env);
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (req.headers.get("origin") && req.headers.get("origin") !== url.origin)
    return fail("Bad origin", 403);
  if (!env.PADDLE_API_KEY || !env.PADDLE_CLIENT_TOKEN)
    return fail("Paid plans aren’t set up on this server yet", 501);
  const user = await sessionUser(req, env);
  if (!user) return fail("Sign in first", 401);
  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string;
    plan?: string;
    interval?: string;
  };
  const dir = directory(env);
  const ws = body.workspaceId ?? "";
  try {
    const current = await dir.billing(user.id, ws);
    const live =
      current && current.subscription && current.status !== "canceled";
    if (seg[1] === "portal") {
      if (!current?.customer)
        return fail("This workspace has no billing yet", 404);
      const s = await paddle<{ urls: { general: { overview: string } } }>(
        env,
        "POST",
        `customers/${current.customer}/portal-sessions`,
        {
          subscription_ids: current.subscription ? [current.subscription] : [],
        },
      );
      return json({ url: s.urls.general.overview });
    }
    if (seg[1] === "checkout") {
      const plan = paidPlan(body.plan ?? "");
      const interval = body.interval === "year" ? "year" : "month";
      if (!plan) return fail("Unknown plan");
      const price = await priceFor(env, plan.id, interval);
      if (live) {
        // Switch in place: Paddle charges or credits the difference now.
        await paddle(env, "PATCH", `subscriptions/${current.subscription}`, {
          items: [{ price_id: price, quantity: 1 }],
          proration_billing_mode: "prorated_immediately",
          custom_data: { workspace: ws, plan: plan.id },
        });
        await dir.setSubscription(ws, { plan: plan.id });
        return json({ switched: true });
      }
      const tx = await paddle<{ id: string }>(env, "POST", "transactions", {
        items: [{ price_id: price, quantity: 1 }],
        custom_data: { workspace: ws, plan: plan.id },
        ...(current?.customer ? { customer_id: current.customer } : {}),
      });
      return json({
        transactionId: tx.id,
        token: env.PADDLE_CLIENT_TOKEN,
        sandbox: sandbox(env),
        email: user.email,
      });
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 400);
  }
  return fail("Not found", 404);
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Paddle-Signature: ts=…;h1=… is HMAC-SHA256(secret, `${ts}:${body}`). */
export const paddleSignature = async (
  secret: string,
  ts: string,
  body: string,
) => {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      k,
      new TextEncoder().encode(`${ts}:${body}`),
    ),
  );
};

type Custom = { workspace?: string; plan?: string } | null | undefined;
type Subscription = {
  id: string;
  status: string;
  customer_id: string;
  custom_data?: Custom;
  items?: { price?: { custom_data?: Custom } }[];
  current_billing_period?: { ends_at?: string } | null;
};
type Transaction = {
  subscription_id?: string | null;
  customer_id?: string | null;
  custom_data?: Custom;
  status: string;
};

async function webhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (!env.PADDLE_WEBHOOK_SECRET) return fail("Paid plans aren’t set up", 501);
  const body = await req.text();
  const parts = (req.headers.get("paddle-signature") ?? "")
    .split(";")
    .map((p) => p.split("=") as [string, string]);
  const ts = parts.find(([k]) => k === "ts")?.[1] ?? "";
  // Several h1 values can be present while a secret is rotated: any may match.
  const sigs = parts.filter(([k]) => k === "h1").map(([, v]) => v);
  const want = await paddleSignature(env.PADDLE_WEBHOOK_SECRET, ts, body);
  if (
    !ts ||
    !sigs.includes(want) ||
    Math.abs(Date.now() / 1000 - Number(ts)) > 600
  )
    return fail("Bad signature", 400);
  const event = JSON.parse(body) as {
    event_type: string;
    occurred_at: string;
    data: Record<string, unknown>;
  };
  const dir = directory(env);
  // Notifications can arrive out of order: older ones don't overwrite newer.
  const at = Date.parse(event.occurred_at) || Date.now();
  if (event.event_type.startsWith("subscription.")) {
    const sub = event.data as unknown as Subscription;
    const ws =
      sub.custom_data?.workspace || (await dir.workspaceOfSubscription(sub.id));
    await dir.setSubscription(
      ws,
      {
        customer: sub.customer_id,
        subscription: sub.id,
        plan: sub.items?.[0]?.price?.custom_data?.plan || sub.custom_data?.plan,
        status: sub.status,
        periodEnd: Date.parse(sub.current_billing_period?.ends_at ?? "") || 0,
      },
      at,
    );
  } else if (event.event_type === "transaction.completed") {
    // Usually just ahead of subscription.created: unlock the plan right away.
    const tx = event.data as unknown as Transaction;
    if (tx.subscription_id && tx.custom_data?.workspace)
      await dir.setSubscription(
        tx.custom_data.workspace,
        {
          customer: tx.customer_id ?? "",
          subscription: tx.subscription_id,
          plan: tx.custom_data.plan,
          status: "active",
        },
        at,
      );
  }
  return json({ received: true });
}

/** Cancel the subscriptions of workspaces that were deleted. */
export const cancelSubscriptions = async (env: Env, workspaceIds: string[]) => {
  if (!env.PADDLE_API_KEY || !workspaceIds.length) return;
  for (const id of await directory(env).subscriptionsOf(workspaceIds))
    await paddle(env, "POST", `subscriptions/${id}/cancel`, {
      effective_from: "immediately",
    }).catch((e) => console.error("cancel subscription", id, e));
};
