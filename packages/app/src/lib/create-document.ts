// Document creation, shared by the /new server action, /convert and
// POST /api/v1/shares so the paths cannot drift: INSERT-then-upload, rollback
// when R2 fails, and the v1 version-history seed.

import {
  findDocumentByCreationId,
  insertDocument,
  purgeDocument,
  recordNewVersion,
} from '@htmlradar/db/owner';
import { r2Key, uploadHtml } from './r2';

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export type DocumentSource =
  | { type: 'url'; url: string }
  | { type: 'upload'; bytes: Uint8Array; filename: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Create a document owned by `userId` and return its id. Throws on failure.
 *
 * INSERT-then-upload: if the row cannot be written R2 is never touched, and if
 * the upload fails the row is deleted so a retry starts clean. A repeated
 * `clientCreationId` (a browser retrying after a lost response) returns the
 * document the first request created.
 */
export async function createDocumentForUser(
  db: D1Database,
  userId: string,
  title: string,
  source: DocumentSource,
  clientCreationId?: string,
): Promise<string> {
  if (clientCreationId && !UUID_RE.test(clientCreationId)) {
    throw new Error('Invalid creation identifier');
  }
  if (clientCreationId) {
    const existing = await findDocumentByCreationId(db, userId, clientCreationId);
    if (existing) return existing.id;
  }
  const docId = crypto.randomUUID();

  if (source.type === 'url') {
    await insertDocument(db, {
      id: docId,
      owner_id: userId,
      title,
      source_type: 'url',
      source_url: source.url,
      r2_key: null,
    });
    await recordNewVersion(db, userId, docId, {
      version: 1,
      r2_key: null,
      source_type: 'url',
      source_url: source.url,
      filename: null,
      bytes: null,
      bumpDocument: false,
    });
    return docId;
  }

  const key = r2Key(userId, docId, 1);
  await insertDocument(db, {
    id: docId,
    owner_id: userId,
    title,
    source_type: 'upload',
    source_url: null,
    r2_key: key,
    client_creation_id: clientCreationId ?? null,
  });

  try {
    await uploadHtml(key, source.bytes);
  } catch (err) {
    await purgeDocument(db, userId, docId);
    throw err;
  }

  await recordNewVersion(db, userId, docId, {
    version: 1,
    r2_key: key,
    source_type: 'upload',
    source_url: null,
    filename: source.filename,
    bytes: source.bytes.byteLength,
    bumpDocument: false,
  });
  return docId;
}
