// What an EDIT does to a link's verification setting.
//
// The one that matters is the edit that says nothing. With the capability off
// the form shows no verification control at all, so changing an expiry — or a
// label, or an allow-list — submits no `verify_email` field. Reading that
// silence as `false` would strip verification from a link a customer had
// switched it on for, without anybody asking for that and without anybody
// seeing it happen. `update_share` coalesces null onto the stored value
// (schema/055), so null is how this path says nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-000000000001';
const DOC = '11111111-1111-4111-8111-111111111111';
const SHARE = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  rpcArgs: null as Record<string, unknown> | null,
  events: [] as { event: string; properties: Record<string, unknown> }[],
}));

vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/events', () => ({
  captureServerEvent: async (entry: { event: string; properties: Record<string, unknown> }) => {
    state.events.push(entry);
  },
}));
vi.mock('@/lib/error-log', () => ({ logServerError: vi.fn(async () => undefined) }));
vi.mock('@/lib/quota', () => ({ readQuota: async () => ({ atCap: false, used: 0 }) }));
vi.mock('@/lib/preview-token', () => ({
  issueOwnerDocPreviewToken: async () => 'tok',
  issueOwnerPreviewToken: async () => 'tok',
}));
vi.mock('@/lib/r2', () => ({
  r2Key: () => 'key',
  uploadHtml: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteR2Object: vi.fn(),
}));
vi.mock('@/lib/handle', () => ({ stampShareHost: async () => null }));

vi.mock('@/lib/supabase-server', () => ({
  requireUser: async () => ({ id: USER }),
  serverClient: () => ({
    // The action follows update_share with set_share_lock_deck, which would
    // otherwise be the last call recorded.
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'update_share') state.rpcArgs = args;
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@/lib/api-auth', () => ({
  serviceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));

import { editShareAction } from './actions';

async function edit(extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('share_id', SHARE);
  fd.set('document_id', DOC);
  for (const [key, value] of Object.entries(extra)) fd.set(key, value);
  // A finished edit always ends in a redirect, which the mock above turns into
  // a throw exactly as Next does.
  await expect(editShareAction(fd)).rejects.toThrow('NEXT_REDIRECT');
}

const ORIGINAL = process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED;

beforeEach(() => {
  state.rpcArgs = null;
  state.events = [];
  process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED = '1';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED;
  else process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED = ORIGINAL;
});

describe('editShareAction — verify_email', () => {
  it('says nothing when this deploy cannot offer the control at all', async () => {
    delete process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED;
    await edit({ require_email: 'on', recipient_label: 'Investor list' });
    expect(state.rpcArgs?.['p_verify_email']).toBeNull();
    const edited = state.events.find((e) => e.event === 'share.edited');
    expect(edited?.properties['verify_email']).toBeNull();
  });

  it('stores the box when the control is there and ticked', async () => {
    await edit({ require_email: 'on', verify_email: 'on' });
    expect(state.rpcArgs?.['p_verify_email']).toBe(true);
  });

  // With the control on screen, an unticked box IS an opinion: the owner
  // looked at it and left it off, so false is what they asked for.
  it('stores false when the control is there and not ticked', async () => {
    await edit({ require_email: 'on' });
    expect(state.rpcArgs?.['p_verify_email']).toBe(false);
  });
});
