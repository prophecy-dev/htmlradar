// POST /api/v1/documents/{id}/replace — new content behind the same links.
// Body: { "html": "<!doctype html>…" }.
//
// Same order as replaceDocumentAction: upload the next version's bytes first
// (a failed upload leaves every recipient on the version they had), then point
// the document at it and append the version-history row.

import type { NextRequest } from 'next/server';
import { getDocument, recordNewVersion } from '@htmlradar/db/owner';
import {
  authenticateApiKey,
  CREATION_MAX,
  json,
  notFound,
  readJsonObject,
  serverError,
  tooLarge,
  validationError,
} from '@/lib/api-auth';
import { db } from '@/lib/cf';
import { r2Key, uploadHtml } from '@/lib/r2';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_API_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 5.5 * 1024 * 1024;

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateApiKey(req, {
    name: 'replace',
    max: CREATION_MAX,
    write: true,
  });
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  if (!UUID.test(params.id)) return notFound();
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return tooLarge(MAX_API_HTML_BYTES);
  }
  const parsed = await readJsonObject(req);
  if ('error' in parsed) return parsed.error;
  const html = parsed.body['html'];
  if (typeof html !== 'string' || !/<[a-z!/]/i.test(html)) {
    return validationError('"html" must be the full HTML markup of the new version.');
  }
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > MAX_API_HTML_BYTES) return tooLarge(MAX_API_HTML_BYTES);

  const d = db();
  const doc = await getDocument(d, caller.userId, params.id.toLowerCase());
  if (!doc) return notFound();
  if (doc.source_type !== 'upload') {
    return validationError('This document is tracked from a URL; update it at its source.');
  }

  const version = (doc.current_version ?? 0) + 1;
  const key = r2Key(caller.userId, doc.id, version);
  try {
    await uploadHtml(key, bytes);
    await recordNewVersion(d, caller.userId, doc.id, {
      version,
      r2_key: key,
      source_type: 'upload',
      source_url: null,
      filename: null,
      bytes: bytes.byteLength,
      bumpDocument: true,
    });
  } catch (e) {
    console.error('[api] replace failed', doc.id, e);
    return serverError();
  }
  return json({ document_id: doc.id, version, links_unchanged: true });
}
