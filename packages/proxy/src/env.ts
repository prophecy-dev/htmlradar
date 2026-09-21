// Worker environment. Vars and bindings come from wrangler.jsonc; secrets are
// set with `wrangler secret put`.

/**
 * The Cloudflare Email Service `send_email` binding, in the shape this worker
 * uses. Declared here rather than taken from workers-types, whose SendEmail
 * still describes only the raw-MIME form.
 */
export interface EmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string } | string;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<unknown>;
}

export interface Env {
  // Bindings
  DB: D1Database;
  DOCS_BUCKET: R2Bucket;
  /** Absent in a run with no email binding: codes and alerts are then logged as failed. */
  EMAIL?: EmailBinding;

  // Secrets
  /** HMAC key for gate cookies, owner preview tokens and code hashes. Shared with the app. */
  SESSION_SECRET: string;
  /** Telegram bot for first-read alerts. Unset means e-mail only. */
  TELEGRAM_BOT_TOKEN?: string;

  // Vars
  /** Canonical host recipient links are printed on (docs.hive.land). */
  SHARE_HOST?: string;
  /** The dashboard, linked from first-read alerts. */
  APP_ORIGIN?: string;
  /** Sender address for codes and alerts; must be on a domain Email Service can send from. */
  MAIL_FROM?: string;
  /** Display name on outgoing mail and on the privacy page. */
  BRAND_NAME?: string;
  /** Who a recipient writes to about their data (an address or URL). */
  PRIVACY_CONTACT?: string;
  /**
   * Optional override for where documents load the tracker from. Empty means
   * this worker's own bundled copy at /v1/tracker.{version}.js, which is the
   * normal case: the dashboard sits behind Access and cannot serve it.
   */
  TRACKER_URL?: string;
  /** The gate's timing floor in ms (see GATE_FLOOR_MS in index.ts); 0 in dev and tests. */
  GATE_FLOOR_MS?: string;
  /** Git commit bound at deploy time; absent under `wrangler dev`. */
  GIT_SHA?: string;
}
