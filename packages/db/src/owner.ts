// Owner-side data access: everything the dashboard and the /api/v1 routes read
// and write. Replaces Supabase RLS + the owner RPCs (create_share,
// update_share, set_share_lock_deck, set_viewer_internal, …).
//
// Every function takes the owner's profile id and scopes by it. That is the
// whole of the access control now that RLS is gone, so a function that reads a
// row by id without an owner filter does not belong in this file.

import {
  fromArray,
  fromBool,
  hitRateLimit,
  nowIso,
  randomHex,
  sha256Hex,
  toBool,
  uuid,
  type DB,
} from './d1.js';
import { hashSharePassword } from './password.js';
import {
  rowSession,
  rowShare,
  rowViewer,
  type DocumentRow,
  type Profile,
  type SessionRow,
  type ShareRow,
  type ViewerRow,
} from './types.js';

type Raw = Record<string, unknown>;

export class OwnerError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

// ---------------------------------------------------------------- profiles

export async function ensureProfile(db: DB, email: string): Promise<Profile> {
  const clean = email.trim().toLowerCase();
  const existing = await db
    .prepare('SELECT * FROM profiles WHERE lower(email) = ?1')
    .bind(clean)
    .first<Profile>();
  if (existing) return existing;
  await db
    .prepare('INSERT INTO profiles (id, email) VALUES (?1, ?2) ON CONFLICT DO NOTHING')
    .bind(uuid(), clean)
    .run();
  const row = await db
    .prepare('SELECT * FROM profiles WHERE lower(email) = ?1')
    .bind(clean)
    .first<Profile>();
  if (!row) throw new OwnerError('profile_create_failed');
  return row;
}

export async function getProfile(db: DB, ownerId: string): Promise<Profile | null> {
  return db.prepare('SELECT * FROM profiles WHERE id = ?1').bind(ownerId).first<Profile>();
}

export async function updateProfile(
  db: DB,
  ownerId: string,
  patch: { timezone?: string; telegram_chat_id?: string | null; display_name?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = ?${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(ownerId);
  await db
    .prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?${vals.length}`)
    .bind(...vals)
    .run();
}

// ---------------------------------------------------------------- documents

export function docR2Key(ownerId: string, docId: string, version: number): string {
  return `docs/${ownerId}/${docId}/v${version}.html`;
}

export async function listDocuments(db: DB, ownerId: string): Promise<DocumentRow[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM documents WHERE owner_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC',
    )
    .bind(ownerId)
    .all<DocumentRow>();
  return results;
}

/** One page of live documents, newest first, with how many links point at each. */
export async function listDocumentsPage(
  db: DB,
  ownerId: string,
  opts: { before?: { created_at: string; id: string }; limit: number },
): Promise<Array<Pick<DocumentRow, 'id' | 'title' | 'created_at'> & { share_count: number }>> {
  const vals: unknown[] = [ownerId];
  let before = '';
  if (opts.before) {
    vals.push(opts.before.created_at, opts.before.id);
    before = ' AND (d.created_at < ?2 OR (d.created_at = ?2 AND d.id < ?3))';
  }
  const { results } = await db
    .prepare(
      `SELECT d.id, d.title, d.created_at,
              (SELECT count(*) FROM document_shares s WHERE s.document_id = d.id) AS share_count
         FROM documents d
        WHERE d.owner_id = ?1 AND d.deleted_at IS NULL${before}
        ORDER BY d.created_at DESC, d.id DESC LIMIT ${Math.floor(opts.limit)}`,
    )
    .bind(...vals)
    .all<Pick<DocumentRow, 'id' | 'title' | 'created_at'> & { share_count: number }>();
  return results;
}

export async function countDocuments(db: DB, ownerId: string): Promise<number> {
  const row = await db
    .prepare('SELECT count(*) AS n FROM documents WHERE owner_id = ?1 AND deleted_at IS NULL')
    .bind(ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A live (not deleted) document the owner owns, or null. */
export async function getDocument(
  db: DB,
  ownerId: string,
  docId: string,
): Promise<DocumentRow | null> {
  return db
    .prepare('SELECT * FROM documents WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL')
    .bind(docId, ownerId)
    .first<DocumentRow>();
}

export async function findDocumentByCreationId(
  db: DB,
  ownerId: string,
  creationId: string,
): Promise<DocumentRow | null> {
  return db
    .prepare('SELECT * FROM documents WHERE owner_id = ?1 AND client_creation_id = ?2')
    .bind(ownerId, creationId)
    .first<DocumentRow>();
}

export async function insertDocument(
  db: DB,
  row: {
    id: string;
    owner_id: string;
    title: string;
    source_type: 'upload' | 'url';
    source_url: string | null;
    r2_key: string | null;
    client_creation_id?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, owner_id, title, source_type, source_url, r2_key, client_creation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      row.id,
      row.owner_id,
      row.title,
      row.source_type,
      row.source_url,
      row.r2_key,
      row.client_creation_id ?? null,
    )
    .run();
}

/** Hard delete — only for rolling back a creation whose upload failed. */
export async function purgeDocument(db: DB, ownerId: string, docId: string): Promise<void> {
  await db
    .prepare('DELETE FROM documents WHERE id = ?1 AND owner_id = ?2')
    .bind(docId, ownerId)
    .run();
}

export async function softDeleteDocument(db: DB, ownerId: string, docId: string): Promise<void> {
  await db
    .prepare('UPDATE documents SET deleted_at = ?1 WHERE id = ?2 AND owner_id = ?3')
    .bind(nowIso(), docId, ownerId)
    .run();
}

export async function touchDocumentViewed(db: DB, ownerId: string, docId: string): Promise<void> {
  await db
    .prepare('UPDATE documents SET last_viewed_by_owner_at = ?1 WHERE id = ?2 AND owner_id = ?3')
    .bind(nowIso(), docId, ownerId)
    .run();
}

/** Point the document at a freshly uploaded version and record it in history. */
export async function recordNewVersion(
  db: DB,
  ownerId: string,
  docId: string,
  v: {
    version: number;
    r2_key: string | null;
    source_type: 'upload' | 'url';
    source_url: string | null;
    filename: string | null;
    bytes: number | null;
    bumpDocument: boolean;
  },
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  if (v.bumpDocument) {
    stmts.push(
      db
        .prepare(
          'UPDATE documents SET current_version = ?1, r2_key = ?2, updated_at = ?3 WHERE id = ?4 AND owner_id = ?5',
        )
        .bind(v.version, v.r2_key, nowIso(), docId, ownerId),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version, filename, bytes, source_type, source_url, r2_key, replaced_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (document_id, version) DO NOTHING`,
      )
      .bind(
        uuid(),
        docId,
        v.version,
        v.filename,
        v.bytes,
        v.source_type,
        v.source_url,
        v.r2_key,
        ownerId,
      ),
  );
  await db.batch(stmts);
}

export async function updateDocumentPreview(
  db: DB,
  ownerId: string,
  docId: string,
  patch: { title?: string; og_description?: string | null; og_image_r2_key?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = ?${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(nowIso(), docId, ownerId);
  const n = vals.length;
  await db
    .prepare(
      `UPDATE documents SET ${sets.join(', ')}, updated_at = ?${n - 2} WHERE id = ?${n - 1} AND owner_id = ?${n}`,
    )
    .bind(...vals)
    .run();
}

export interface VersionRow {
  id: string;
  version: number;
  filename: string | null;
  bytes: number | null;
  source_type: 'upload' | 'url';
  source_url: string | null;
  replaced_at: string;
}

export async function listVersions(db: DB, ownerId: string, docId: string): Promise<VersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.version, v.filename, v.bytes, v.source_type, v.source_url, v.replaced_at
         FROM document_versions v JOIN documents d ON d.id = v.document_id
        WHERE v.document_id = ?1 AND d.owner_id = ?2
        ORDER BY v.version DESC`,
    )
    .bind(docId, ownerId)
    .all<VersionRow>();
  return results;
}

// ---------------------------------------------------------------- attachments

export interface AttachmentRow {
  id: string;
  document_id: string;
  owner_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  created_at: string;
}

export async function listAttachments(
  db: DB,
  ownerId: string,
  docId: string,
): Promise<AttachmentRow[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM document_attachments WHERE document_id = ?1 AND owner_id = ?2 ORDER BY created_at ASC',
    )
    .bind(docId, ownerId)
    .all<AttachmentRow>();
  return results;
}

export async function insertAttachment(db: DB, row: AttachmentRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_attachments (id, document_id, owner_id, filename, mime_type, size_bytes, r2_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      row.id,
      row.document_id,
      row.owner_id,
      row.filename,
      row.mime_type,
      row.size_bytes,
      row.r2_key,
    )
    .run();
}

/** Deletes and returns the row (so the caller can remove the R2 object), or null. */
export async function deleteAttachment(
  db: DB,
  ownerId: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  return db
    .prepare('DELETE FROM document_attachments WHERE id = ?1 AND owner_id = ?2 RETURNING *')
    .bind(attachmentId, ownerId)
    .first<AttachmentRow>();
}

// ---------------------------------------------------------------- shares

export const SHARE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;
export const RESERVED_SLUGS = new Set([
  'login',
  'signin',
  'sign-in',
  'support',
  'verify',
  'account',
  'accounts',
  'billing',
  'payment',
  'payments',
  'invoice',
  'secure',
  'admin',
  'api',
  'htmlradar',
  'www',
  'mail',
  'auth',
  'email',
  'm',
  '_doc',
  'privacy',
]);

const ADJECTIVES = [
  'swift',
  'silent',
  'bright',
  'golden',
  'crisp',
  'steady',
  'quick',
  'noble',
  'vivid',
  'calm',
];
const NOUNS = [
  'falcon',
  'river',
  'meadow',
  'signal',
  'beacon',
  'compass',
  'glass',
  'harbor',
  'prism',
  'ember',
];

function pick<T>(list: readonly T[]): T {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return list[a[0]! % list.length]!;
}

export interface ShareInput {
  recipient_label: string | null;
  require_email: boolean;
  verify_email: boolean;
  require_password: boolean;
  /** Plain password. On update, null/empty keeps the stored hash. */
  password: string | null;
  allowed_email_domains: string[] | null;
  allowed_emails: string[] | null;
  expires_at: string | null;
  lock_deck?: boolean;
  notify_first_open?: boolean;
}

/** Mirrors create_share (schema/055) minus custom domains and tiers. */
export async function createShare(
  db: DB,
  ownerId: string,
  documentId: string,
  input: ShareInput & { slug?: string | null },
): Promise<ShareRow> {
  const doc = await getDocument(db, ownerId, documentId);
  if (!doc) throw new OwnerError('document_not_found', 'Document not found.');
  if (input.verify_email && !input.require_email) {
    throw new OwnerError(
      'verify_requires_email',
      'Verifying the address needs the e-mail gate turned on.',
    );
  }

  let slug = (input.slug ?? '').trim().toLowerCase() || null;
  let custom = false;
  if (slug) {
    if (!SHARE_SLUG_PATTERN.test(slug)) throw new OwnerError('slug_invalid_format');
    if (RESERVED_SLUGS.has(slug)) throw new OwnerError('slug_reserved');
    const taken = await db
      .prepare('SELECT 1 FROM document_shares WHERE slug = ?1')
      .bind(slug)
      .first();
    if (taken) throw new OwnerError('slug_unavailable');
    custom = true;
  } else {
    for (;;) {
      slug = `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomHex(3)}`;
      const taken = await db
        .prepare('SELECT 1 FROM document_shares WHERE slug = ?1')
        .bind(slug)
        .first();
      if (!taken) break;
    }
  }

  let hash: string | null = null;
  if (input.require_password) {
    if (!input.password || input.password.length < 8) {
      throw new OwnerError('password_too_short', 'Password must be at least 8 characters.');
    }
    hash = await hashSharePassword(input.password);
  }

  const id = uuid();
  try {
    await db
      .prepare(
        `INSERT INTO document_shares (
           id, document_id, owner_id, slug, slug_is_custom, recipient_label,
           require_email, verify_email, require_password, password_hash,
           allowed_email_domains, allowed_emails, expires_at, lock_deck, notify_first_open)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        id,
        documentId,
        ownerId,
        slug,
        fromBool(custom),
        input.recipient_label,
        fromBool(input.require_email),
        fromBool(input.verify_email),
        fromBool(input.require_password),
        hash,
        fromArray(input.allowed_email_domains),
        fromArray(input.allowed_emails),
        input.expires_at,
        fromBool(input.lock_deck ?? true),
        fromBool(input.notify_first_open ?? true),
      )
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new OwnerError('slug_unavailable');
    throw e;
  }
  const share = await getShare(db, ownerId, id);
  if (!share) throw new OwnerError('share_create_failed');
  return share;
}

/** Mirrors update_share (schema/055). */
export async function updateShare(
  db: DB,
  ownerId: string,
  shareId: string,
  input: Omit<ShareInput, 'verify_email'> & { verify_email: boolean | null },
): Promise<ShareRow> {
  const current = await getShare(db, ownerId, shareId);
  if (!current) throw new OwnerError('share_not_found', 'Share not found.');

  let hash: string | null = null;
  if (input.require_password) {
    if (input.password) {
      if (input.password.length < 8) {
        throw new OwnerError('password_too_short', 'Password must be at least 8 characters.');
      }
      hash = await hashSharePassword(input.password);
    } else {
      hash = current.password_hash;
    }
    if (!hash) {
      throw new OwnerError('password_too_short', 'Set a password of at least 8 characters.');
    }
  }
  let verify = input.verify_email ?? current.verify_email;
  if (!input.require_email) verify = false;

  await db
    .prepare(
      `UPDATE document_shares SET
         recipient_label = ?1, require_email = ?2, require_password = ?3, password_hash = ?4,
         allowed_email_domains = ?5, allowed_emails = ?6, expires_at = ?7, verify_email = ?8,
         lock_deck = ?9, notify_first_open = ?10
       WHERE id = ?11 AND owner_id = ?12`,
    )
    .bind(
      input.recipient_label,
      fromBool(input.require_email),
      fromBool(input.require_password),
      hash,
      fromArray(input.allowed_email_domains),
      fromArray(input.allowed_emails),
      input.expires_at,
      fromBool(verify),
      fromBool(input.lock_deck ?? current.lock_deck),
      fromBool(input.notify_first_open ?? current.notify_first_open),
      shareId,
      ownerId,
    )
    .run();
  const share = await getShare(db, ownerId, shareId);
  if (!share) throw new OwnerError('share_not_found');
  return share;
}

export async function getShare(db: DB, ownerId: string, shareId: string): Promise<ShareRow | null> {
  const r = await db
    .prepare('SELECT * FROM document_shares WHERE id = ?1 AND owner_id = ?2')
    .bind(shareId, ownerId)
    .first<Raw>();
  return r ? rowShare(r) : null;
}

export type ShareWithDoc = ShareRow & { document_title: string };

/** A share on a live document, by slug. */
export async function getShareBySlug(
  db: DB,
  ownerId: string,
  slug: string,
): Promise<ShareWithDoc | null> {
  const r = await db
    .prepare(
      `SELECT s.*, d.title AS document_title
         FROM document_shares s JOIN documents d ON d.id = s.document_id
        WHERE s.slug = ?1 AND s.owner_id = ?2 AND d.deleted_at IS NULL`,
    )
    .bind(slug, ownerId)
    .first<Raw>();
  return r ? { ...rowShare(r), document_title: String(r['document_title']) } : null;
}

export async function listSharesForDocument(
  db: DB,
  ownerId: string,
  docId: string,
): Promise<ShareRow[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM document_shares WHERE document_id = ?1 AND owner_id = ?2 ORDER BY created_at DESC',
    )
    .bind(docId, ownerId)
    .all<Raw>();
  return results.map(rowShare);
}

/** Every share on the owner's live documents, newest first, with the document title. */
export async function listShares(
  db: DB,
  ownerId: string,
  opts: { activeOnly?: boolean; before?: { created_at: string; id: string }; limit?: number } = {},
): Promise<ShareWithDoc[]> {
  const where = ['s.owner_id = ?1', 'd.deleted_at IS NULL'];
  const vals: unknown[] = [ownerId];
  if (opts.activeOnly) where.push('s.revoked_at IS NULL');
  if (opts.before) {
    vals.push(opts.before.created_at, opts.before.id);
    where.push(`(s.created_at < ?2 OR (s.created_at = ?2 AND s.id < ?3))`);
  }
  const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '';
  const { results } = await db
    .prepare(
      `SELECT s.*, d.title AS document_title
         FROM document_shares s JOIN documents d ON d.id = s.document_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC, s.id DESC${limit}`,
    )
    .bind(...vals)
    .all<Raw>();
  return results.map((r) => ({ ...rowShare(r), document_title: String(r['document_title']) }));
}

/** Flip revoked_at. Returns the new value. */
export async function countShares(db: DB, ownerId: string): Promise<number> {
  const r = await db
    .prepare('SELECT count(*) AS n FROM document_shares WHERE owner_id = ?1')
    .bind(ownerId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * First and last open per share, for the given shares of this owner. Internal
 * viewers are not opens. Keep `shareIds` to a page (D1 binds ~100 params).
 */
export async function shareOpenSummary(
  db: DB,
  ownerId: string,
  shareIds: string[],
): Promise<Map<string, { first_open: string; last_open: string }>> {
  const out = new Map<string, { first_open: string; last_open: string }>();
  if (!shareIds.length) return out;
  const marks = shareIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT se.share_id, min(se.started_at) AS first_open, max(se.started_at) AS last_open
         FROM sessions se
         JOIN document_shares sh ON sh.id = se.share_id
         JOIN viewers v ON v.id = se.viewer_id
        WHERE sh.owner_id = ?1 AND v.is_internal = 0 AND se.share_id IN (${marks})
        GROUP BY se.share_id`,
    )
    .bind(ownerId, ...shareIds)
    .all<{ share_id: string; first_open: string; last_open: string }>();
  for (const r of results)
    out.set(r.share_id, { first_open: r.first_open, last_open: r.last_open });
  return out;
}

export async function toggleShareRevoked(
  db: DB,
  ownerId: string,
  shareId: string,
): Promise<string | null> {
  const share = await getShare(db, ownerId, shareId);
  if (!share) throw new OwnerError('share_not_found', 'Share not found.');
  const next = share.revoked_at ? null : nowIso();
  await db
    .prepare('UPDATE document_shares SET revoked_at = ?1 WHERE id = ?2 AND owner_id = ?3')
    .bind(next, shareId, ownerId)
    .run();
  return next;
}

export async function revokeShare(db: DB, ownerId: string, shareId: string): Promise<ShareRow> {
  await db
    .prepare(
      'UPDATE document_shares SET revoked_at = ?1 WHERE id = ?2 AND owner_id = ?3 AND revoked_at IS NULL',
    )
    .bind(nowIso(), shareId, ownerId)
    .run();
  const share = await getShare(db, ownerId, shareId);
  if (!share) throw new OwnerError('share_not_found', 'Share not found.');
  return share;
}

/**
 * Delete a share. A custom-slug link is revoked instead so its address can
 * never be handed to another document. Returns what happened.
 */
export async function deleteShare(
  db: DB,
  ownerId: string,
  shareId: string,
): Promise<'deleted' | 'revoked'> {
  const share = await getShare(db, ownerId, shareId);
  if (!share) throw new OwnerError('share_not_found', 'Share not found.');
  if (share.slug_is_custom) {
    await revokeShare(db, ownerId, shareId);
    return 'revoked';
  }
  await db
    .prepare('DELETE FROM document_shares WHERE id = ?1 AND owner_id = ?2')
    .bind(shareId, ownerId)
    .run();
  return 'deleted';
}

export async function setShareLockDeck(
  db: DB,
  ownerId: string,
  shareId: string,
  lockDeck: boolean,
): Promise<void> {
  await db
    .prepare('UPDATE document_shares SET lock_deck = ?1 WHERE id = ?2 AND owner_id = ?3')
    .bind(fromBool(lockDeck), shareId, ownerId)
    .run();
}

// ---------------------------------------------------------------- analytics reads

/** Scope for analytics reads: one document, one share, or everything the owner has. */
export type Scope = { documentId?: string; shareId?: string };

function scopeSql(scope: Scope, first: number): { sql: string; vals: unknown[] } {
  const parts: string[] = [];
  const vals: unknown[] = [];
  if (scope.documentId) {
    vals.push(scope.documentId);
    parts.push(`sh.document_id = ?${first + vals.length - 1}`);
  }
  if (scope.shareId) {
    vals.push(scope.shareId);
    parts.push(`sh.id = ?${first + vals.length - 1}`);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', vals };
}

export async function listViewers(db: DB, ownerId: string, scope: Scope): Promise<ViewerRow[]> {
  const s = scopeSql(scope, 2);
  const { results } = await db
    .prepare(
      `SELECT v.* FROM viewers v
         JOIN document_shares sh ON sh.id = v.share_id
         JOIN documents d ON d.id = sh.document_id
        WHERE sh.owner_id = ?1 AND d.deleted_at IS NULL${s.sql}`,
    )
    .bind(ownerId, ...s.vals)
    .all<Raw>();
  return results.map(rowViewer);
}

export async function listSessions(
  db: DB,
  ownerId: string,
  scope: Scope,
  opts: { since?: string; limit?: number } = {},
): Promise<SessionRow[]> {
  const s = scopeSql(scope, 2);
  const vals = [ownerId, ...s.vals];
  let since = '';
  if (opts.since) {
    vals.push(opts.since);
    since = ` AND se.started_at >= ?${vals.length}`;
  }
  const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '';
  const { results } = await db
    .prepare(
      `SELECT se.* FROM sessions se
         JOIN document_shares sh ON sh.id = se.share_id
         JOIN documents d ON d.id = sh.document_id
        WHERE sh.owner_id = ?1 AND d.deleted_at IS NULL${s.sql}${since}
        ORDER BY se.started_at DESC${limit}`,
    )
    .bind(...vals)
    .all<Raw>();
  return results.map(rowSession);
}

export interface SectionEventRow {
  session_id: string;
  section_id: string;
  section_title: string | null;
  time_seconds: number;
  ordinal: number | null;
}

export async function listSectionEvents(
  db: DB,
  ownerId: string,
  scope: Scope,
): Promise<SectionEventRow[]> {
  const s = scopeSql(scope, 2);
  const { results } = await db
    .prepare(
      `SELECT ev.session_id, ev.section_id, ev.section_title, ev.time_seconds, ev.ordinal
         FROM section_events ev
         JOIN sessions se ON se.id = ev.session_id
         JOIN document_shares sh ON sh.id = se.share_id
        WHERE sh.owner_id = ?1${s.sql}`,
    )
    .bind(ownerId, ...s.vals)
    .all<SectionEventRow>();
  return results;
}

export async function listEmailVerifications(
  db: DB,
  ownerId: string,
  scope: Scope,
): Promise<Array<{ share_id: string; email: string }>> {
  const s = scopeSql(scope, 2);
  const { results } = await db
    .prepare(
      `SELECT ev.share_id, ev.email FROM share_email_verifications ev
         JOIN document_shares sh ON sh.id = ev.share_id
        WHERE sh.owner_id = ?1${s.sql}`,
    )
    .bind(ownerId, ...s.vals)
    .all<{ share_id: string; email: string }>();
  return results;
}

export async function listAttachmentDownloads(
  db: DB,
  ownerId: string,
  scope: Scope,
): Promise<
  Array<{
    share_id: string;
    viewer_id: string | null;
    filename: string | null;
    downloaded_at: string;
  }>
> {
  const s = scopeSql(scope, 2);
  const { results } = await db
    .prepare(
      `SELECT ad.share_id, ad.viewer_id, ad.filename, ad.downloaded_at FROM attachment_downloads ad
         JOIN document_shares sh ON sh.id = ad.share_id
        WHERE sh.owner_id = ?1${s.sql}
        ORDER BY ad.downloaded_at DESC`,
    )
    .bind(ownerId, ...s.vals)
    .all<{
      share_id: string;
      viewer_id: string | null;
      filename: string | null;
      downloaded_at: string;
    }>();
  return results;
}

/** Mark a viewer as internal (hidden from stats) — owner of its share only. */
export async function setViewerInternal(
  db: DB,
  ownerId: string,
  viewerId: string,
  internal: boolean | null,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT v.is_internal FROM viewers v JOIN document_shares sh ON sh.id = v.share_id
        WHERE v.id = ?1 AND sh.owner_id = ?2`,
    )
    .bind(viewerId, ownerId)
    .first<{ is_internal: number }>();
  if (!row) throw new OwnerError('viewer_not_found', 'Viewer not found.');
  const next = internal ?? !toBool(row.is_internal);
  await db
    .prepare('UPDATE viewers SET is_internal = ?1 WHERE id = ?2')
    .bind(fromBool(next), viewerId)
    .run();
}

// ---------------------------------------------------------------- API keys

export interface ApiKeyRow {
  id: string;
  user_id: string;
  label: string;
  key_prefix: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listApiKeys(db: DB, ownerId: string): Promise<ApiKeyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, label, key_prefix, scope, created_at, last_used_at, revoked_at
         FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC`,
    )
    .bind(ownerId)
    .all<ApiKeyRow>();
  return results;
}

export async function insertApiKey(
  db: DB,
  ownerId: string,
  row: { key_hash: string; key_prefix: string; label: string; scope: 'full' | 'read_only' },
): Promise<void> {
  const live = await db
    .prepare('SELECT count(*) AS n FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL')
    .bind(ownerId)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= 10) {
    throw new OwnerError(
      'api_key_limit',
      'You already have 10 active keys. Revoke one to create another.',
    );
  }
  await db
    .prepare(
      'INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    .bind(uuid(), ownerId, row.key_hash, row.key_prefix, row.label, row.scope)
    .run();
}

export async function revokeApiKey(db: DB, ownerId: string, keyId: string): Promise<void> {
  await db
    .prepare(
      'UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL',
    )
    .bind(nowIso(), keyId, ownerId)
    .run();
}

/** Look up a live key by its SHA-256 hash; stamps last_used_at. */
export async function findApiKeyByHash(
  db: DB,
  keyHash: string,
): Promise<(ApiKeyRow & { email: string }) | null> {
  const row = await db
    .prepare(
      `SELECT k.id, k.user_id, k.label, k.key_prefix, k.scope, k.created_at, k.last_used_at, k.revoked_at, p.email
         FROM api_keys k JOIN profiles p ON p.id = k.user_id
        WHERE k.key_hash = ?1 AND k.revoked_at IS NULL`,
    )
    .bind(keyHash)
    .first<ApiKeyRow & { email: string }>();
  if (row) {
    await db
      .prepare('UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2')
      .bind(nowIso(), row.id)
      .run();
  }
  return row;
}

export { hitRateLimit, sha256Hex };
