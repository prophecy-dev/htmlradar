// Row-level types for the tables we touch from the app. Imported by
// server components, server actions, and analytics views to keep the
// shape definition in one place.

export interface Viewer {
  id: string;
  share_id: string;
  email: string | null;
  fingerprint: string | null;
  first_seen: string;
  last_seen: string;
  visit_count: number;
  country_code: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  referrer: string | null;
  is_internal: boolean;
}

export interface Session {
  id: string;
  share_id: string;
  viewer_id: string;
  document_version: number;
  started_at: string;
  last_heartbeat_at: string;
  active_time_seconds: number;
  max_scroll_depth: number;
  bounced: boolean;
}

export interface SectionEvent {
  id?: string;
  session_id: string;
  section_id: string;
  section_title: string | null;
  depth?: number | null;
  ordinal: number | null;
  time_seconds: number;
  entered_at?: string;
}
