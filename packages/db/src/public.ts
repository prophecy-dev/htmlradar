// The recipient side's data access: everything the proxy worker reads or
// writes on behalf of somebody opening a link.
//
// Ported from the Postgres functions upstream kept in schema/ (share_lookup_for,
// verify_share_password, issue/check_email_verification_code, start_session,
// update_session and the notify_on_first_open trigger). Their rules are kept;
// what went is what only a hosted multi-tenant product needed — handles,
// customer domains, tiers, abuse reports, app_events.
//
// Errors a recipient's tracker can act on are thrown as RpcFailure with the
// same P-codes the Postgres functions raised, so the tracker's messages still
// line up (see packages/tracker/src/index.ts humanError). Comments are this
// fork's own addition and take the first free codes after upstream's last
// one: P0011 comments_not_enabled, P0012 not_verified, P0013 comment_empty.

import { hitRateLimit, nowIso, randomHex, toBool, uuid, type DB } from './d1.js';
import { rowShare, type ShareRow } from './types.js';
import { verifySharePassword } from './password.js';

export class RpcFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- lookups

/** A share plus what the recipient path needs about its owner and document. */
export interface PublicShare extends ShareRow {
  owner_email: string | null;
  owner_display_name: string | null;
  document_title: string | null;
  document_og_description: string | null;
  document_og_image_r2_key: string | null;
}

export async function getShareBySlug(db: DB, slug: string): Promise<PublicShare | null> {
  const r = await db
    .prepare(
      `SELECT s.*, p.email AS owner_email, p.display_name AS owner_display_name,
              d.title AS document_title, d.og_description AS document_og_description,
              d.og_image_r2_key AS document_og_image_r2_key
         FROM document_shares s
         LEFT JOIN profiles p ON p.id = s.owner_id
         LEFT JOIN documents d ON d.id = s.document_id
        WHERE s.slug = ?1
        LIMIT 1`,
    )
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!r) return null;
  return {
    ...rowShare(r),
    owner_email: (r['owner_email'] as string | null) ?? null,
    owner_display_name: (r['owner_display_name'] as string | null) ?? null,
    document_title: (r['document_title'] as string | null) ?? null,
    document_og_description: (r['document_og_description'] as string | null) ?? null,
    document_og_image_r2_key: (r['document_og_image_r2_key'] as string | null) ?? null,
  };
}

export interface PublicDocument {
  id: string;
  owner_id: string;
  title: string;
  source_type: 'upload' | 'url';
  source_url: string | null;
  current_version: number;
  r2_key: string | null;
  deleted_at: string | null;
}

export async function getDocument(db: DB, id: string): Promise<PublicDocument | null> {
  return db
    .prepare(
      `SELECT id, owner_id, title, source_type, source_url, current_version, r2_key, deleted_at
         FROM documents WHERE id = ?1`,
    )
    .bind(id)
    .first<PublicDocument>();
}

export interface Attachment {
  id: string;
  document_id: string;
  owner_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  created_at: string;
}

export async function getAttachment(db: DB, id: string): Promise<Attachment | null> {
  return db
    .prepare(`SELECT * FROM document_attachments WHERE id = ?1`)
    .bind(id)
    .first<Attachment>();
}

export async function listAttachmentsForDocument(
  db: DB,
  documentId: string,
): Promise<Attachment[]> {
  const { results } = await db
    .prepare(`SELECT * FROM document_attachments WHERE document_id = ?1 ORDER BY created_at ASC`)
    .bind(documentId)
    .all<Attachment>();
  return results;
}

export async function getViewerIdByShareEmail(
  db: DB,
  shareId: string,
  email: string,
): Promise<string | null> {
  const r = await db
    .prepare(`SELECT id FROM viewers WHERE share_id = ?1 AND lower(email) = lower(?2) LIMIT 1`)
    .bind(shareId, email)
    .first<{ id: string }>();
  return r?.id ?? null;
}

export async function logAttachmentDownload(
  db: DB,
  p: {
    attachment_id: string;
    share_id: string;
    recipient_email: string | null;
    country_code: string | null;
    device_type: string | null;
    user_agent: string | null;
    viewer_id: string | null;
    session_id: string | null;
    filename: string | null;
    size_bytes: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachment_downloads
         (id, attachment_id, share_id, viewer_id, session_id, recipient_email, filename,
          size_bytes, country_code, device_type, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      uuid(),
      p.attachment_id,
      p.share_id,
      p.viewer_id,
      p.session_id,
      p.recipient_email,
      p.filename,
      p.size_bytes,
      p.country_code,
      p.device_type,
      p.user_agent,
    )
    .run();
}

// ---------------------------------------------------------------- password gate

/** 'rate_limited' after 5 tries a minute per link (upstream 004). */
export async function checkSharePassword(
  db: DB,
  slug: string,
  password: string,
): Promise<'ok' | 'bad' | 'rate_limited'> {
  if (!(await hitRateLimit(db, `pwd:${slug}`, 5, 60))) return 'rate_limited';
  const r = await db
    .prepare(`SELECT password_hash FROM document_shares WHERE slug = ?1 AND require_password = 1`)
    .bind(slug)
    .first<{ password_hash: string | null }>();
  if (!r?.password_hash) return 'bad';
  return (await verifySharePassword(password, r.password_hash)) ? 'ok' : 'bad';
}

// ---------------------------------------------------------------- verified e-mail gate

const CODE_TTL_MS = 10 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/**
 * Records a code (stored as a keyed hash made by the caller) and says whether
 * the limits allowed it. Called for EVERY address, permitted or not, so a
 * refused address is not the fast path; `permitted` only decides whether the
 * request spends that address's own budget (upstream 055, finding 5).
 *
 * Limits, as upstream: 3 per link+address per 15 min; 5 per address per
 * sender per hour; 15 per address per hour; 20 per network per hour.
 */
export async function issueEmailVerificationCode(
  db: DB,
  p: {
    shareId: string;
    email: string;
    codeHash: string;
    challenge: string;
    ipHash: string | null;
    permitted: boolean;
  },
): Promise<'ok' | 'rate_limited' | 'not_enabled' | 'no_share'> {
  const email = p.email.trim().toLowerCase();
  const share = await db
    .prepare(
      `SELECT owner_id, verify_email, require_email, revoked_at, expires_at
         FROM document_shares WHERE id = ?1`,
    )
    .bind(p.shareId)
    .first<Record<string, unknown>>();
  if (!share) return 'no_share';
  if (!toBool(share['verify_email']) || !toBool(share['require_email'])) return 'not_enabled';
  const expires = share['expires_at'] as string | null;
  if (share['revoked_at'] || (expires && Date.parse(expires) < Date.now())) return 'no_share';
  const ownerId = share['owner_id'] as string;

  const count = async (sql: string, ...args: unknown[]): Promise<number> =>
    (
      await db
        .prepare(sql)
        .bind(...args)
        .first<{ n: number }>()
    )?.n ?? 0;

  if (
    (await count(
      `SELECT count(*) AS n FROM email_verification_codes
        WHERE share_id = ?1 AND email = ?2 AND counts_toward_address = 1 AND created_at > ?3`,
      p.shareId,
      email,
      ago(15 * 60 * 1000),
    )) >= 3
  )
    return 'rate_limited';
  if (
    (await count(
      `SELECT count(*) AS n FROM email_verification_codes
        WHERE email = ?1 AND owner_id = ?2 AND counts_toward_address = 1 AND created_at > ?3`,
      email,
      ownerId,
      ago(60 * 60 * 1000),
    )) >= 5
  )
    return 'rate_limited';
  if (
    (await count(
      `SELECT count(*) AS n FROM email_verification_codes
        WHERE email = ?1 AND counts_toward_address = 1 AND created_at > ?2`,
      email,
      ago(60 * 60 * 1000),
    )) >= 15
  )
    return 'rate_limited';
  if (
    p.ipHash &&
    (await count(
      `SELECT count(*) AS n FROM email_verification_codes WHERE ip_hash = ?1 AND created_at > ?2`,
      p.ipHash,
      ago(60 * 60 * 1000),
    )) >= 20
  )
    return 'rate_limited';

  const now = nowIso();
  await db.batch([
    // One browser holds one live code: a new request retires the previous one
    // bound to the same challenge, so it gets five guesses, not fifteen.
    db
      .prepare(
        `UPDATE email_verification_codes SET expires_at = ?4
          WHERE share_id = ?1 AND email = ?2 AND challenge = ?3
            AND used_at IS NULL AND expires_at > ?4`,
      )
      .bind(p.shareId, email, p.challenge, now),
    db
      .prepare(
        `INSERT INTO email_verification_codes
           (id, share_id, email, code_hash, challenge, ip_hash, owner_id,
            counts_toward_address, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        uuid(),
        p.shareId,
        email,
        p.codeHash,
        p.challenge,
        p.ipHash,
        ownerId,
        p.permitted ? 1 : 0,
        new Date(Date.now() + CODE_TTL_MS).toISOString(),
        now,
      ),
  ]);
  return 'ok';
}

/** Constant-time comparison of two equal-length hex strings. */
function ctEq(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Spends one attempt. Every way of being wrong is 'bad' (upstream item B).
 * Five attempts per code, then it is burnt.
 */
export async function checkEmailVerificationCode(
  db: DB,
  p: { shareId: string; email: string; codeHash: string; challenge: string },
): Promise<'ok' | 'bad'> {
  const email = p.email.trim().toLowerCase();
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT id, code_hash FROM email_verification_codes
        WHERE share_id = ?1 AND email = ?2 AND challenge = ?3
          AND used_at IS NULL AND expires_at > ?4 AND attempts < 5
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(p.shareId, email, p.challenge, now)
    .first<{ id: string; code_hash: string }>();
  if (!row) {
    ctEq('0'.repeat(64), p.codeHash);
    return 'bad';
  }
  const match = ctEq(row.code_hash, p.codeHash);
  // The attempt is counted in the same statement that checks it is still under
  // five, so two parallel guesses cannot both spend the fifth.
  const spent = await db
    .prepare(
      `UPDATE email_verification_codes
          SET attempts = attempts + 1, used_at = CASE WHEN ?2 THEN ?3 ELSE used_at END
        WHERE id = ?1 AND attempts < 5 AND used_at IS NULL`,
    )
    .bind(row.id, match ? 1 : 0, now)
    .run();
  if (!match || (spent.meta.changes ?? 0) === 0) return 'bad';

  await db
    .prepare(
      `INSERT INTO share_email_verifications (share_id, email, first_verified_at, last_verified_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (share_id, email) DO UPDATE SET last_verified_at = excluded.last_verified_at`,
    )
    .bind(p.shareId, email, now)
    .run();
  return 'ok';
}

// ---------------------------------------------------------------- tracker sessions

export interface StartSessionInput {
  p_share_slug: string;
  p_email: string | null;
  p_fingerprint: string | null;
  p_referrer: string | null;
  p_user_agent: string | null;
  p_country_code?: string | null;
  p_city?: string | null;
  p_device_type?: string | null;
  p_os?: string | null;
  p_browser?: string | null;
}

export interface StartSessionResult {
  session_id: string;
  token: string;
  document_id: string;
  document_version: number;
}

const s = (v: unknown, max = 512): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

/** Upstream start_session (schema/036), same checks and error codes. */
export async function startSession(db: DB, input: StartSessionInput): Promise<StartSessionResult> {
  const slug = s(input.p_share_slug, 128);
  if (!slug) throw new RpcFailure('P0002', 'share_not_found');
  const identity = (input.p_email ?? '').toLowerCase() || input.p_fingerprint || 'anon';
  if (!(await hitRateLimit(db, `start:${slug}:${identity}`, 5, 60))) {
    throw new RpcFailure('P0001', 'rate_limited');
  }

  const share = await getShareBySlug(db, slug);
  if (!share) throw new RpcFailure('P0002', 'share_not_found');
  if (share.revoked_at) throw new RpcFailure('P0003', 'share_revoked');
  if (share.expires_at && Date.parse(share.expires_at) < Date.now()) {
    throw new RpcFailure('P0004', 'share_expired');
  }

  let email: string | null = null;
  if (share.require_email) {
    const raw = (input.p_email ?? '').trim();
    if (!raw) throw new RpcFailure('P0005', 'email_required');
    if (!EMAIL_RE.test(raw)) throw new RpcFailure('P0006', 'email_invalid');
    // The proxy's gate rule: with any allow-list set, the address passes when
    // it is on the address list OR its domain is on the domain list.
    const lower = raw.toLowerCase();
    const domains = (share.allowed_email_domains ?? []).map((d) => d.toLowerCase());
    const emails = (share.allowed_emails ?? []).map((e) => e.toLowerCase());
    if (
      (domains.length > 0 || emails.length > 0) &&
      !emails.includes(lower) &&
      !domains.includes(lower.split('@')[1] ?? '')
    ) {
      throw new RpcFailure('P0007', 'email_domain_not_allowed');
    }
    email = raw.toLowerCase();
  }

  const doc = await getDocument(db, share.document_id);
  if (!doc || doc.deleted_at) throw new RpcFailure('P0008', 'document_deleted');

  // The link's own owner reading their link is flagged internal, and nobody
  // else is; a viewer once hidden stays hidden across later visits.
  const isInternal = !!email && !!share.owner_email && share.owner_email.toLowerCase() === email;
  const now = nowIso();
  const common = [
    s(input.p_referrer, 2048),
    s(input.p_user_agent, 1024),
    s(input.p_country_code, 8),
    s(input.p_city, 128),
    s(input.p_device_type, 32),
    s(input.p_os, 64),
    s(input.p_browser, 64),
  ];

  let viewer: { id: string } | null;
  if (email) {
    viewer = await db
      .prepare(
        `INSERT INTO viewers (id, share_id, email, referrer, user_agent, country_code, city,
                              device_type, os, browser, is_internal, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT (share_id, lower(email)) WHERE email IS NOT NULL DO UPDATE SET
           last_seen = excluded.last_seen,
           visit_count = viewers.visit_count + 1,
           country_code = coalesce(excluded.country_code, viewers.country_code),
           device_type = coalesce(excluded.device_type, viewers.device_type),
           is_internal = max(viewers.is_internal, excluded.is_internal)
         RETURNING id`,
      )
      .bind(uuid(), share.id, email, ...common, isInternal ? 1 : 0, now)
      .first<{ id: string }>();
  } else {
    const fp = s(input.p_fingerprint, 128);
    if (!fp) throw new RpcFailure('P0009', 'identity_required');
    viewer = await db
      .prepare(
        `INSERT INTO viewers (id, share_id, fingerprint, referrer, user_agent, country_code, city,
                              device_type, os, browser, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT (share_id, fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE SET
           last_seen = excluded.last_seen,
           visit_count = viewers.visit_count + 1
         RETURNING id`,
      )
      .bind(uuid(), share.id, fp, ...common, now)
      .first<{ id: string }>();
  }
  if (!viewer) throw new RpcFailure('P0009', 'identity_required');

  const sessionId = uuid();
  const token = randomHex(32);
  await db
    .prepare(
      `INSERT INTO sessions (id, share_id, viewer_id, document_version, token, started_at, last_heartbeat_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
    .bind(sessionId, share.id, viewer.id, doc.current_version, token, now)
    .run();

  return {
    session_id: sessionId,
    token,
    document_id: doc.id,
    document_version: doc.current_version,
  };
}

export interface UpdateSessionInput {
  p_session_id: string;
  p_token: string;
  p_active_seconds: number;
  p_max_scroll: number;
  p_sections: unknown;
}

/** What the caller needs to send a first-read alert. */
export interface FirstReadAlert {
  sessionId: string;
  documentId: string;
  ownerEmail: string;
  ownerName: string | null;
  ownerTimezone: string;
  telegramChatId: string | null;
  documentTitle: string;
  slug: string;
  recipientLabel: string | null;
  viewerEmail: string | null;
  viewerCountry: string | null;
  viewerCity: string | null;
  viewerDevice: string | null;
  referrer: string | null;
}

export interface UpdateSessionResult {
  ok: true;
  /** Set when this update is the session's first evidence of reading and the
   *  owner should be told. The caller sends it and calls recordNotification. */
  alert: FirstReadAlert | null;
}

const clamp = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
};

/** Upstream update_session (schema/005) plus the evidence-based first-read
 *  notification decision (schema/054). */
export async function updateSession(
  db: DB,
  input: UpdateSessionInput,
): Promise<UpdateSessionResult> {
  const sessionId = s(input.p_session_id, 64);
  if (!sessionId) throw new RpcFailure('P0010', 'invalid_token');
  if (!(await hitRateLimit(db, `update:${sessionId}`, 30, 60))) {
    throw new RpcFailure('P0001', 'rate_limited');
  }
  const before = await db
    .prepare(
      `SELECT token, active_time_seconds, max_scroll_depth, notification_sent_at
         FROM sessions WHERE id = ?1`,
    )
    .bind(sessionId)
    .first<{
      token: string;
      active_time_seconds: number;
      max_scroll_depth: number;
      notification_sent_at: string | null;
    }>();
  if (!before || typeof input.p_token !== 'string' || !ctEq(before.token, input.p_token)) {
    throw new RpcFailure('P0010', 'invalid_token');
  }
  const hadSectionTime =
    ((
      await db
        .prepare(
          `SELECT count(*) AS n FROM section_events WHERE session_id = ?1 AND time_seconds > 0`,
        )
        .bind(sessionId)
        .first<{ n: number }>()
    )?.n ?? 0) > 0;

  const active = Math.round(clamp(input.p_active_seconds, 0, 86400));
  const scroll = clamp(input.p_max_scroll, 0, 1);
  const now = nowIso();

  const stmts = [
    db
      .prepare(
        `UPDATE sessions SET
           active_time_seconds = max(active_time_seconds, ?2),
           max_scroll_depth = max(max_scroll_depth, ?3),
           last_heartbeat_at = ?4
         WHERE id = ?1`,
      )
      .bind(sessionId, active, scroll, now),
  ];
  let newSectionTime = false;
  if (Array.isArray(input.p_sections)) {
    for (const raw of input.p_sections.slice(0, 500)) {
      if (!raw || typeof raw !== 'object') continue;
      const sec = raw as Record<string, unknown>;
      const sid = s(sec['section_id'], 256);
      if (!sid) continue;
      const time = clamp(sec['time_seconds'], 0, 86400);
      if (time > 0) newSectionTime = true;
      const depth = Number.isFinite(Number(sec['depth'])) ? Math.trunc(Number(sec['depth'])) : null;
      const ordinal = Number.isFinite(Number(sec['ordinal']))
        ? Math.trunc(Number(sec['ordinal']))
        : null;
      stmts.push(
        db
          .prepare(
            `INSERT INTO section_events (id, session_id, section_id, section_title, depth, ordinal, time_seconds, entered_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (session_id, section_id) DO UPDATE SET
               time_seconds = max(section_events.time_seconds, excluded.time_seconds),
               section_title = coalesce(excluded.section_title, section_events.section_title)`,
          )
          .bind(uuid(), sessionId, sid, s(sec['section_title'], 512), depth, ordinal, time, now),
      );
    }
  }
  await db.batch(stmts);

  // Evidence of reading: any active time, any scroll, or any section dwell.
  // Section dwell is the one that matters for decks that scroll inside a
  // container and for readers who move only the mouse (upstream 054 notes).
  const hadEvidence =
    before.active_time_seconds > 0 || before.max_scroll_depth > 0 || hadSectionTime;
  const hasEvidence = active > 0 || scroll > 0 || newSectionTime || hadEvidence;
  if (hadEvidence || !hasEvidence || before.notification_sent_at) {
    return { ok: true, alert: null };
  }
  return { ok: true, alert: await decideFirstReadAlert(db, sessionId) };
}

/**
 * The notify_on_first_open trigger's decision, run once per session when its
 * first evidence arrives. Returns the alert to send, or null after logging why
 * none is due. Claims the session (notification_sent_at) before returning an
 * alert so a racing second report cannot send it twice.
 */
async function decideFirstReadAlert(db: DB, sessionId: string): Promise<FirstReadAlert | null> {
  const r = await db
    .prepare(
      `SELECT s.id AS session_id, s.viewer_id, sh.id AS share_id, sh.slug, sh.recipient_label,
              sh.notify_first_open, d.id AS document_id, d.title,
              v.email AS viewer_email, v.fingerprint, v.is_internal, v.country_code, v.city,
              v.device_type, v.referrer,
              p.email AS owner_email, p.display_name, p.timezone, p.telegram_chat_id
         FROM sessions s
         JOIN document_shares sh ON sh.id = s.share_id
         JOIN documents d ON d.id = sh.document_id
         JOIN viewers v ON v.id = s.viewer_id
         JOIN profiles p ON p.id = d.owner_id
        WHERE s.id = ?1`,
    )
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!r) return null;
  const ownerEmail = r['owner_email'] as string;

  const skip = async (reason: string): Promise<null> => {
    await recordNotification(db, sessionId, 'email', ownerEmail, 'skipped', reason);
    return null;
  };

  if (!toBool(r['notify_first_open'])) return skip('first-open alert disabled on this share');

  // The same reader on the same document, on any of its links, was already
  // told about: only sessions that actually notified count (upstream 054).
  const viewerEmail = r['viewer_email'] as string | null;
  const fingerprint = r['fingerprint'] as string | null;
  if (toBool(r['is_internal'])) return skip('viewer marked internal');

  // Check-for-an-earlier-alert and claim in ONE statement. D1 runs statements
  // one at a time, so two sessions of the same reader (two tabs, a heartbeat
  // racing a page-close flush) cannot both pass the check and both claim —
  // upstream 054 held an advisory lock on (document, reader) for this.
  const identity = viewerEmail ? 'lower(v.email) = lower(?4)' : 'v.fingerprint = ?4';
  const claimed = await db
    .prepare(
      `UPDATE sessions SET notification_sent_at = ?2
        WHERE id = ?1 AND notification_sent_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
              JOIN viewers v ON v.id = s.viewer_id
              JOIN document_shares ds ON ds.id = s.share_id
             WHERE ds.document_id = ?3 AND s.notification_sent_at IS NOT NULL
               AND s.id <> ?1 AND ${identity})`,
    )
    .bind(sessionId, nowIso(), r['document_id'], viewerEmail ?? fingerprint ?? '')
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    return skip('repeat open by same recipient on this document');
  }

  return {
    sessionId,
    documentId: r['document_id'] as string,
    ownerEmail,
    ownerName: (r['display_name'] as string | null) ?? null,
    ownerTimezone: (r['timezone'] as string | null) ?? 'UTC',
    telegramChatId: (r['telegram_chat_id'] as string | null) ?? null,
    documentTitle: r['title'] as string,
    slug: r['slug'] as string,
    recipientLabel: (r['recipient_label'] as string | null) ?? null,
    viewerEmail,
    viewerCountry: (r['country_code'] as string | null) ?? null,
    viewerCity: (r['city'] as string | null) ?? null,
    viewerDevice: (r['device_type'] as string | null) ?? null,
    referrer: (r['referrer'] as string | null) ?? null,
  };
}

export async function recordNotification(
  db: DB,
  sessionId: string | null,
  channel: 'email' | 'telegram',
  to: string | null,
  status: 'queued' | 'delivered' | 'failed' | 'skipped',
  error: string | null = null,
  kind = 'first_read',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications_log (id, session_id, kind, channel, email_to, status, error_message)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(uuid(), sessionId, kind, channel, to, status, error)
    .run();
}

// ---------------------------------------------------------------- comments

/** Longer bodies are trimmed to this, not refused: nobody loses their note. */
const MAX_COMMENT_CHARS = 2000;

export interface AddCommentInput {
  p_session_id: string;
  p_token: string;
  /** The section tracker's id for the heading commented on; null = whole document. */
  p_section_id: string | null;
  p_section_title: string | null;
  p_body: string;
}

/** What the caller needs to tell the owner that a comment arrived. */
export interface CommentAlert {
  commentId: string;
  sessionId: string;
  documentId: string;
  documentTitle: string;
  ownerEmail: string;
  ownerName: string | null;
  telegramChatId: string | null;
  slug: string;
  recipientLabel: string | null;
  /** The address the reader proved. Never empty: an unverified reader cannot get here. */
  viewerEmail: string;
  sectionTitle: string | null;
  body: string;
}

export interface AddCommentResult {
  ok: true;
  comment_id: string;
  /** The message to send. The caller sends it; storing the comment never waits on it. */
  alert: CommentAlert;
}

/**
 * The link and the address a session is reading under, straight from the
 * rows, so the worker can check a comment proof against them rather than
 * against anything the request says (see verifyCommentProof in the proxy).
 * Null for an unknown session; the caller refuses that exactly as it refuses a
 * bad proof, so the answer says nothing about which sessions exist.
 */
export async function commentSigner(
  db: DB,
  sessionId: string,
): Promise<{ slug: string; email: string } | null> {
  const id = s(sessionId, 64);
  if (!id) return null;
  const r = await db
    .prepare(
      `SELECT sh.slug, v.email
         FROM sessions se
         JOIN document_shares sh ON sh.id = se.share_id
         JOIN viewers v ON v.id = se.viewer_id
        WHERE se.id = ?1`,
    )
    .bind(id)
    .first<{ slug: string; email: string | null }>();
  const email = (r?.email ?? '').trim().toLowerCase();
  return r && email ? { slug: r.slug, email } : null;
}

/**
 * A verified reader's note to the sender. Authenticated exactly like
 * updateSession — the session id plus the token that session was handed — so a
 * comment is written by the browser that is doing the reading and by no other.
 *
 * The gate is the feature: a comment is worth reading because whoever left it
 * proved they hold the address it is signed with. A link that does not ask for
 * a code shows no comment box at all (the proxy decides that from the same two
 * facts), and this is the same rule on the writing side, where it cannot be
 * walked around by posting to the endpoint directly.
 *
 * It is the second line, not the first. A session's address is whatever its
 * start_session body said, so a verification row for that address proves only
 * that SOMEBODY verified it; the worker has already refused any comment that
 * does not carry a proof signed from the reader's verified cookie.
 */
export async function addComment(db: DB, input: AddCommentInput): Promise<AddCommentResult> {
  const sessionId = s(input.p_session_id, 64);
  if (!sessionId) throw new RpcFailure('P0010', 'invalid_token');
  // Five in ten minutes is a reader going through a deck leaving notes as they
  // pass; a sixth in the same ten minutes is not reading any more. Keyed on the
  // session before the token is checked, as updateSession does, so a flood
  // never reaches the joins below.
  if (!(await hitRateLimit(db, `comment:${sessionId}`, 5, 600))) {
    throw new RpcFailure('P0001', 'rate_limited');
  }

  const r = await db
    .prepare(
      `SELECT se.token, se.share_id, se.viewer_id, sh.slug, sh.recipient_label, sh.require_email,
              sh.verify_email, sh.revoked_at, sh.expires_at, sh.document_id,
              d.title AS document_title, d.deleted_at,
              v.email AS viewer_email,
              p.email AS owner_email, p.display_name, p.telegram_chat_id
         FROM sessions se
         JOIN document_shares sh ON sh.id = se.share_id
         JOIN documents d ON d.id = sh.document_id
         JOIN viewers v ON v.id = se.viewer_id
         JOIN profiles p ON p.id = d.owner_id
        WHERE se.id = ?1`,
    )
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!r || typeof input.p_token !== 'string' || !ctEq(String(r['token'] ?? ''), input.p_token)) {
    throw new RpcFailure('P0010', 'invalid_token');
  }

  const shareId = r['share_id'] as string;
  const expires = r['expires_at'] as string | null;
  if (r['revoked_at']) throw new RpcFailure('P0003', 'share_revoked');
  if (expires && Date.parse(expires) < Date.now()) throw new RpcFailure('P0004', 'share_expired');
  if (r['deleted_at']) throw new RpcFailure('P0008', 'document_deleted');
  if (!toBool(r['verify_email']) || !toBool(r['require_email'])) {
    throw new RpcFailure('P0011', 'comments_not_enabled');
  }

  // Verified on THIS link at THIS address: share_email_verifications is keyed
  // that way, so a code proved on a sibling link of the same document signs
  // nothing here.
  const email = ((r['viewer_email'] as string | null) ?? '').trim().toLowerCase();
  const verified = email
    ? await db
        .prepare(
          `SELECT 1 AS n FROM share_email_verifications
            WHERE share_id = ?1 AND lower(email) = ?2 LIMIT 1`,
        )
        .bind(shareId, email)
        .first<{ n: number }>()
    : null;
  if (!verified) throw new RpcFailure('P0012', 'not_verified');

  // Trimmed twice: once for what the reader typed, once for what the ceiling
  // cut in half a word.
  const body = (typeof input.p_body === 'string' ? input.p_body : '')
    .trim()
    .slice(0, MAX_COMMENT_CHARS)
    .trim();
  if (!body) throw new RpcFailure('P0013', 'comment_empty');

  // The second ceiling, per link: a hundred comments an hour on one link is a
  // script, whichever session each one claims to come from. Counted only here,
  // once every other check has passed, so that nothing refused spends it — a
  // reader on a plain link, or a revoked one, posting over and over must not
  // be able to silence the verified readers of the link (review, medium).
  if (!(await hitRateLimit(db, `comment-share:${shareId}`, 100, 3600))) {
    throw new RpcFailure('P0001', 'rate_limited');
  }

  const commentId = uuid();
  const sectionTitle = s(input.p_section_title, 512);
  await db
    .prepare(
      `INSERT INTO document_comments
         (id, document_id, share_id, viewer_id, session_id, section_id, section_title, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      commentId,
      r['document_id'],
      shareId,
      r['viewer_id'],
      sessionId,
      s(input.p_section_id, 256),
      sectionTitle,
      body,
      nowIso(),
    )
    .run();

  return {
    ok: true,
    comment_id: commentId,
    alert: {
      commentId,
      sessionId,
      documentId: r['document_id'] as string,
      documentTitle: r['document_title'] as string,
      ownerEmail: r['owner_email'] as string,
      ownerName: (r['display_name'] as string | null) ?? null,
      telegramChatId: (r['telegram_chat_id'] as string | null) ?? null,
      slug: r['slug'] as string,
      recipientLabel: (r['recipient_label'] as string | null) ?? null,
      viewerEmail: email,
      sectionTitle,
      body,
    },
  };
}
