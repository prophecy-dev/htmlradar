// Tests for scripts/live-journey.mjs — the daily check that walks a real
// user's path through production.
//
// It exists because e-mail sign-in links landed people SIGNED OUT from 4 to
// 16 September 2026 and nothing caught it for twelve days. So the case that
// matters most here is the one that failed then: a callback that redirects to
// /docs but sets no session cookie must be a FAIL, not a pass.
//
// Every fetch is stubbed. Nothing in this file touches the network.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile);
const scriptUrl = new URL('../../scripts/live-journey.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(scriptUrl);

// A variable specifier, so `tsc` leaves the untyped .mjs alone.
const { signInStep, cleanupStep, customHostStep, runJourney, parseForm } = await import(
  /* @vite-ignore */ scriptPath
);

const cfg = {
  baseUrl: 'https://htmlradar.com',
  supabaseUrl: 'https://project.supabase.co',
  serviceKey: 'service-key',
  apiKey: 'hr_live_test',
  journeyEmail: 'hello@htmlradar.com',
};

const confirmForm = (token = 'pkce_abc123') =>
  `<form method="post" action="/auth/callback"><input type="hidden" name="token_hash" value="${token}"/><button type="submit">Continue to HTMLRadar</button></form>`;

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Stubs the four requests signInStep makes: generate_link mints a token, the
 * GET on the e-mail link answers with `scan`, the GET on /auth/confirm serves
 * a form, the POST answers with `callback`, and a guarded GET on /docs proves
 * the session. Defaults are the healthy case; each option breaks one link in
 * that chain.
 */
function stubFetch(
  callback: { status: number; location: string; cookie?: string },
  scan: {
    location?: string;
    cookie?: string;
    confirmCookie?: string;
    page?: string;
    guarded?: { status: number; location?: string };
  } = {},
) {
  const headers = new Headers([['location', callback.location]]);
  if (callback.cookie) headers.append('set-cookie', callback.cookie);
  const scanHeaders = new Headers([
    ['location', scan.location ?? 'https://htmlradar.com/auth/confirm?token_hash=pkce_abc123'],
  ]);
  if (scan.cookie) scanHeaders.append('set-cookie', scan.cookie);
  const confirmHeaders = new Headers();
  if (scan.confirmCookie) confirmHeaders.append('set-cookie', scan.confirmCookie);
  const guarded = scan.guarded ?? { status: 200 };
  const sent: Sent[] = [];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    (
      url: string | URL,
      init?: { method?: string; headers?: Record<string, string>; body?: URLSearchParams },
    ) => {
      const target = String(url);
      calls.push(`${init?.method ?? 'GET'} ${target}`);
      sent.push({
        method: init?.method ?? 'GET',
        url: target,
        headers: init?.headers ?? {},
        body: String(init?.body ?? ''),
      });
      if (target.includes('/auth/v1/admin/generate_link')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ hashed_token: 'pkce_abc123' }),
        });
      }
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: callback.status, headers });
      }
      if (target.includes('/auth/confirm')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: confirmHeaders,
          text: () => Promise.resolve(scan.page ?? confirmForm()),
        });
      }
      if (target.endsWith('/docs')) {
        return Promise.resolve({
          ok: guarded.status === 200,
          status: guarded.status,
          headers: new Headers(guarded.location ? [['location', guarded.location]] : []),
        });
      }
      return Promise.resolve({ ok: false, status: 303, headers: scanHeaders });
    },
  );
  return { calls, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const signedIn = {
  status: 303,
  location: 'https://htmlradar.com/docs',
  cookie: 'sb-project-auth-token=abc; Path=/; HttpOnly',
};

describe('signInStep', () => {
  it('opens the link with a GET, then signs in with the POST behind the button', async () => {
    const { calls, sent } = stubFetch(signedIn);
    await expect(signInStep(cfg)).resolves.toContain('/docs');
    expect(calls[1]).toContain('token_hash=pkce_abc123');
    expect(calls[1]).toContain('type=email');
    // The confirmation page is fetched WITH the token still on it; without
    // the query it would bounce to /sign-in and the form would never appear.
    expect(calls[2]).toContain('/auth/confirm?token_hash=pkce_abc123');
    expect(calls[3]).toBe('POST https://htmlradar.com/auth/callback');
    // And the guarded page, with the cookie the POST handed back.
    expect(calls[4]).toBe('GET https://htmlradar.com/docs');
    expect(sent[4]?.headers['cookie']).toBe('sb-project-auth-token=abc');
  });

  it('submits as a browser on our own page would, so the CSRF check passes', async () => {
    const { sent } = stubFetch(signedIn);
    await signInStep(cfg);
    const post = sent.find((call) => call.url.endsWith('/auth/callback'));
    expect(post?.headers['origin']).toBe('https://htmlradar.com');
    expect(post?.headers['sec-fetch-site']).toBe('same-origin');
    expect(post?.headers['referer']).toContain('/auth/confirm');
  });

  // The script must not quietly supply the token it minted: a form that
  // renders the WRONG token has to fail, or the monitor tests its own memory.
  it('submits the token the page rendered, not the one it minted', async () => {
    const { sent } = stubFetch(signedIn, { page: confirmForm('a-different-token') });
    await signInStep(cfg);
    expect(sent.find((call) => call.url.endsWith('/auth/callback'))?.body).toBe(
      'token_hash=a-different-token',
    );
  });

  // The 17-18 September 2026 failure: a mail scanner's plain GET spent the
  // token and took the session, so the human's click always came too late.
  it('fails when a GET on the e-mail link hands out a session cookie', async () => {
    stubFetch(signedIn, { cookie: 'sb-project-auth-token=abc; Path=/' });
    await expect(signInStep(cfg)).rejects.toThrow(/mail scanner will take it/);
  });

  it('fails when rendering the confirmation page hands out a session cookie', async () => {
    stubFetch(signedIn, { confirmCookie: 'sb-project-auth-token=abc; Path=/' });
    await expect(signInStep(cfg)).rejects.toThrow(/rendering the page is signing people in/);
  });

  it('fails when the e-mail link does not reach the confirmation page', async () => {
    stubFetch(signedIn, { location: 'https://htmlradar.com/docs' });
    await expect(signInStep(cfg)).rejects.toThrow(/not \/auth\/confirm/);
  });

  it('fails when the confirmation page renders without a POST form', async () => {
    stubFetch(signedIn, { page: '<p>Something went wrong.</p>' });
    await expect(signInStep(cfg)).rejects.toThrow(/without a POST form/);
  });

  it('fails when the rendered form carries no token', async () => {
    stubFetch(signedIn, {
      page: '<form method="post" action="/auth/callback"><button>Go</button></form>',
    });
    await expect(signInStep(cfg)).rejects.toThrow(/no token_hash field/);
  });

  it('fails when the callback bounces to /sign-in', async () => {
    stubFetch({ status: 303, location: '/sign-in?error=expired&next=%2Fdocs' });
    await expect(signInStep(cfg)).rejects.toThrow(/\/sign-in/);
  });

  // A 307 would re-POST the token to the destination and a refresh would
  // offer to submit it again.
  it('fails when the callback answers 307 instead of 303', async () => {
    stubFetch({ ...signedIn, status: 307 });
    await expect(signInStep(cfg)).rejects.toThrow(/not the 303/);
  });

  // The 4-16 September outage, exactly: the right destination, no session.
  it('fails when the callback reaches /docs with no sb- cookie', async () => {
    stubFetch({ status: 303, location: 'https://htmlradar.com/docs' });
    await expect(signInStep(cfg)).rejects.toThrow(/signed OUT/i);
  });

  // A sign-out sets `sb-...=` with an empty value; a substring check reads
  // that as a session and passes a flow that signed nobody in.
  it('fails when the only sb- cookie is a deletion', async () => {
    stubFetch({ ...signedIn, cookie: 'sb-project-auth-token=; Path=/; Max-Age=0' });
    await expect(signInStep(cfg)).rejects.toThrow(/signed OUT/i);
  });

  // The cookie existing is not the cookie working.
  it('fails when the session cookie does not authenticate a guarded page', async () => {
    stubFetch(signedIn, { guarded: { status: 307, location: 'https://htmlradar.com/sign-in' } });
    await expect(signInStep(cfg)).rejects.toThrow(/did not authenticate/);
  });
});

describe('parseForm', () => {
  it('reads the action and every hidden field, unescaping the values', () => {
    expect(
      parseForm(
        '<form method="post" action="/auth/callback"><input type="hidden" name="token_hash" value="t1"/><input type="hidden" name="next" value="/convert?a=1&amp;b=2"/></form>',
      ),
    ).toEqual({
      action: '/auth/callback',
      fields: { token_hash: 't1', next: '/convert?a=1&b=2' },
    });
  });

  it('returns null for a GET form, or one aimed somewhere else', () => {
    expect(parseForm('<form action="/auth/callback"><input name="token_hash"/></form>')).toBe(null);
    expect(parseForm('<form method="post" action="https://evil.example"></form>')).toBe(null);
    expect(parseForm('<p>no form here</p>')).toBe(null);
  });
});

/** PostgREST answers: the owner lookup, then the delete. */
function stubRest(deletion: { status: number; body: string }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${url}`);
    if (url.includes('/rest/v1/profiles')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('[{"id":"owner-1"}]'),
      });
    }
    return Promise.resolve({
      ok: deletion.status < 400,
      status: deletion.status,
      text: () => Promise.resolve(deletion.body),
    });
  });
  return calls;
}

describe('cleanupStep', () => {
  it("deletes only the journey account's older journey documents and counts them", async () => {
    const calls = stubRest({ status: 200, body: '[{"id":"doc-1"}]' });
    await expect(cleanupStep(cfg)).resolves.toBe('removed 1 older journey documents');
    expect(calls[1]).toContain('owner_id=eq.owner-1');
    expect(calls[1]).toContain('title=like.live-journey%20*');
    expect(calls[1]).toMatch(/created_at=lt\.\d{4}-\d{2}-\d{2}T/);
    expect(calls[1]?.startsWith('DELETE ')).toBe(true);
  });

  // Housekeeping is not production. A failure here must not page anyone.
  it('warns rather than fails when the delete errors, leaving the exit code alone', async () => {
    stubRest({ status: 500, body: 'boom' });
    const { report, firstFailure } = await runJourney(cfg, {
      api: () => Promise.resolve('served'),
      cleanup: cleanupStep,
    });
    expect(report).toMatch(/^WARN cleanup \d+ms — .*returned 500/m);
    // null is what the script checks before exiting 1, so this is exit 0.
    expect(firstFailure).toBe(null);
  });
});

// A link on a customer's own hostname has its own certificate and its own
// renewal clock, so htmlradar.page answering says nothing about it. What this
// pins is the address assertion — a link created on a domain must come back on
// that domain — and that an account with no domain skips rather than fails.
describe('customHostStep', () => {
  const HOSTNAME = 'decks.gethtmlradar.com';

  /** PostgREST answers the owner and domain lookups; the API answers `url`. */
  function stubCustomHost(domains: unknown[], url: string) {
    const calls: string[] = [];
    // The served page echoes the title the step actually created, so the
    // "200 but not the document" branch stays a real assertion rather than
    // one that fires because the stub guessed the timestamp wrong.
    let served = '';
    vi.stubGlobal('fetch', (target: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${target}`);
      const body = (value: unknown) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(value)),
        });
      if (target.includes('/rest/v1/profiles')) return body([{ id: 'owner-1' }]);
      if (target.includes('/rest/v1/custom_domains')) return body(domains);
      if (target.endsWith('/api/v1/shares')) {
        served = (JSON.parse(String(init?.body)) as { html: string }).html;
        return body({ share_id: 'share-1', url });
      }
      if (target.includes('/revoke')) return body({ ok: true });
      // The recipient fetch of the link itself.
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(served) });
    });
    return calls;
  }

  it('creates the link on the live domain and asserts the address it came back on', async () => {
    const calls = stubCustomHost(
      [{ id: 'domain-1', hostname: HOSTNAME }],
      `https://${HOSTNAME}/r/quick-glass`,
    );

    await expect(customHostStep(cfg)).resolves.toContain(`${HOSTNAME} served the document`);
    expect(calls[1]).toContain('owner_id=eq.owner-1');
    expect(calls[1]).toContain('state=eq.live');
    expect(calls[2]).toContain('POST https://htmlradar.com/api/v1/shares');
    expect(calls.at(-1)).toContain('/api/v1/shares/share-1/revoke');
  });

  // The failure that would otherwise pass: a healthy 200 from the wrong host.
  it('fails when the link comes back on htmlradar.page instead', async () => {
    stubCustomHost(
      [{ id: 'domain-1', hostname: HOSTNAME }],
      'https://htmlradar.page/r/quick-glass',
    );
    await expect(customHostStep(cfg)).rejects.toThrow(/not on decks\.gethtmlradar\.com/);
  });

  it('skips with a reason, and passes the journey, when no domain is live', async () => {
    stubCustomHost([], '');

    const { report, firstFailure } = await runJourney(cfg, { 'custom-host': customHostStep });

    expect(report).toBe('SKIP custom-host — no live domain on the journey account');
    expect(firstFailure).toBe(null);
  });
});

describe('the report', () => {
  it('marks the failing step FAIL and names it as the first failure', async () => {
    const { report, firstFailure } = await runJourney(cfg, {
      'sign-in': () => Promise.reject(new Error('no sb- cookie')),
      api: () => Promise.resolve('served'),
    });
    expect(report).toMatch(/^FAIL sign-in \d+ms — no sb- cookie$/m);
    expect(report).toMatch(/^PASS api \d+ms — served$/m);
    expect(firstFailure).toBe('sign-in');
  });

  it('exits 1 and prints the report when a step fails', async () => {
    // The script self-runs; fetch is replaced before it is imported, so the
    // whole journey fails without a packet leaving the machine.
    const failure = await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `globalThis.fetch = () => Promise.reject(new Error('stubbed: no network'));
       process.argv[1] = ${JSON.stringify(scriptPath)};
       await import(${JSON.stringify(scriptUrl)});`,
      ],
      { env: { ...process.env, JOURNEY_EMAIL: 'journey@example.com' } },
    ).catch((error: { code: number; stdout: string }) => error);

    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stdout: string }).stdout).toMatch(/FAIL sign-in .*stubbed: no network/);
  });

  // JOURNEY_EMAIL has no default: the account has to be a Pro or comped one,
  // and guessing wrong means a daily 402 that looks like a product failure.
  it('refuses to run at all when JOURNEY_EMAIL is unset', async () => {
    const failure = await run(process.execPath, [scriptPath], {
      env: { ...process.env, JOURNEY_EMAIL: '' },
    }).catch((error: { code: number; stderr: string }) => error);

    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stderr: string }).stderr).toMatch(/JOURNEY_EMAIL is not set/);
  });
});
