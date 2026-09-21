// POST /api/v1/shares — asking the reader to prove the address is theirs.
//
// `verify_email` is one optional boolean, and what is pinned here is the same
// pair of things the allow-list field needed: that an absent field changes
// nothing for every client that already exists, and that the ONE combination
// which cannot exist is refused with a sentence rather than created.
//
// That combination is verification with the e-mail gate off. With the gate off
// nobody is ever asked for an address, so there is nothing to send a code to
// and the link would read as verified while opening for anyone holding it. The
// database refuses the pair outright (schema/055); this route refuses it first,
// so the caller gets something they can act on instead of a constraint
// violation.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';

const db = vi.hoisted(() => ({
  rpcArgs: null as Record<string, unknown> | null,
  events: [] as { event: string; properties: Record<string, unknown> }[],
  atCap: false,
}));

vi.mock('@/lib/error-log', () => ({ logServerError: vi.fn() }));
vi.mock('@/lib/events', () => ({
  captureServerEvent: async (entry: { event: string; properties: Record<string, unknown> }) => {
    db.events.push(entry);
  },
}));
vi.mock('@/lib/r2', () => ({ deleteR2Object: vi.fn(), r2Key: () => 'key' }));
vi.mock('@/lib/create-document', () => ({ createDocumentForUser: async () => 'doc-1' }));
vi.mock('@/lib/quota', () => ({ readQuota: async () => ({ atCap: db.atCap, used: 0 }) }));
vi.mock('@/lib/handle', () => ({ stampShareHost: async () => null }));

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  authenticateApiKey: async () => ({ caller: { userId: 'user-1', tier: 'pro' } }),
  serviceClient: () => ({
    rpc: async (_name: string, args: Record<string, unknown>) => {
      db.rpcArgs = args;
      return {
        data: { id: SHARE_ID, slug: 'quick-glass', custom_domain_id: null },
        error: null,
      };
    },
    from: () => {
      const chain = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        is: () => chain,
        // The document-ownership lookup, so the `document_id` case below
        // reaches create_share_as.
        maybeSingle: async () => ({ data: { id: 'doc-1' }, error: null }),
        then: (resolve: (value: { data: unknown; error: null }) => void) =>
          resolve({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));

import { POST } from './route';

beforeEach(() => {
  // The deploy flag that says this installation can send a code at all. Set
  // here because the interesting cases are about what happens when it is ON;
  // the case below turns it off deliberately.
  process.env['NEXT_PUBLIC_VERIFY_EMAIL_ENABLED'] = '1';
  db.rpcArgs = null;
  db.events = [];
  db.atCap = false;
});

async function post(body: Record<string, unknown>) {
  const req = new Request('https://htmlradar.com/api/v1/shares', {
    method: 'POST',
    headers: {
      authorization: `Bearer hr_live_${'a'.repeat(40)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const HTML = { html: '<h1>Deck</h1>' };

describe('POST /api/v1/shares — verify_email', () => {
  /** What create_share_as was told to store in verify_email. */
  const storedVerify = () => db.rpcArgs?.['p_verify_email'];

  // Absent is null and not false: the database decides, and nothing a caller
  // never mentioned is cleared on its behalf.
  it('says nothing when the field is absent, so no existing caller changes behaviour', async () => {
    const res = await post(HTML);
    expect(res.status).toBe(201);
    expect(storedVerify()).toBeNull();
    // The response shape existing clients read is untouched.
    expect(Object.keys(res.body).sort()).toEqual([
      'dashboard_url',
      'document_id',
      'share_id',
      'url',
    ]);
  });

  it('is stored when asked for, alongside the gate that is on by default', async () => {
    const res = await post({ ...HTML, verify_email: true });
    expect(res.status).toBe(201);
    expect(storedVerify()).toBe(true);
    expect(db.rpcArgs?.['p_require_email']).toBe(true);
    const created = db.events.find((e) => e.event === 'share.created');
    expect(created?.properties['verify_email']).toBe(true);
  });

  it('refuses verification with the email gate off, and says why', async () => {
    const res = await post({ ...HTML, verify_email: true, require_email: false });
    expect(res.status).toBe(422);
    expect(String(res.body['message'] ?? res.body['error'])).toContain('"require_email": true');
    // Nothing was created. A refusal that still wrote the link would be worse
    // than no refusal at all.
    expect(db.rpcArgs).toBeNull();
  });

  it('refuses verification when this deploy has no way to send a code', async () => {
    // A link created here would look correct in the dashboard and refuse every
    // reader, because no code could ever be sent to them. Refused, not
    // silently downgraded: a caller who asked for verification and quietly got
    // a link without it would be worse off than one who got an error.
    delete process.env['NEXT_PUBLIC_VERIFY_EMAIL_ENABLED'];
    const res = await post({ ...HTML, verify_email: true });
    expect(res.status).toBe(422);
    expect(String(res.body['message'] ?? res.body['error'])).toContain('not available');
    expect(db.rpcArgs).toBeNull();
  });

  it('still creates an ordinary gated link when verification is unavailable', async () => {
    delete process.env['NEXT_PUBLIC_VERIFY_EMAIL_ENABLED'];
    const res = await post(HTML);
    expect(res.status).toBe(201);
    // Still nothing said — the capability being off is not a reason to write
    // somebody's setting for them.
    expect(db.rpcArgs?.['p_verify_email']).toBeNull();
  });

  // An explicit false is an opinion and is passed on as one.
  it('stores false when the caller asks for false', async () => {
    const res = await post({ ...HTML, verify_email: false });
    expect(res.status).toBe(201);
    expect(storedVerify()).toBe(false);
  });

  it('refuses a value that is not a boolean', async () => {
    const res = await post({ ...HTML, verify_email: 'yes' });
    expect(res.status).toBe(422);
    expect(db.rpcArgs).toBeNull();
  });

  it('leaves the gate off when the caller asks for that and does not verify', async () => {
    const res = await post({ ...HTML, require_email: false });
    expect(res.status).toBe(201);
    expect(storedVerify()).toBeNull();
  });
});
