-- email_verification_codes, corrected to match the gate's real behaviour.
--
-- 0001 declared `challenge` UNIQUE. It must not be: a browser keeps ONE
-- challenge while asking for a second code, and the new code is bound to the
-- same challenge (the old one is retired by setting its expires_at). It also
-- lacked the two columns the rate limits read — `owner_id` (the per-sender
-- ceiling) and `counts_toward_address` (a request for an address the link does
-- not permit must not spend that address's own budget; upstream schema/055).
--
-- SQLite cannot drop a constraint, so the table is rebuilt. It holds only
-- ten-minute codes, so nothing of value is lost if a rebuild ever meets rows.

DROP TABLE IF EXISTS email_verification_codes;

CREATE TABLE email_verification_codes (
  id                    TEXT PRIMARY KEY,
  share_id              TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  code_hash             TEXT NOT NULL,
  challenge             TEXT NOT NULL,
  ip_hash               TEXT,
  owner_id              TEXT,
  counts_toward_address INTEGER NOT NULL DEFAULT 1,
  expires_at            TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  used_at               TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evc_share_email ON email_verification_codes (share_id, email, created_at);
CREATE INDEX IF NOT EXISTS idx_evc_email ON email_verification_codes (email, created_at);
CREATE INDEX IF NOT EXISTS idx_evc_ip ON email_verification_codes (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_evc_challenge ON email_verification_codes (share_id, email, challenge);
