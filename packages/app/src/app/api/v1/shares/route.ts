// /api/v1/shares
//
// POST — a tracked link. Either publish new HTML and link it in one call
//   { "html": "…", "title"?: "…" }
// or add a link to a document that already exists
//   { "document_id": "…" }
// plus the link settings: recipient_label, require_email (default true),
// verify_email, password, lock_deck (default true), allowed_email_domains,
// allowed_emails, expires_in_hours, slug, notify_first_open (default true).
// One call is one act: if the link is refused, a document it created is
// removed again.
//
// GET — the account's links, newest first, 50 a page (?before=<cursor>).

import type { NextRequest } from 'next/server';
import {
  OwnerError,
  createShare,
  getDocument,
  listShares,
  purgeDocument,
  shareOpenSummary,
} from '@htmlradar/db/owner';
import {
  authenticateApiKey,
  CHEAP_MAX,
  CREATION_MAX,
  cursorOf,
  json,
  notFound,
  PAGE_SIZE,
  readBefore,
  readJsonObject,
  serverError,
  tooLarge,
  validationError,
} from '@/lib/api-auth';
import { db } from '@/lib/cf';
import { createDocumentForUser } from '@/lib/create-document';
import { deleteR2Object, r2Key } from '@/lib/r2';
import { describeSlugError } from '@/lib/share-slug';
import { shareUrl } from '@/lib/share-url';
import { verifiedGateEnabled } from '@/lib/verified-gate';

export const runtime = 'edge';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An edge isolate decodes this comfortably; the browser upload allows 30 MB.
const MAX_API_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 5.5 * 1024 * 1024;
// The proxy scans the allow-lists on every open; keep them bounded.
const MAX_ALLOWLIST_ENTRIES = 500;

function titleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 64_000));
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 200) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalBool(body: Record<string, unknown>, name: string): boolean | undefined | Error {
  const v = body[name];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'boolean' ? v : new Error(`"${name}" must be a boolean.`);
}

function stringList(body: Record<string, unknown>, name: string): string[] | null | Error {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return new Error(`"${name}" must be an array of strings.`);
  }
  const list = (v as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length > MAX_ALLOWLIST_ENTRIES) {
    return new Error(`"${name}" may hold at most ${MAX_ALLOWLIST_ENTRIES} entries.`);
  }
  return list.length ? list : null;
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req, {
    name: 'shares',
    max: CREATION_MAX,
    write: true,
  });
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return tooLarge(MAX_API_HTML_BYTES);
  }
  const parsed = await readJsonObject(req);
  if ('error' in parsed) return parsed.error;
  const body = parsed.body;

  // --- what to track
  const html = typeof body['html'] === 'string' ? (body['html'] as string) : null;
  const existingDocumentId = stringOrNull(body['document_id']);
  if (body['url'] !== undefined) {
    return validationError('Tracking a URL is not available through the API. Send "html".');
  }
  if ((html === null) === (existingDocumentId === null)) {
    return validationError('Provide exactly one of "html" or "document_id".');
  }
  let bytes: Uint8Array | null = null;
  if (html !== null) {
    bytes = new TextEncoder().encode(html);
    if (bytes.byteLength > MAX_API_HTML_BYTES) return tooLarge(MAX_API_HTML_BYTES);
    if (!/<[a-z!/]/i.test(html)) return validationError('"html" does not look like HTML.');
  } else if (!UUID.test(existingDocumentId!)) {
    return notFound();
  }

  // --- link settings
  const requireEmail = optionalBool(body, 'require_email');
  const verifyEmail = optionalBool(body, 'verify_email');
  const lockDeck = optionalBool(body, 'lock_deck');
  const notify = optionalBool(body, 'notify_first_open');
  const domains = stringList(body, 'allowed_email_domains');
  const emails = stringList(body, 'allowed_emails');
  for (const v of [requireEmail, verifyEmail, lockDeck, notify, domains, emails]) {
    if (v instanceof Error) return validationError(v.message);
  }
  const gate = (requireEmail as boolean | undefined) ?? true;
  if (verifyEmail === true && !verifiedGateEnabled()) {
    return validationError(
      'Email verification is not available on this installation. Create the link without "verify_email".',
    );
  }
  if (verifyEmail === true && !gate) {
    return validationError('"verify_email" needs "require_email": true.');
  }

  const password =
    typeof body['password'] === 'string' && body['password'] ? body['password'] : null;
  if (password !== null && password.length < 8) {
    return validationError('"password" must be at least 8 characters.');
  }

  let expiresAt: string | null = null;
  const hours = body['expires_in_hours'];
  if (hours !== undefined && hours !== null) {
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 366) {
      return validationError(
        '"expires_in_hours" must be a positive number of hours, at most a year.',
      );
    }
    expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  }

  const slug = stringOrNull(body['slug']);
  const recipientLabel = stringOrNull(body['recipient_label'])?.slice(0, 200) ?? null;

  // --- write
  const d = db();
  let documentId: string;
  let createdDocument = false;
  try {
    if (existingDocumentId !== null) {
      const doc = await getDocument(d, caller.userId, existingDocumentId.toLowerCase());
      if (!doc) return notFound();
      documentId = doc.id;
    } else {
      const title =
        stringOrNull(body['title'])?.slice(0, 200) ?? titleFromHtml(html!) ?? 'Untitled';
      documentId = await createDocumentForUser(d, caller.userId, title, {
        type: 'upload',
        bytes: bytes!,
        filename: null,
      });
      createdDocument = true;
    }
  } catch (e) {
    console.error('[api] document create failed', e);
    return serverError();
  }

  try {
    const share = await createShare(d, caller.userId, documentId, {
      slug,
      recipient_label: recipientLabel,
      require_email: gate,
      verify_email: verifyEmail === true,
      require_password: password !== null,
      password,
      allowed_email_domains: domains as string[] | null,
      allowed_emails: emails as string[] | null,
      expires_at: expiresAt,
      lock_deck: (lockDeck as boolean | undefined) ?? true,
      notify_first_open: (notify as boolean | undefined) ?? true,
    });
    const origin = new URL(req.url).origin;
    return json(
      {
        share_id: share.id,
        document_id: documentId,
        slug: share.slug,
        url: shareUrl(share.slug),
        dashboard_url: `${origin}/docs/${documentId}`,
      },
      201,
    );
  } catch (e) {
    if (createdDocument) {
      // Best effort: a refused link must not leave a document nobody asked for.
      try {
        await purgeDocument(d, caller.userId, documentId);
        await deleteR2Object(r2Key(caller.userId, documentId, 1));
      } catch (cleanup) {
        console.warn('[api] rollback failed', documentId, cleanup);
      }
    }
    if (e instanceof OwnerError) {
      return validationError(describeSlugError(e.code) ?? e.message ?? e.code);
    }
    console.error('[api] share create failed', e);
    return serverError();
  }
}

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req, { name: 'shares-list', max: CHEAP_MAX });
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const page = readBefore(req);
  if ('error' in page) return page.error;

  const d = db();
  const rows = await listShares(d, caller.userId, {
    ...(page.cursor ? { before: page.cursor } : {}),
    limit: PAGE_SIZE,
  });
  const opens = await shareOpenSummary(
    d,
    caller.userId,
    rows.map((r) => r.id),
  );
  const now = Date.now();
  return json({
    shares: rows.map((row) => ({
      share_id: row.id,
      slug: row.slug,
      url: shareUrl(row.slug),
      recipient_label: row.recipient_label,
      document_id: row.document_id,
      document_title: row.document_title,
      created_at: row.created_at,
      revoked: !!row.revoked_at,
      expired: !!row.expires_at && new Date(row.expires_at).getTime() < now,
      opened: opens.has(row.id),
      last_open: opens.get(row.id)?.last_open ?? null,
    })),
    next_before: rows.length === PAGE_SIZE ? cursorOf(rows[rows.length - 1]!) : null,
  });
}
