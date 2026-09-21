// POST /api/v1/shares — restricting a link to named individuals.
//
// create_share_as has always taken `p_allowed_emails` and this route has
// always passed null. What is added is one optional field, and what is pinned
// here is that it stores what the website's own share form would have stored
// for the same input: trimmed, lower-cased, blanks dropped, an empty list
// written as NULL (parseAllowlists in src/app/(app)/docs/[id]/actions.ts), and
// checked against the same address shape the form checks (EMAIL_REGEX in
// DocumentShareManager.tsx).
//
// The one combination that cannot exist: an allow-list with the email gate
// off. The proxy only consults the list inside `if (share.require_email)`, so
// such a link would read as restricted and admit anyone. The website cannot
// produce it — the fields are only shown once the gate is on — and neither
// can this route.

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

/** What create_share_as was told to store in allowed_emails. */
function stored(): unknown {
  return db.rpcArgs?.['p_allowed_emails'];
}

describe('POST /api/v1/shares — allowed_emails', () => {
  it('stores nothing and behaves as before when the field is absent', async () => {
    const res = await post(HTML);
    expect(res.status).toBe(201);
    expect(stored()).toBeNull();
    // The response shape existing clients read is untouched.
    expect(Object.keys(res.body).sort()).toEqual([
      'dashboard_url',
      'document_id',
      'share_id',
      'url',
    ]);
    const created = db.events.find((e) => e.event === 'share.created');
    expect(created?.properties['has_email_allowlist']).toBe(false);
  });

  it('passes the named addresses through to create_share_as', async () => {
    const res = await post({ ...HTML, allowed_emails: ['ravi@acme.com', 'priya@acme.com'] });
    expect(res.status).toBe(201);
    expect(stored()).toEqual(['ravi@acme.com', 'priya@acme.com']);
    const created = db.events.find((e) => e.event === 'share.created');
    expect(created?.properties['has_email_allowlist']).toBe(true);
  });

  it('trims, lower-cases and collapses duplicates, as the share form does', async () => {
    const res = await post({
      ...HTML,
      allowed_emails: ['  Ravi@Acme.COM ', 'ravi@acme.com', '', '  ', 'PRIYA@acme.com'],
    });
    expect(res.status).toBe(201);
    expect(stored()).toEqual(['ravi@acme.com', 'priya@acme.com']);
  });

  it('writes NULL, not an empty array, for a list with nothing usable in it', async () => {
    for (const value of [[], ['   '], null]) {
      const res = await post({ ...HTML, allowed_emails: value });
      expect(res.status, JSON.stringify(value)).toBe(201);
      expect(stored(), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses an address that is not one, naming it so an assistant can relay it', async () => {
    const res = await post({ ...HTML, allowed_emails: ['ravi@acme.com', 'not-an-address'] });
    expect(res.status).toBe(422);
    expect(res.body['error']).toBe('validation');
    expect(res.body['message']).toContain('not-an-address');
    expect(res.body['message']).toContain('allowed_emails');
    // Nothing was created on the way to the refusal.
    expect(db.rpcArgs).toBeNull();
  });

  it('refuses anything that is not an array of strings', async () => {
    for (const value of ['ravi@acme.com', [1], [{ email: 'ravi@acme.com' }], 7]) {
      const res = await post({ ...HTML, allowed_emails: value });
      expect(res.status, JSON.stringify(value)).toBe(422);
      expect(res.body['message']).toContain('array of strings');
    }
  });

  it('keeps domains a separate list, and sends both', async () => {
    const res = await post({
      ...HTML,
      allowed_email_domains: ['Acme.com'],
      allowed_emails: ['ravi@other.example'],
    });
    expect(res.status).toBe(201);
    expect(db.rpcArgs?.['p_allowed_email_domains']).toEqual(['acme.com']);
    expect(stored()).toEqual(['ravi@other.example']);
  });

  it('refuses a named-people list with the email gate off, rather than letting everyone in', async () => {
    const res = await post({ ...HTML, require_email: false, allowed_emails: ['ravi@acme.com'] });
    expect(res.status).toBe(422);
    expect(res.body['message']).toContain('require_email');
    expect(res.body['message']).toContain('anyone with the link would open it');
    expect(db.rpcArgs).toBeNull();
  });

  it('leaves the domain list with the gate off exactly as it was, so existing callers are unaffected', async () => {
    const res = await post({
      ...HTML,
      require_email: false,
      allowed_email_domains: ['acme.com'],
    });
    expect(res.status).toBe(201);
    expect(db.rpcArgs?.['p_require_email']).toBe(false);
  });

  it('is available on a second link for a document that already exists', async () => {
    const res = await post({
      document_id: '22222222-2222-4222-8222-222222222222',
      allowed_emails: ['ravi@acme.com'],
    });
    expect(res.status).toBe(201);
    expect(stored()).toEqual(['ravi@acme.com']);
  });

  // The new field must not become a way round the free-plan cap. The cap is
  // read before anything is written, so it is reached before the allow-list is
  // even looked at.
  it('still stops at the free-plan cap, whoever the link was going to be restricted to', async () => {
    db.atCap = true;
    const res = await post({ ...HTML, allowed_emails: ['ravi@acme.com'] });
    expect(res.status).toBe(402);
    expect(res.body['error']).toBe('free_limit_reached');
    expect(db.rpcArgs).toBeNull();
  });

  // The cap is a machine-surface decision, not a copy of the form, which caps
  // nothing: one request may carry a 5.5 MB array, and the proxy scans the
  // stored list on every open of the link.
  it('accepts a list exactly at the cap', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `person${i}@acme.com`);
    const res = await post({ ...HTML, allowed_emails: many });
    expect(res.status).toBe(201);
    expect((stored() as string[]).length).toBe(500);
  });

  it('refuses one address over the cap, and says what to do instead', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `person${i}@acme.com`);
    const res = await post({ ...HTML, allowed_emails: many });
    expect(res.status).toBe(422);
    expect(res.body['message']).toContain('501');
    expect(res.body['message']).toContain('500');
    expect(res.body['message']).toContain('allowed_email_domains');
    expect(db.rpcArgs).toBeNull();
  });

  it('counts the cap after de-duplicating, not before', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `person${i}@acme.com`);
    const res = await post({ ...HTML, allowed_emails: [...many, ...many] });
    expect(res.status).toBe(201);
    expect((stored() as string[]).length).toBe(500);
  });

  it('caps the domain list the same way, on the same route', async () => {
    const domains = Array.from({ length: 501 }, (_, i) => `company${i}.com`);
    const res = await post({ ...HTML, allowed_email_domains: domains });
    expect(res.status).toBe(422);
    expect(res.body['message']).toContain('allowed_email_domains');
    expect(res.body['message']).toContain('500');
    expect(db.rpcArgs).toBeNull();

    const atCap = await post({ ...HTML, allowed_email_domains: domains.slice(0, 500) });
    expect(atCap.status).toBe(201);
  });
});
