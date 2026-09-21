// GET /api/v1/documents — two owners, one database.
//
// route.test.ts asserts that the owner filter is written. This asserts what
// the filter is for: the fake below actually applies every `eq` and `in` it is
// given over rows belonging to two accounts, so a filter that were dropped
// would show up as the other account's documents in the answer rather than as
// a missing assertion.
//
// There is no session and no listing function in the database here — the owner
// filter in the route is the whole of the security — and the identifiers are
// not guessable either: this route takes none, so an account cannot ask after
// a document id it does not own.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const caller = vi.hoisted(() => ({ userId: 'owner-a' }));

const db = vi.hoisted(() => ({
  documents: [] as Record<string, unknown>[],
  shares: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/error-log', () => ({ logServerError: vi.fn() }));

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  authenticateApiKey: async () => ({ caller: { userId: caller.userId, tier: 'pro' } }),
  serviceClient: () => ({
    from: (table: string) => {
      let rows = (table === 'documents' ? db.documents : db.shares).slice();
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return chain;
        },
        is: (column: string, value: unknown) => {
          rows = rows.filter((row) => (row[column] ?? null) === value);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return chain;
        },
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: { data: unknown; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      };
      return chain;
    },
  }),
}));

import { GET } from './route';

beforeEach(() => {
  caller.userId = 'owner-a';
  db.documents = [
    { id: 'doc-a', owner_id: 'owner-a', title: "A's proposal", created_at: '2026-08-30T10:00:00Z' },
    {
      id: 'doc-b',
      owner_id: 'owner-b',
      title: "B's term sheet",
      created_at: '2026-08-31T10:00:00Z',
    },
    {
      id: 'doc-a-deleted',
      owner_id: 'owner-a',
      title: 'Thrown away',
      created_at: '2026-08-28T10:00:00Z',
      deleted_at: '2026-08-29T10:00:00Z',
    },
  ];
  db.shares = [
    { document_id: 'doc-a', owner_id: 'owner-a' },
    { document_id: 'doc-b', owner_id: 'owner-b' },
    { document_id: 'doc-b', owner_id: 'owner-b' },
  ];
});

async function list() {
  const req = new Request('https://htmlradar.com/api/v1/documents', {
    headers: { authorization: `Bearer hr_live_${'a'.repeat(40)}` },
  }) as unknown as NextRequest;
  const res = await GET(req);
  return (await res.json()) as { documents: { document_id: string; share_count: number }[] };
}

describe('GET /api/v1/documents with two accounts in the database', () => {
  it('shows each owner their own documents and nothing of the other account', async () => {
    const a = await list();
    expect(a.documents.map((d) => d.document_id)).toEqual(['doc-a']);

    caller.userId = 'owner-b';
    const b = await list();
    expect(b.documents.map((d) => d.document_id)).toEqual(['doc-b']);
  });

  it('counts only the caller’s own links against the caller’s own documents', async () => {
    // Owner B has two links; owner A must see neither the documents nor the
    // count, even though both accounts' shares are in the same table.
    caller.userId = 'owner-b';
    expect((await list()).documents).toEqual([
      {
        document_id: 'doc-b',
        title: "B's term sheet",
        created_at: '2026-08-31T10:00:00Z',
        share_count: 2,
      },
    ]);
  });

  it('leaves an account with nothing of its own an empty list, not the other account’s', async () => {
    caller.userId = 'owner-c';
    expect((await list()).documents).toEqual([]);
  });
});
