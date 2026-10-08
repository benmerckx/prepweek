import type { DirectoryDurableObject } from "./directory.ts";
import type { PresenceDurableObject, SheetDurableObject } from "./index.ts";

export interface Env {
  /** Optional R2 bucket for attachment bytes. */
  FILES?: R2Bucket;
  SHEETS: DurableObjectNamespace<SheetDurableObject>;
  PRESENCE: DurableObjectNamespace<PresenceDurableObject>;
  DIRECTORY: DurableObjectNamespace<DirectoryDurableObject>;
  ASSETS: Fetcher;
  /** Optional: send magic links and invites with Mandrill (Mailchimp Transactional). */
  MANDRILL_API_KEY?: string;
  /** Sender for magic links and invites, on a domain verified in Mandrill, e.g. "prepweek <login@yourdomain.com>". */
  EMAIL_FROM?: string;
  /** Optional: "Continue with Google". */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "on": plans limit how many people a workspace plans for. Anything else: shown, not enforced. */
  PLAN_LIMITS?: string;
  /** AppSumo licensing (Partner Portal → Licensing): OAuth client and the API key that signs webhooks. */
  APPSUMO_CLIENT_ID?: string;
  APPSUMO_CLIENT_SECRET?: string;
  APPSUMO_API_KEY?: string;
  /** Paddle Billing (paid plans): API key, the notification destination's
   *  secret key, the client-side token for Paddle.js, and "production" (anything
   *  else uses the sandbox). */
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_ENV?: string;
  /** Currency for paid plans (default "eur"). */
  BILLING_CURRENCY?: string;
  /** Tests only: where Paddle's API is. */
  PADDLE_BASE?: string;
  /** Tests only: where AppSumo's OAuth and API are (default https://appsumo.com). */
  APPSUMO_BASE?: string;
  /** The public address, for links in emails sent without a request (the digest cron). */
  APP_URL?: string;
}
