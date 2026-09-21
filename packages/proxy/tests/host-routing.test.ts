import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKER_VERSION } from '../src/tracker-version.js';

// Which host the worker was asked on decides what it does.
//
// Recipient documents live on SHARE_HOST — a registrable domain of their own,
// so a customer's HTML never shares an origin with the application's session
// cookies and never borrows the primary domain's reputation. Every link sent
// before the move points at a LEGACY_HOST, and those must keep opening.
//
// The three behaviours guarded here:
//
//   1. A GET or HEAD on a legacy host is a 301 to the same path and query on
//      SHARE_HOST. The query matters: a preview token or an opt-out answer
//      lives there, and a redirect that dropped it would look like a bug in
//      the gate rather than in the redirect.
//
//   2. A POST on a legacy host is served where it was sent. A 301 turns a
//      POST into a GET and drops the body, so redirecting the gate and
//      opt-out submissions would break every tab that was already open when
//      the switch happened.
//
//   3. SHARE_HOST is not a website. Anything that is not a share is a 404,
//      and robots.txt tells every crawler to stay out of all of it.

const share = {
  id: 'share-1',
  document_id: 'doc-1',
  owner_id: 'owner-1',
  slug: 'acme-proposal',
  require_email: false,
  require_password: false,
  allowed_email_domains: null,
  allowed_emails: null,
  expires_at: null,
  revoked_at: null,
  lock_deck: false,
  config: {},
};

const doc = {
  id: 'doc-1',
  owner_id: 'owner-1',
  title: 'Deck',
  source_type: 'url',
  source_url: 'https://example.test/deck.html',
  r2_key: null,
  current_version: 1,
  deleted_at: null,
  config: {},
};

const getShareBySlug = vi.fn();

vi.mock('../src/supabase.js', async () => {
  const actual = await vi.importActual<typeof import('../src/supabase.js')>('../src/supabase.js');
  return {
    ...actual,
    getShareBySlug: (...args: unknown[]) => getShareBySlug(...args),
    // No hostname is a claimed customer domain unless a test says so. Real
    // network calls must never happen here, and resolveHost reads
    // custom_domains for every host that is not the apex or a handle.
    getCustomDomainByHostname: vi.fn(async () => null),
    getDocument: vi.fn(async () => doc),
    // No attachment by this id. Enough to prove the download path was handled
    // where the request arrived rather than redirected away from it.
    getAttachment: vi.fn(async () => null),
    listAttachmentsForDocument: vi.fn(async () => []),
    logAppEvent: vi.fn(async () => undefined),
    verifySharePassword: vi.fn(async () => 'ok'),
    notifyDisabledAttempt: vi.fn(async () => undefined),
  };
});

// HTMLRewriter is a Workers global with no Node equivalent; injectTracker's
// own behaviour is covered by inject.test.ts.
vi.mock('../src/inject.js', async () => {
  const actual = await vi.importActual<typeof import('../src/inject.js')>('../src/inject.js');
  return {
    ...actual,
    injectTracker: vi.fn(
      async () =>
        new Response('<html><body><h1>Deck</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    ),
  };
});

vi.mock('../src/fetch-html.js', () => ({
  fetchDocumentHtml: vi.fn(
    async () => new Response('<html><body><h1>Deck</h1></body></html>', { status: 200 }),
  ),
}));

const baseEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  SESSION_SECRET: 'test-session-secret',
  TRACKER_URL: 'https://htmlradar.com/v1/tracker.js',
} as unknown as import('../src/env.js').Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function fetchAs(
  url: string,
  init: RequestInit = {},
  env: import('../src/env.js').Env = baseEnv,
): Promise<Response> {
  const worker = (await import('../src/index.js')).default;
  return worker.fetch(new Request(url, init), env, ctx);
}

beforeEach(() => {
  getShareBySlug.mockReset();
  getShareBySlug.mockResolvedValue(share);
});

afterEach(() => vi.clearAllMocks());

describe('a legacy host redirects readers to the share host', () => {
  it('301s a GET to the same path on the share host', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://htmlradar.page/r/acme-proposal');
    // Nothing was looked up: the redirect happens before any share lookup.
    expect(getShareBySlug).not.toHaveBeenCalled();
  });

  it('keeps the query string, which carries preview tokens and opt-out answers', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal?owner_preview=t.1.abc&x=1');
    expect(res.headers.get('Location')).toBe(
      'https://htmlradar.page/r/acme-proposal?owner_preview=t.1.abc&x=1',
    );
  });

  it('301s a HEAD as well, so link checkers land on the right host', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal', { method: 'HEAD' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://htmlradar.page/r/acme-proposal');
  });

  it('redirects the attachment-download path too, query and all', async () => {
    // A recipient who clicks a supporting-material link in an old email has to
    // land on the file, not on a 404 — and whatever the link carried has to
    // survive the hop with it.
    const res = await fetchAs(
      'https://htmlradar.com/r/acme-proposal/m/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?v=2',
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(
      'https://htmlradar.page/r/acme-proposal/m/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?v=2',
    );
    expect(getShareBySlug).not.toHaveBeenCalled();
  });

  it('still carries the noindex header, so the hop is never indexed', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });
});

describe('a legacy host serves POSTs in place', () => {
  // A 301 would turn these into GETs and drop the body. Tabs opened before
  // the switch still post here, and their gate has to work.
  it('answers the password gate where it was submitted', async () => {
    getShareBySlug.mockResolvedValue({ ...share, require_password: true });
    const form = new FormData();
    form.set('password', 'correct-horse');
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal/auth', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Set-Cookie')).toMatch(/^htmlradar_auth_acme-proposal=/);
  });

  it('answers the email gate where it was submitted', async () => {
    getShareBySlug.mockResolvedValue({ ...share, require_email: true });
    const form = new FormData();
    form.set('email', 'reader@example.org');
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal/email', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Set-Cookie')).toMatch(/^htmlradar_email_acme-proposal=/);
  });
});

describe('the share host is not a website', () => {
  it('404s the root', async () => {
    const res = await fetchAs('https://htmlradar.page/');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('404s an unknown path', async () => {
    const res = await fetchAs('https://htmlradar.page/pricing');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('serves robots.txt as a blanket Disallow', async () => {
    const res = await fetchAs('https://htmlradar.page/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it("serves the tracker from the document's own host", async () => {
    // First-party to the document: no second DNS lookup, and nothing for a
    // third-party script blocker to recognise. The worker fetches it from
    // TRACKER_URL, which is the application domain.
    const upstream = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('/* tracker */', { status: 200 }));
    const res = await fetchAs('https://htmlradar.page/v1/tracker.js');
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith('https://htmlradar.com/v1/tracker.js');
    upstream.mockRestore();
  });

  // The 21 September 2026 defect. A customer's domain can sit behind the
  // CUSTOMER's cache, which no deploy of ours purges, so the one fixed address
  // kept handing readers a four-hour-old script after the page configuration
  // had moved on. The address now carries the bundle's own hash, so new bytes
  // are an address nothing has cached — and every other address stays alive,
  // serving the current script on a lifetime short enough to heal itself.
  describe("the tracker's address changes when its bytes do", () => {
    // The real bundle the application serves, which is what TRACKER_VERSION is
    // the hash of. Using the actual bytes is the point: the worker pins a
    // response only after hashing it, so a stub that merely looked like a
    // tracker would prove nothing.
    const CURRENT = readFileSync(new URL('../../app/public/v1/tracker.js', import.meta.url));
    const serveTracker = (body: string | Uint8Array = CURRENT, status = 200) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));

    it('points the served document at the versioned address', async () => {
      const injected = (await import('../src/inject.js')).injectTracker as unknown as ReturnType<
        typeof vi.fn
      >;
      await fetchAs('https://htmlradar.page/r/acme-proposal');
      const { trackerUrl } = injected.mock.calls[0]![1] as { trackerUrl: string };
      expect(trackerUrl).toBe(`/v1/tracker.${TRACKER_VERSION}.js`);
      // Relative, so it is fetched from whichever host served the document.
      expect(trackerUrl.startsWith('/')).toBe(true);
    });

    it('pins the bytes forever once it has hashed them and they are that version', async () => {
      const upstream = serveTracker();
      const res = await fetchAs(`https://htmlradar.page/v1/tracker.${TRACKER_VERSION}.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CURRENT.toString());
      expect(upstream).toHaveBeenCalledWith('https://htmlradar.com/v1/tracker.js');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('X-HTMLRadar-Tracker-Version')).toBe(TRACKER_VERSION);
      upstream.mockRestore();
    });

    it('refuses to pin bytes that are not the version the address asked for', async () => {
      // The window between deploying this worker and the application serving
      // the matching script — our own edge cache is purged later still. Pinning
      // here would make the stale script permanent for that reader, which is
      // today's defect with no way back. It is served, and it is not pinned.
      const upstream = serveTracker('/* the PREVIOUS tracker, still cached upstream */');
      const res = await fetchAs(`https://htmlradar.page/v1/tracker.${TRACKER_VERSION}.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('/* the PREVIOUS tracker, still cached upstream */');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
      // And it says what it really served, rather than what was asked for.
      expect(res.headers.get('X-HTMLRadar-Tracker-Version')).not.toBe(TRACKER_VERSION);
      upstream.mockRestore();
    });

    it("answers an older deploy's address with the current script, not a 404", async () => {
      // A document a browser already holds, or a request in flight across a
      // deploy. Losing tracking would be worse than a redundant fetch.
      const upstream = serveTracker();
      const res = await fetchAs('https://htmlradar.page/v1/tracker.0123456789ab.js');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CURRENT.toString());
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
      expect(res.headers.get('X-HTMLRadar-Tracker-Version')).toBe(TRACKER_VERSION);
      upstream.mockRestore();
    });

    it('keeps the fixed address alive on a short lifetime, for direct embeds', async () => {
      const upstream = serveTracker();
      const res = await fetchAs('https://htmlradar.page/v1/tracker.js');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CURRENT.toString());
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
      upstream.mockRestore();
    });

    it('never pins a failed fetch, whatever address asked for it', async () => {
      const upstream = serveTracker('upstream down', 502);
      const res = await fetchAs(`https://htmlradar.page/v1/tracker.${TRACKER_VERSION}.js`);
      expect(res.status).toBe(502);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, must-revalidate');
      expect(res.headers.get('X-HTMLRadar-Tracker-Version')).toBeNull();
      upstream.mockRestore();
    });

    it('is not a wildcard: only the tracker filename is answered', async () => {
      for (const path of ['/v1/tracker.js.map', '/v1/tracker..js', '/v1/anything.abc.js']) {
        expect((await fetchAs(`https://htmlradar.page${path}`)).status, path).toBe(404);
      }
    });
  });

  it('serves a share', async () => {
    const res = await fetchAs('https://htmlradar.page/r/acme-proposal');
    expect(res.status).toBe(200);
    expect(getShareBySlug).toHaveBeenCalledWith(baseEnv, 'acme-proposal');
  });
});

describe('plain HTTP is never served', () => {
  // `wrangler dev` serves plain HTTP on localhost, so localhost is exempt —
  // otherwise every local request would bounce to an https port that is not
  // listening.
  it('is served on localhost, so wrangler dev works', async () => {
    const res = await fetchAs('http://localhost:8787/robots.txt');
    expect(res.status).toBe(200);
  });

  // The .page top-level domain is HTTPS-only by browser policy; a recipient
  // document must not travel in the clear on any host.
  it('301s to the same address over HTTPS', async () => {
    const res = await fetchAs('http://htmlradar.page/r/acme-proposal?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://htmlradar.page/r/acme-proposal?x=1');
  });
});

describe('a self-hoster sets their own hosts', () => {
  const selfHosted = {
    ...baseEnv,
    SHARE_HOST: 'docs.example.org',
    LEGACY_HOSTS: 'old.example.org, older.example.org',
  } as import('../src/env.js').Env;

  it('serves shares on the configured share host', async () => {
    const res = await fetchAs('https://docs.example.org/r/acme-proposal', {}, selfHosted);
    expect(res.status).toBe(200);
  });

  it('redirects each configured legacy host to it', async () => {
    for (const host of ['old.example.org', 'older.example.org']) {
      const res = await fetchAs(`https://${host}/r/acme-proposal`, {}, selfHosted);
      expect(res.status, host).toBe(301);
      expect(res.headers.get('Location'), host).toBe('https://docs.example.org/r/acme-proposal');
    }
  });

  it('leaves htmlradar.com alone once it is no longer a legacy host', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal', {}, selfHosted);
    expect(res.status).toBe(200);
  });
});

describe('an empty legacy list turns the redirect off', () => {
  // How the content domain ships on its first deploy, and where a rollback
  // puts it afterwards: both hosts serve documents, neither one redirects, so
  // a single link opens on either. Gate 2 of the switch plan sets
  // LEGACY_HOSTS = "htmlradar.com" to turn the permanent redirect on.
  //
  // This still holds with custom domains, and it is the reason ORIGIN_HOST
  // exists in src/index.ts. The legacy list decides whether the old host
  // REDIRECTS; whether the old host is served at all is not configurable,
  // because the answer is yes for as long as those links are in circulation.
  // An unknown hostname is refused now — the old host is not an unknown one.
  const noRedirect = { ...baseEnv, LEGACY_HOSTS: '' } as import('../src/env.js').Env;

  it('serves the old host in place instead of redirecting it', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal', {}, noRedirect);
    expect(res.status).toBe(200);
    expect(getShareBySlug).toHaveBeenCalledWith(noRedirect, 'acme-proposal');
  });

  it('serves the share host at the same time, so one link opens on either', async () => {
    const res = await fetchAs('https://htmlradar.page/r/acme-proposal', {}, noRedirect);
    expect(res.status).toBe(200);
  });

  it('keeps the FIXED tracker address on the application domain', async () => {
    // The one host where /v1/ is not this worker's: only /r/* is routed here
    // on htmlradar.com, so /v1/ is answered by Cloudflare Pages, which has the
    // fixed address and no other. A versioned address there would 404 and the
    // document would load no tracker at all.
    const injected = (await import('../src/inject.js')).injectTracker as unknown as ReturnType<
      typeof vi.fn
    >;
    await fetchAs('https://htmlradar.com/r/acme-proposal', {}, noRedirect);
    expect((injected.mock.calls[0]![1] as { trackerUrl: string }).trackerUrl).toBe(
      '/v1/tracker.js',
    );
  });

  it('sends no Location at all, query string included', async () => {
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal?x=1', {}, noRedirect);
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('serves the attachment path in place as well, query and all', async () => {
    // 404 because the mocked lookup has no attachment by that id — the point
    // is that the download route ran here at all instead of answering 301.
    const res = await fetchAs(
      'https://htmlradar.com/r/acme-proposal/m/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?v=2',
      {},
      noRedirect,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(getShareBySlug).toHaveBeenCalledWith(noRedirect, 'acme-proposal');
  });

  it('still upgrades plain HTTP, which is a separate rule from the host', async () => {
    const res = await fetchAs('http://htmlradar.com/r/acme-proposal', {}, noRedirect);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://htmlradar.com/r/acme-proposal');
  });

  it('still refuses a customer-domain share there', async () => {
    // The old host is the apex's equal for routing and for nothing else.
    getShareBySlug.mockResolvedValue({
      ...share,
      custom_domain_id: 'dom-1',
      custom_domain_hostname: 'decks.acme.com',
      custom_domain_state: 'live',
      custom_domain_owner_id: 'owner-1',
    });
    const res = await fetchAs('https://htmlradar.com/r/acme-proposal', {}, noRedirect);
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });
});
