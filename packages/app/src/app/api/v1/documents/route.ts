// GET /api/v1/documents — the account's documents, newest first, 50 a page.
// Identifiers, titles and link counts only; contents are never read back.

import type { NextRequest } from 'next/server';
import { listDocumentsPage } from '@htmlradar/db/owner';
import {
  authenticateApiKey,
  CHEAP_MAX,
  cursorOf,
  json,
  PAGE_SIZE,
  readBefore,
} from '@/lib/api-auth';
import { db } from '@/lib/cf';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req, { name: 'documents-list', max: CHEAP_MAX });
  if ('error' in auth) return auth.error;
  const page = readBefore(req);
  if ('error' in page) return page.error;

  const rows = await listDocumentsPage(db(), auth.caller.userId, {
    ...(page.cursor ? { before: page.cursor } : {}),
    limit: PAGE_SIZE,
  });
  return json({
    documents: rows.map((row) => ({
      document_id: row.id,
      title: row.title,
      created_at: row.created_at,
      share_count: row.share_count,
    })),
    next_before: rows.length === PAGE_SIZE ? cursorOf(rows[rows.length - 1]!) : null,
  });
}
