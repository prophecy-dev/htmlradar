import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// The auth return path has two doors: a PKCE `code` from Google, and a
// `token_hash` from an e-mail link.
//
// The second door is now two steps, and the point of these tests is the
// split. A GET carrying a token_hash must NOT verify it — mail-security
// scanners fetch every link in a message on delivery, and on 17-18 September
// 2026 one spent all three of a user's sign-in links seconds after they were
// sent, leaving him six "expired" clicks. Only the POST that the button on
// /auth/confirm submits may spend a token.

const state = vi.hoisted(() => ({
  verifyCalls: [] as Array<{ type: string; token_hash: string }>,
  exchangeCalls: [] as string[],
  verifyError: null as { message: string } | null,
  events: [] as Array<{ event: string; properties?: Record<string, unknown> }>,
}));

vi.mock('@/lib/supabase-server', () => ({
  serverClient: () => ({
    auth: {
      verifyOtp: async (args: { type: string; token_hash: string }) => {
        state.verifyCalls.push(args);
        return state.verifyError
          ? { data: { user: null }, error: state.verifyError }
          : {
              data: {
                user: {
                  id: 'u1',
                  created_at: new Date().toISOString(),
                  app_metadata: { provider: 'email' },
                  email: 'x@y.z',
                },
              },
              error: null,
            };
      },
      exchangeCodeForSession: async (code: string) => {
        state.exchangeCalls.push(code);
        return {
          data: {
            user: {
              id: 'u1',
              created_at: '2026-01-01T00:00:00Z',
              app_metadata: { provider: 'google' },
              email: 'x@y.z',
            },
          },
          error: null,
        };
      },
    },
  }),
}));

vi.mock('@/lib/events', () => ({
  captureServerEvent: async (opts: { event: string; properties?: Record<string, unknown> }) => {
    state.events.push(opts);
  },
}));

import { GET, POST } from './route';

function asNextRequest(req: Request) {
  // NextRequest carries a cookie store; a plain Request does not.
  Object.assign(req, { cookies: { get: () => undefined } });
  return req as unknown as NextRequest;
}

function get(query: string) {
  return GET(asNextRequest(new Request(`https://htmlradar.com/auth/callback?${query}`)));
}

// A browser submitting the form on /auth/confirm sends these; the default is
// what a real same-origin submission looks like.
function post(fields: Record<string, string>, headers: Record<string, string | null> = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const merged: Record<string, string> = {
    origin: 'https://htmlradar.com',
    'sec-fetch-site': 'same-origin',
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return POST(
    asNextRequest(
      new Request('https://htmlradar.com/auth/callback', {
        method: 'POST',
        body,
        headers: merged,
      }),
    ),
  );
}

const names = () => state.events.map((e) => e.event);
const reasonOf = (event: string) =>
  state.events.find((e) => e.event === event)?.properties?.['reason'];

beforeEach(() => {
  state.verifyCalls = [];
  state.exchangeCalls = [];
  state.verifyError = null;
  state.events = [];
});

describe('a GET carrying an e-mail token never spends it', () => {
  it('hands the token to /auth/confirm without calling verifyOtp', async () => {
    const res = await get('next=%2Fdocs&token_hash=h1&type=email');
    expect(state.verifyCalls).toEqual([]);
    expect(state.events).toEqual([]);
    expect(res.status).toBe(303);
    const dest = new URL(res.headers.get('location')!);
    expect(dest.pathname).toBe('/auth/confirm');
    expect(dest.searchParams.get('token_hash')).toBe('h1');
    // /docs is the default, so it isn't spelled out in the URL.
    expect(dest.searchParams.get('next')).toBeNull();
  });

  it('carries a staged-handoff destination through, validated', async () => {
    const res = await get('next=%2Fconvert%3Fresume%3Dabc&token_hash=h1&type=email');
    const dest = new URL(res.headers.get('location')!);
    expect(dest.searchParams.get('next')).toBe('/convert?resume=abc');
    expect(state.verifyCalls).toEqual([]);
  });

  it('collapses an off-site destination to /docs before handing it on', async () => {
    const res = await get('next=%2F%2Fevil.com&token_hash=h1&type=email');
    const dest = new URL(res.headers.get('location')!);
    expect(dest.origin).toBe('https://htmlradar.com');
    expect(dest.searchParams.get('next')).toBeNull();
  });

  // The tab-between-slashes escape, which every prefix check used to pass.
  it('collapses a control character smuggled into the destination', async () => {
    const res = await get(`next=${encodeURIComponent('/\t/evil.example')}&token_hash=h1`);
    const dest = new URL(res.headers.get('location')!);
    expect(dest.origin).toBe('https://htmlradar.com');
    expect(dest.searchParams.get('next')).toBeNull();
  });
});

// The POST spends a token and issues a session without needing a session
// first, so SameSite cookies do not defend it: any site could auto-submit a
// form carrying the ATTACKER's own unused token and land the victim inside
// the attacker's account.
describe('a POST from anywhere but our own page', () => {
  it('is refused before verifyOtp is ever called', async () => {
    const res = await post(
      { token_hash: 'h1' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(state.verifyCalls).toEqual([]);
    expect(res.status).toBe(303);
    const dest = new URL(res.headers.get('location')!);
    expect(dest.pathname).toBe('/sign-in');
    expect(dest.searchParams.get('error')).toBe('invalid');
    expect(reasonOf('auth.callback_failed')).toBe('cross_origin');
  });

  it('is refused when Origin is absent, which is what a non-browser looks like', async () => {
    const res = await post({ token_hash: 'h1' }, { origin: null, 'sec-fetch-site': null });
    expect(state.verifyCalls).toEqual([]);
    expect(reasonOf('auth.callback_failed')).toBe('cross_origin');
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid');
  });

  it('is refused when Sec-Fetch-Site contradicts a same-looking Origin', async () => {
    await post({ token_hash: 'h1' }, { 'sec-fetch-site': 'cross-site' });
    expect(state.verifyCalls).toEqual([]);
    expect(reasonOf('auth.callback_failed')).toBe('cross_origin');
  });

  // Older Safari omits Sec-Fetch-Site entirely. Refusing on absence would
  // lock those people out, so Origin alone is the mandatory check.
  it('goes through when Sec-Fetch-Site is absent but the Origin is ours', async () => {
    await post({ token_hash: 'h1' }, { 'sec-fetch-site': null });
    expect(state.verifyCalls).toEqual([{ type: 'email', token_hash: 'h1' }]);
  });
});

describe('the POST from the confirmation button', () => {
  it('verifies the token hash and sends the person on to next', async () => {
    const res = await post({ token_hash: 'h1', next: '/convert?resume=abc' });
    expect(state.verifyCalls).toEqual([{ type: 'email', token_hash: 'h1' }]);
    expect(state.exchangeCalls).toEqual([]);
    // 303, so the browser follows with a GET rather than re-POSTing.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://htmlradar.com/convert?resume=abc');
    expect(names()).toContain('user.signed_in');
  });

  it('defaults to /docs and refuses an off-site destination', async () => {
    expect((await post({ token_hash: 'h1' })).headers.get('location')).toBe(
      'https://htmlradar.com/docs',
    );
    expect((await post({ token_hash: 'h2', next: '//evil.com' })).headers.get('location')).toBe(
      'https://htmlradar.com/docs',
    );
  });

  it('sends a genuinely expired token to the recovery state, keeping the destination', async () => {
    state.verifyError = { message: 'Token has expired or is invalid' };
    const res = await post({ token_hash: 'h1', next: '/convert' });
    // 303, so the browser reaches the recovery page with a GET. A 307 would
    // re-POST the token and a refresh would offer to submit it again.
    expect(res.status).toBe(303);
    const dest = new URL(res.headers.get('location')!);
    expect(dest.pathname).toBe('/sign-in');
    expect(dest.searchParams.get('error')).toBe('expired');
    expect(dest.searchParams.get('next')).toBe('/convert');
    expect(reasonOf('auth.callback_failed')).toBe('expired');
  });

  it('records a reason when the form carried no token', async () => {
    const res = await post({ next: '/convert' });
    expect(state.verifyCalls).toEqual([]);
    expect(res.status).toBe(303);
    expect(reasonOf('auth.callback_failed')).toBe('callback');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('refuses a control character in the submitted destination', async () => {
    const res = await post({ token_hash: 'h1', next: '/\t/evil.example' });
    expect(res.headers.get('location')).toBe('https://htmlradar.com/docs');
  });
});

// These were declared in next.config's headers() and were absent in
// production for a week: next-on-pages does not run Next's routing layer in
// front of a Cloudflare Pages function, so only headers the handler sets on
// its own responses survive. Every exit is checked, because the one that is
// not checked is the one that carries the token.
describe('every response denies referrers and caching', () => {
  const sealed = (res: Response) => [
    res.headers.get('referrer-policy'),
    res.headers.get('cache-control'),
  ];

  it('on the hand-off to the confirmation page', async () => {
    expect(sealed(await get('token_hash=h1&type=email'))).toEqual(['no-referrer', 'no-store']);
  });

  it('on a successful sign-in, and on the Google door', async () => {
    expect(sealed(await post({ token_hash: 'h1' }))).toEqual(['no-referrer', 'no-store']);
    expect(sealed(await get('code=c1&next=%2Fdocs'))).toEqual(['no-referrer', 'no-store']);
  });

  it('on every failure, including the refused cross-origin POST', async () => {
    state.verifyError = { message: 'Token has expired or is invalid' };
    expect(sealed(await post({ token_hash: 'h1' }))).toEqual(['no-referrer', 'no-store']);
    expect(sealed(await post({ token_hash: 'h1' }, { origin: 'https://evil.example' }))).toEqual([
      'no-referrer',
      'no-store',
    ]);
    expect(sealed(await get('error_description=expired'))).toEqual(['no-referrer', 'no-store']);
  });

  it('on the plain pass-through with neither code nor token', async () => {
    expect(sealed(await get('next=%2Fpricing'))).toEqual(['no-referrer', 'no-store']);
  });
});

describe('the Google door is unchanged', () => {
  it('exchanges the code and redirects to next', async () => {
    const res = await get('code=c1&next=%2Fdocs');
    expect(state.exchangeCalls).toEqual(['c1']);
    expect(state.verifyCalls).toEqual([]);
    expect(res.headers.get('location')).toBe('https://htmlradar.com/docs');
    expect(names()).toContain('user.signed_in');
  });

  it('with neither code nor token hash just goes to next', async () => {
    const res = await get('next=%2Fpricing');
    expect(res.headers.get('location')).toBe('https://htmlradar.com/pricing');
    expect(state.exchangeCalls).toEqual([]);
  });

  it('names the reason when the provider reports an error', async () => {
    const res = await get('error_description=Email+link+is+invalid+or+has+expired');
    expect(reasonOf('auth.callback_failed')).toBe('expired');
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('expired');
  });
});
