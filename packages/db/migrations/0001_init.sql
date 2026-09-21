-- HTMLRadar on D1 — consolidated schema for the Somnia-internal fork.
--
-- Replaces schema/001–055 (Supabase Postgres). What went away with Postgres:
-- row-level security, SECURITY DEFINER RPCs, pg_net triggers and pg_cron. The
-- rules those enforced now live in TypeScript in packages/db/src, which both
-- the proxy worker and the dashboard import. The dashboard sits behind
-- Cloudflare Access, so "who is the owner" is the Access-authenticated e-mail.
--
-- Conventions:
--   ids         TEXT uuid, generated in TypeScript (crypto.randomUUID()).
--   timestamps  TEXT ISO-8601 UTC ("2026-09-21T16:40:00.000Z"), so they parse
--               exactly like the timestamptz strings PostgREST used to return.
--   booleans    INTEGER 0/1; packages/db/src converts at the edge.
--   arrays      TEXT holding a JSON array (allowed_emails etc.), or NULL.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  -- Where first-read alerts go besides e-mail. Optional per sender.
  telegram_chat_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email ON profiles (lower(email));

CREATE TABLE IF NOT EXISTS documents (
  id                      TEXT PRIMARY KEY,
  owner_id                TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  source_type             TEXT NOT NULL CHECK (source_type IN ('upload','url')),
  source_url              TEXT,
  current_version         INTEGER NOT NULL DEFAULT 1,
  r2_key                  TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at              TEXT,
  last_viewed_by_owner_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Preview card (Open Graph) shown when the link is pasted into Slack,
  -- Telegram, Reddit, iMessage… NULL falls back to the title.
  og_description          TEXT,
  og_image_r2_key         TEXT,
  client_creation_id      TEXT,
  config                  TEXT NOT NULL DEFAULT '{}',
  CHECK (
    (source_type = 'upload' AND r2_key IS NOT NULL AND source_url IS NULL) OR
    (source_type = 'url' AND source_url IS NOT NULL AND r2_key IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (owner_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_creation
  ON documents (owner_id, client_creation_id) WHERE client_creation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_versions (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  filename     TEXT,
  bytes        INTEGER,
  source_type  TEXT NOT NULL CHECK (source_type IN ('upload','url')),
  source_url   TEXT,
  r2_key       TEXT,
  replaced_by  TEXT REFERENCES profiles(id),
  replaced_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS document_shares (
  id                      TEXT PRIMARY KEY,
  document_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id                TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slug                    TEXT NOT NULL UNIQUE,
  slug_is_custom          INTEGER NOT NULL DEFAULT 0,
  recipient_label         TEXT,
  require_email           INTEGER NOT NULL DEFAULT 0,
  verify_email            INTEGER NOT NULL DEFAULT 0,
  require_password        INTEGER NOT NULL DEFAULT 0,
  password_hash           TEXT,
  allowed_email_domains   TEXT,   -- JSON array or NULL = any
  allowed_emails          TEXT,   -- JSON array or NULL = any
  lock_deck               INTEGER NOT NULL DEFAULT 1,
  notify_first_open       INTEGER NOT NULL DEFAULT 1,
  expires_at              TEXT,
  revoked_at              TEXT,
  last_disabled_notify_at TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  config                  TEXT NOT NULL DEFAULT '{}',
  CHECK (require_password = 0 OR password_hash IS NOT NULL),
  CHECK (verify_email = 0 OR require_email = 1)
);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON document_shares (document_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON document_shares (owner_id);

CREATE TABLE IF NOT EXISTS viewers (
  id            TEXT PRIMARY KEY,
  share_id      TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  email         TEXT,
  fingerprint   TEXT,
  first_seen    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  visit_count   INTEGER NOT NULL DEFAULT 1,
  user_agent    TEXT,
  referrer      TEXT,
  country_code  TEXT,
  city          TEXT,
  device_type   TEXT,
  os            TEXT,
  browser       TEXT,
  is_internal   INTEGER NOT NULL DEFAULT 0,
  CHECK (email IS NOT NULL OR fingerprint IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_viewers_share_email ON viewers (share_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_viewers_share_fp ON viewers (share_id, fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viewers_share ON viewers (share_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  share_id             TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  viewer_id            TEXT NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  document_version     INTEGER NOT NULL,
  token                TEXT NOT NULL,
  started_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_heartbeat_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  active_time_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (active_time_seconds BETWEEN 0 AND 86400),
  max_scroll_depth     REAL NOT NULL DEFAULT 0 CHECK (max_scroll_depth BETWEEN 0 AND 1),
  bounced              INTEGER GENERATED ALWAYS AS (max_scroll_depth < 0.05) VIRTUAL,
  notification_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_share ON sessions (share_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_viewer ON sessions (viewer_id, started_at DESC);

CREATE TABLE IF NOT EXISTS section_events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  section_id     TEXT NOT NULL,
  section_title  TEXT,
  depth          INTEGER,
  ordinal        INTEGER,
  time_seconds   REAL NOT NULL DEFAULT 0 CHECK (time_seconds BETWEEN 0 AND 86400),
  entered_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, section_id)
);

CREATE TABLE IF NOT EXISTS document_attachments (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  r2_key       TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_doc ON document_attachments (document_id);

CREATE TABLE IF NOT EXISTS attachment_downloads (
  id              TEXT PRIMARY KEY,
  attachment_id   TEXT NOT NULL REFERENCES document_attachments(id) ON DELETE CASCADE,
  share_id        TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  viewer_id       TEXT REFERENCES viewers(id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  recipient_email TEXT,
  filename        TEXT,
  size_bytes      INTEGER,
  country_code    TEXT,
  device_type     TEXT,
  user_agent      TEXT,
  downloaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_downloads_share ON attachment_downloads (share_id);

-- Verified e-mail gate (was schema/055). Code is stored as a keyed hash; the
-- key is the proxy's SESSION_SECRET, which is not in this database.
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id          TEXT PRIMARY KEY,
  share_id    TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  challenge   TEXT NOT NULL UNIQUE,
  ip_hash     TEXT,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evc_share_email ON email_verification_codes (share_id, lower(email), created_at);
CREATE INDEX IF NOT EXISTS idx_evc_ip ON email_verification_codes (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS share_email_verifications (
  share_id          TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  first_verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_verified_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (share_id, email)
);

-- First-read alerts (e-mail and Telegram), one row per attempt.
CREATE TABLE IF NOT EXISTS notifications_log (
  id             TEXT PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind           TEXT,
  channel        TEXT NOT NULL DEFAULT 'email',
  email_to       TEXT,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed','skipped')),
  error_message  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  label         TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'full',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at  TEXT,
  revoked_at    TEXT
);

-- Fixed-window counters (password attempts, start_session per IP, …).
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  window_at  TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1
);
