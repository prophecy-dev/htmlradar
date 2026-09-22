-- Comments from a verified reader back to the person who sent the link.
--
-- A comment hangs off one section of the deck, or off the whole document
-- (section_id NULL — the box at the end). Only a reader who proved their
-- address with a one-time code may leave one; that rule lives in addComment
-- (packages/db/src/public.ts), because it is a rule about who may write, not
-- about what a row looks like.
--
-- PRIVATE TO THE OWNER. Nothing on the recipient side ever reads this table
-- back: a reader never sees anyone else's comment, nor their own after a
-- reload. That is the whole point — a note to the sender is not a discussion
-- thread, and a deck carrying strangers' opinions is not the deck the sender
-- sent. `read_at` is the dashboard's own marker and means nothing to a reader.
--
-- The address is not copied here. The viewer row already holds it, so one
-- reader has one address on file, and a viewer deleted with their share takes
-- their comments with them.

CREATE TABLE IF NOT EXISTS document_comments (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  share_id       TEXT NOT NULL REFERENCES document_shares(id) ON DELETE CASCADE,
  viewer_id      TEXT NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- The section tracker's own id, so a comment lines up with the section_events
  -- row for the same reading, and the heading text as it read at the time. A
  -- snapshot rather than a join: a replaced document renames and renumbers its
  -- sections, and what the sender needs is the heading the reader was looking
  -- at. Both NULL on a comment about the whole document.
  section_id     TEXT,
  section_title  TEXT,
  -- The ceiling is enforced in addComment, which trims rather than refuses;
  -- this is the backstop that keeps a bug from filling D1 with one row.
  body           TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at        TEXT
);
-- Both reads are "the newest first", per document on the dashboard and per
-- link everywhere else.
CREATE INDEX IF NOT EXISTS idx_comments_doc ON document_comments (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_share ON document_comments (share_id, created_at DESC);
