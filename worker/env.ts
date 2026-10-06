import type { DirectoryDurableObject } from './directory.ts';
import type { PresenceDurableObject, SheetDurableObject } from './index.ts';

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
}
