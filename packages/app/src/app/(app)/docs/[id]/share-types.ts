// The shapes the document page hands its client components.

import type { Viewer, Session } from '@/lib/types';

export interface ShareRow {
  id: string;
  slug: string;
  // A hand-picked slug: permanent, revoked rather than deleted.
  slug_is_custom?: boolean;
  recipient_label: string | null;
  require_email: boolean;
  /**
   * The verified e-mail gate. Never true while require_email is false.
   * Optional here, and absent reads as off, which is the safe direction for a
   * flag that decides whether a reader is challenged.
   */
  verify_email?: boolean;
  require_password: boolean;
  // Domain allowlist (e.g. ['example.com']). The gate accepts a match in
  // EITHER this list or allowed_emails.
  allowed_email_domains: string[] | null;
  allowed_emails: string[] | null;
  //   true  → deck is LOCKED (save/print blocked, watermark on)
  //   false → deck is open (save/print allowed)
  lock_deck: boolean;
  // Alert the owner (Telegram) on the first read that is not a bot or internal.
  notify_first_open?: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  viewCount: number;
}

export interface ShareAnalyticsData {
  viewers: Viewer[];
  sessions: Session[];
  sections: Array<{
    id: string;
    title: string;
    totalSeconds: number;
    viewers: number;
    ordinal?: number | null;
  }>;
}
