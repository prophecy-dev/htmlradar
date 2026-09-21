// Row shapes AFTER conversion by the helpers in d1.ts (booleans are booleans,
// JSON arrays are arrays). Raw D1 rows use 0/1 and JSON text; use the
// `row*` converters below when reading.

import { toArray, toBool } from './d1.js';

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  timezone: string;
  telegram_chat_id: string | null;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  owner_id: string;
  title: string;
  source_type: 'upload' | 'url';
  source_url: string | null;
  current_version: number;
  r2_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_viewed_by_owner_at: string;
  og_description: string | null;
  og_image_r2_key: string | null;
  client_creation_id: string | null;
}

export interface ShareRow {
  id: string;
  document_id: string;
  owner_id: string;
  slug: string;
  slug_is_custom: boolean;
  recipient_label: string | null;
  require_email: boolean;
  verify_email: boolean;
  require_password: boolean;
  password_hash: string | null;
  allowed_email_domains: string[] | null;
  allowed_emails: string[] | null;
  lock_deck: boolean;
  notify_first_open: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_disabled_notify_at: string | null;
  created_at: string;
}

export interface ViewerRow {
  id: string;
  share_id: string;
  email: string | null;
  fingerprint: string | null;
  first_seen: string;
  last_seen: string;
  visit_count: number;
  user_agent: string | null;
  referrer: string | null;
  country_code: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  is_internal: boolean;
}

export interface SessionRow {
  id: string;
  share_id: string;
  viewer_id: string;
  document_version: number;
  started_at: string;
  last_heartbeat_at: string;
  active_time_seconds: number;
  max_scroll_depth: number;
  bounced: boolean;
  notification_sent_at: string | null;
}

type Raw = Record<string, unknown>;

export function rowShare(r: Raw): ShareRow {
  return {
    ...(r as unknown as ShareRow),
    slug_is_custom: toBool(r['slug_is_custom']),
    require_email: toBool(r['require_email']),
    verify_email: toBool(r['verify_email']),
    require_password: toBool(r['require_password']),
    lock_deck: toBool(r['lock_deck']),
    notify_first_open: toBool(r['notify_first_open']),
    allowed_email_domains: toArray(r['allowed_email_domains']),
    allowed_emails: toArray(r['allowed_emails']),
  };
}

export function rowViewer(r: Raw): ViewerRow {
  return { ...(r as unknown as ViewerRow), is_internal: toBool(r['is_internal']) };
}

export function rowSession(r: Raw): SessionRow {
  const s = { ...(r as unknown as SessionRow & { token?: string }), bounced: toBool(r['bounced']) };
  delete s.token;
  return s;
}
