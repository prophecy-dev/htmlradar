import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Jar, tokenFrom } from './cookie-jar.js';

// The returning reader, end to end through the worker's fetch handler.
//
// WHAT BROKE. Every proxy response carries `Content-Security-Policy: sandbox …`
// without allow-same-origin, which puts a customer's document in an opaque
// origin where localStorage throws. The tracker kept its random reader
// identifier there, so from the day that header shipped it minted a fresh one
// on every single load: a returning reader was never recognised, the sender
// got another "someone opened your document" email each time, and the
// unique-reader count inflated. Measured on production on 21 September 2026,
// excluding internal accounts: 19 of 68 anonymous readers were recognised on a
// return before that day, and 0 of 20 after it.
//
// WHAT REPLACES IT. The worker keeps the identifier in its own first-party
// cookie on the host that served the document, and hands the tracker a value
// derived from it through `window.HTMLRadarConfig` — the same channel that
// already carries the verified email and the geo. The tracker therefore needs
// no browser storage at all on a proxy-served document.
//
// THE FOUR PROPERTIES THIS FILE PINS, and they are the whole privacy argument:
//
//   1. A second load with the cookie yields the SAME identifier, which is the
//      defect being fixed.
//   2. An opted-out reader gets no cookie, no identifier and no tracker, and
//      confirming an opt-out DELETES an identifier already held.
//   3. The cookie is named `__Host-hr_rid`, which browsers accept only with
//      Secure, Path=/ and no Domain — so a customer's parent domain cannot
//      plant one — and it is HttpOnly, so the sender's own script cannot read
//      or write it. A name arriving twice is trusted in neither value.
//   4. The value in the page is NOT the cookie's value, and it is bound to one
//      document. The honest limit: the sender's HTML shares a scripting
//      context with the tracker and can read `window.HTMLRadarConfig`, so the
//      derived value IS visible to the document it is on — as the localStorage
//      value was before the sandbox existed. What binding buys is that the
//      value is useless anywhere but on that one document, and that the
//      cookie's own value never enters the page.

const share = {
  id: 'share-1',
  document_id: 'doc-1',
  owner_id: 'owner-1',
  slug: 'acme-proposal',
  recipient_label: null,
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
    getCustomDomainByHostname: vi.fn(async () => null),
    getDocument: vi.fn(async () => doc),
    listAttachmentsForDocument: vi.fn(async () => []),
    logAppEvent: vi.fn(async () => undefined),
    notifyDisabledAttempt: vi.fn(async () => undefined),
  };
});

vi.mock('../src/fetch-html.js', () => ({
  fetchDocumentHtml: vi.fn(
    async () =>
      new Response('<html><head></head><body><h1>Deck</h1></body></html>', { status: 200 }),
  ),
}));

type Sink = { append(content: string, opts: { html: true }): void };

class FakeHTMLRewriter {
  private handlers: Record<string, { element(el: Sink): void }> = {};
  private appended: string[] = [];
  on(selector: string, handler: { element(el: Sink): void }): this {
    this.handlers[selector] = handler;
    return this;
  }
  onDocument(): this {
    return this;
  }
  transform(res: Response): Response {
    const sink: Sink = { append: (html) => void this.appended.push(html) };
    this.handlers['head']?.element(sink);
    this.handlers['body']?.element(sink);
    return new Response(`<html>${this.appended.join('')}</html>`, {
      status: res.status,
      headers: res.headers,
    });
  }
}
(globalThis as unknown as { HTMLRewriter: typeof FakeHTMLRewriter }).HTMLRewriter =
  FakeHTMLRewriter;

const env = {
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

async function get(
  path: string,
  headers: Record<string, string> = {},
  host = 'htmlradar.page',
): Promise<Response> {
  const worker = (await import('../src/index.js')).default;
  return worker.fetch(new Request(`https://${host}${path}`, { headers }), env, ctx);
}

const RID = '__Host-hr_rid';

// One navigation, through the jar: send what the browser holds, store what
// comes back.
async function visit(jar: Jar, path: string, host = 'htmlradar.page'): Promise<Response> {
  return jar.take(await get(path, jar.header(), host));
}

// What the browser would store, read straight off the response.
function ridCookie(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${RID}=`));
  if (!header) return null;
  return header.split(';')[0]!.slice(RID.length + 1);
}

// What the tracker is handed, read back out of the served page the way the
// sender's own script could read it.
function readerIdIn(html: string): string | null {
  const match = /"readerId":"([0-9a-f]+)"/.exec(html);
  return match ? match[1]! : null;
}

// The confirmation post, as the form on the page makes it.
async function confirm(
  optout: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const worker = (await import('../src/index.js')).default;
  const form = new FormData();
  form.append('optout', optout);
  form.append('token', token);
  return worker.fetch(
    new Request('https://htmlradar.page/r/acme-proposal', { method: 'POST', body: form, headers }),
    env,
    ctx,
  );
}

beforeEach(() => {
  getShareBySlug.mockReset();
  getShareBySlug.mockResolvedValue(share);
});

afterEach(() => vi.clearAllMocks());

describe('the returning reader', () => {
  // THE DEFECT. Two loads, one browser: one reader. Driven through the jar,
  // so the second request carries the header the worker itself emitted.
  it('yields the same identifier on a second load', async () => {
    const jar = new Jar();
    const first = await visit(jar, '/r/acme-proposal');
    expect(jar.get(RID)).toMatch(/^[0-9a-f]{32}$/);
    const firstId = readerIdIn(await first.text());
    expect(firstId).toMatch(/^[0-9a-f]{64}$/);

    const second = await visit(jar, '/r/acme-proposal');
    expect(readerIdIn(await second.text())).toBe(firstId);
  });

  it('gives two different browsers two different identifiers', async () => {
    const a = new Jar();
    const b = new Jar();
    const ra = await visit(a, '/r/acme-proposal');
    const rb = await visit(b, '/r/acme-proposal');
    expect(a.get(RID)).not.toBe(b.get(RID));
    expect(readerIdIn(await ra.text())).not.toBe(readerIdIn(await rb.text()));
  });

  // Re-minting on every load would reset a ninety-day life on each open and
  // would rewrite the value a second tab is already using.
  it('does not re-mint the cookie when the reader already has one', async () => {
    const jar = new Jar();
    await visit(jar, '/r/acme-proposal');
    const second = await visit(jar, '/r/acme-proposal');
    expect(second.headers.getSetCookie().filter((c) => c.startsWith(`${RID}=`))).toEqual([]);
  });

  it('replaces a malformed cookie rather than trusting it', async () => {
    const res = await get('/r/acme-proposal', { cookie: `${RID}=not-a-secret` });
    expect(ridCookie(res)).toMatch(/^[0-9a-f]{32}$/);
  });
});

// FINDING 2. A cookie's host scope is not a property of the host that set it.
// A customer who points decks.acme.com at us also controls acme.com, and a
// plain-named cookie set there with `Domain=acme.com` arrives at decks.acme.com
// looking exactly like ours. They could then request the document themselves
// carrying the same planted value, learn what it derives to, and recognise or
// fabricate that reader.
describe('a planted or shadowing cookie', () => {
  it('uses the __Host- prefix, which a parent domain cannot set', async () => {
    const res = await get('/r/acme-proposal');
    const header = res.headers.getSetCookie().find((c) => c.startsWith('__Host-'))!;
    expect(header).toBeDefined();
    expect(header.split('=')[0]).toBe('__Host-hr_rid');
    // The prefix's own conditions. A browser silently refuses a `__Host-`
    // cookie that breaks any of them, so asserting them here is asserting that
    // the cookie is settable at all.
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header).not.toMatch(/Domain=/i);
    // And ours on top of the prefix's.
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=7776000');
  });

  // Two values for one name is what shadowing looks like on the wire, and the
  // browser does not say which is genuine. Taking the last, as an ordinary
  // name-to-value parse does, hands the choice to whoever wrote the second.
  it('trusts neither value when the name arrives twice, and mints a fresh one', async () => {
    const planted = 'a'.repeat(32);
    const genuine = 'b'.repeat(32);
    const res = await get('/r/acme-proposal', {
      cookie: `${RID}=${planted}; ${RID}=${genuine}`,
    });
    const minted = ridCookie(res);
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    expect(minted).not.toBe(planted);
    expect(minted).not.toBe(genuine);
  });

  it('does not derive an identifier from either shadowed value', async () => {
    const planted = 'a'.repeat(32);
    const alone = await get('/r/acme-proposal', { cookie: `${RID}=${planted}` });
    const shadowed = await get('/r/acme-proposal', {
      cookie: `${RID}=${planted}; ${RID}=${'b'.repeat(32)}`,
    });
    expect(readerIdIn(await shadowed.text())).not.toBe(readerIdIn(await alone.text()));
  });
});

describe("what the sender's document can reach", () => {
  // The honest boundary. The derived value IS in the page — the tracker runs
  // there. The cookie's own value is not.
  it("never puts the cookie's own value in the page", async () => {
    const res = await get('/r/acme-proposal');
    const cookie = ridCookie(res)!;
    const html = await res.text();
    expect(html).not.toContain(cookie);
    expect(readerIdIn(html)).not.toBe(cookie);
  });

  it('binds the identifier to one document', async () => {
    const jar = new Jar();
    const first = await visit(jar, '/r/acme-proposal');
    const firstId = readerIdIn(await first.text());

    getShareBySlug.mockResolvedValue({ ...share, document_id: 'doc-2', slug: 'other-deck' });
    const second = await visit(jar, '/r/other-deck');
    expect(readerIdIn(await second.text())).not.toBe(firstId);
  });

  // Two shares of the SAME document must agree, or the database's dedup stops
  // recognising a return and the duplicate emails come back.
  it('agrees across two shares of one document', async () => {
    const jar = new Jar();
    const first = await visit(jar, '/r/acme-proposal');
    const firstId = readerIdIn(await first.text());

    getShareBySlug.mockResolvedValue({ ...share, id: 'share-2', slug: 'acme-proposal-two' });
    const second = await visit(jar, '/r/acme-proposal-two');
    expect(readerIdIn(await second.text())).toBe(firstId);
  });
});

describe('the opt-out', () => {
  it('sets no cookie and no identifier while it is in place', async () => {
    const res = await get('/r/acme-proposal', { cookie: '__Host-hr_optout=1' });
    const html = await res.text();
    expect(ridCookie(res)).toBeNull();
    expect(readerIdIn(html)).toBeNull();
    expect(html).not.toContain('src="/v1/tracker');
  });

  it('does not use an identifier the reader still holds from before', async () => {
    const before = await get('/r/acme-proposal');
    const after = await get('/r/acme-proposal', {
      cookie: `${RID}=${ridCookie(before)}; __Host-hr_optout=1`,
    });
    expect(readerIdIn(await after.text())).toBeNull();
  });

  // The whole confirmation, driven through the jar: ask, click, and the
  // browser carries its own challenge back the way it really would.
  it('deletes the identifier when the recipient confirms', async () => {
    const jar = new Jar();
    await visit(jar, '/r/acme-proposal'); // holds an identifier
    const ask = await visit(jar, '/r/acme-proposal?optout=1');
    expect(jar.get('__Host-hr_optout_c')).toMatch(/^[0-9a-f]{32}$/);

    const res = jar.take(await confirm('1', tokenFrom(await ask.text()), jar.header()));

    expect(res.status).toBe(303);
    expect(jar.get('__Host-hr_optout')).toBe('1');
    // Expired, not merely left alone.
    expect(jar.get(RID)).toBeNull();
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${RID}=`))!;
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
  });
});

// FINDING 3. The confirmation token was bound to the question, the share, the
// host and an expiry — every one of them a fact an attacker knows. An attacker
// could fetch `?optout=0` themselves and auto-submit the token from a page of
// their own, turning a victim's tracking back on over their choice and, with
// the reader cookie cleared on the same response, resetting their identity.
describe('a forged confirmation', () => {
  it('changes nothing when the browser holds no challenge', async () => {
    // The attacker's own visit, in the attacker's own jar.
    const attacker = new Jar();
    const stolen = tokenFrom(await (await visit(attacker, '/r/acme-proposal?optout=0')).text());

    // The victim's browser: an identifier, an opt-out, and no challenge,
    // because the victim never asked the question.
    const res = await confirm('0', stolen, {
      cookie: `__Host-hr_optout=1; ${RID}=${'c'.repeat(32)}`,
    });

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-hr_optout='))).toBe(false);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${RID}=`))).toBe(false);
  });

  it("changes nothing when the token is signed over the attacker's challenge", async () => {
    const attacker = new Jar();
    const stolen = tokenFrom(await (await visit(attacker, '/r/acme-proposal?optout=0')).text());

    // The victim did ask the question, so they hold a challenge — their own,
    // which is not the one the stolen token was signed over.
    const victim = new Jar();
    await visit(victim, '/r/acme-proposal?optout=0');
    expect(victim.get('__Host-hr_optout_c')).not.toBe(attacker.get('__Host-hr_optout_c'));

    const res = await confirm('0', stolen, victim.header());

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-hr_optout='))).toBe(false);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${RID}=`))).toBe(false);
  });

  // The refusal re-asks with a fresh pair rather than dead-ending, so a
  // recipient whose page sat open too long is never stuck.
  it('re-asks with a fresh challenge instead of dead-ending', async () => {
    const jar = new Jar();
    const before = jar.get('__Host-hr_optout_c');
    const res = jar.take(await confirm('1', 'nonsense.deadbeef', jar.header()));
    expect(res.status).toBe(400);
    expect(jar.get('__Host-hr_optout_c')).toMatch(/^[0-9a-f]{32}$/);
    expect(jar.get('__Host-hr_optout_c')).not.toBe(before);
    expect(await res.text()).toContain('name="token"');
  });

  // The challenge is spent on use, so a captured form cannot be replayed for
  // the rest of its ten minutes.
  it('cannot be replayed once the confirmation has been used', async () => {
    const jar = new Jar();
    const ask = await visit(jar, '/r/acme-proposal?optout=1');
    const token = tokenFrom(await ask.text());
    const header = jar.header();

    const first = jar.take(await confirm('1', token, header));
    expect(first.status).toBe(303);

    // The same token and the same cookies a second time: the browser no longer
    // holds the challenge, because the first use expired it.
    const replay = await confirm('1', token, jar.header());
    expect(replay.status).toBe(400);
  });

  // SameSite=None is what lets the genuine post work at all: the confirmation
  // page is sandboxed into an opaque origin, which has no registrable domain,
  // so the browser treats a post back to its own host as cross-site and would
  // not send a Lax cookie with it.
  it('sends the challenge on a cross-site post, and relies on secrecy not on the site check', async () => {
    const res = await get('/r/acme-proposal?optout=1');
    const header = res.headers.getSetCookie().find((c) => c.startsWith('__Host-hr_optout_c='))!;
    expect(header).toContain('SameSite=None');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    // The `__Host-` prefix's own conditions, which are also what stop a
    // customer's parent domain planting a challenge of their choosing.
    expect(header).toContain('Path=/');
    expect(header).not.toMatch(/Domain=/i);
    // The confirmation page really is sandboxed, which is why the above is
    // necessary rather than lax.
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
  });
});

describe('routes that are not a read', () => {
  it('mints nothing on the print route', async () => {
    const wrapperEnv = { ...env, TRUST_WRAPPER: '*' } as typeof env;
    const worker = (await import('../src/index.js')).default;
    const wrapper = await worker.fetch(
      new Request('https://htmlradar.page/r/acme-proposal'),
      wrapperEnv,
      ctx,
    );
    const html = await wrapper.text();
    const printHref = /href="(\/r\/acme-proposal\/print\?g=[^"]+)"/.exec(html)![1]!;
    const printCookie = wrapper.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-hr_print='))!
      .split(';')[0]!;

    const res = await worker.fetch(
      new Request(`https://htmlradar.page${printHref}`, { headers: { cookie: printCookie } }),
      wrapperEnv,
      ctx,
    );
    expect(ridCookie(res)).toBeNull();
    expect(readerIdIn(await res.text())).toBeNull();
  });
});

// M1 and M2: the two cookies a customer's own parent domain could still
// interfere with. Both attacks need only a page on acme.com and a reader who
// visits decks.acme.com, which is the customer's own document host.
describe('a planted cookie from a parent domain', () => {
  // M1. The challenge was the forgery defence, and while it was plainly named
  // it was itself plantable: get a matching pair on your own host, plant the
  // challenge in the reader's browser, auto-submit the token. The reader holds
  // no challenge of their own, so the duplicate rule never fires and the two
  // agree. `__Host-` is what stops the plant — a browser will not set the name
  // with a Domain attribute at all, so a cookie under the OLD name is just a
  // cookie with a different name, and is ignored.
  it('ignores a legacy-named challenge entirely', async () => {
    const attacker = new Jar();
    const stolen = tokenFrom(await (await visit(attacker, '/r/acme-proposal?optout=0')).text());
    const planted = attacker.get('__Host-hr_optout_c')!;

    // The reader, carrying an opt-out and the attacker's challenge under the
    // name a parent domain is able to write.
    const res = await confirm('0', stolen, {
      cookie: `__Host-hr_optout=1; hr_optout_c=${planted}`,
    });

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-hr_optout='))).toBe(false);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('hr_optout='))).toBe(false);
  });

  // M2. Browsers send cookies of equal path specificity oldest-first, so a
  // planted copy arrives after the genuine one and a last-wins parse takes it.
  // The read now scans every copy of either name and any '1' wins.
  it('leaves the reader opted out when hr_optout=0 is planted after a real opt-out', async () => {
    const res = await get('/r/acme-proposal', {
      cookie: '__Host-hr_optout=1; hr_optout=0',
    });
    const html = await res.text();
    expect(html).not.toContain('src="/v1/tracker');
    expect(readerIdIn(html)).toBeNull();
    expect(ridCookie(res)).toBeNull();
  });

  it('leaves a legacy-only reader opted out when hr_optout=0 is planted after it', async () => {
    // Both under the old name: the genuine '1' first, the planted '0' second.
    const res = await get('/r/acme-proposal', { cookie: 'hr_optout=1; hr_optout=0' });
    const html = await res.text();
    expect(html).not.toContain('src="/v1/tracker');
    expect(ridCookie(res)).toBeNull();
  });

  // Planting can still turn an opt-out ON. That costs the planter their own
  // tracking and harms no reader, so it is left alone deliberately.
  it('honours a planted opt-out, because turning tracking off hurts nobody', async () => {
    const res = await get('/r/acme-proposal', { cookie: 'hr_optout=1' });
    expect(await res.text()).not.toContain('src="/v1/tracker');
  });
});

describe('migrating an old opt-out', () => {
  it('writes the __Host- name alongside a legacy-only opt-out', async () => {
    const res = await get('/r/acme-proposal', { cookie: 'hr_optout=1' });
    const migrated = res.headers.getSetCookie().find((c) => c.startsWith('__Host-hr_optout='));
    expect(migrated).toContain('__Host-hr_optout=1');
    expect(migrated).toContain('Path=/');
    expect(migrated).toContain('Secure');
    expect(migrated).toContain('HttpOnly');
    expect(migrated).not.toMatch(/Domain=/i);
    // Still no tracker and no identifier: migrating is not resuming.
    const html = await res.text();
    expect(html).not.toContain('src="/v1/tracker');
    expect(readerIdIn(html)).toBeNull();
  });

  it('does not rewrite it once the reader already holds the new name', async () => {
    const res = await get('/r/acme-proposal', { cookie: '__Host-hr_optout=1; hr_optout=1' });
    expect(res.headers.getSetCookie().filter((c) => c.startsWith('__Host-hr_optout='))).toEqual([]);
  });

  it('opting back in expires both names', async () => {
    const jar = new Jar().set('__Host-hr_optout', '1').set('hr_optout', '1');
    const ask = await visit(jar, '/r/acme-proposal?optout=0');
    const res = await confirm('0', tokenFrom(await ask.text()), jar.header());

    expect(res.status).toBe(303);
    const cookies = res.headers.getSetCookie();
    const fresh = cookies.find((c) => c.startsWith('__Host-hr_optout='))!;
    const legacy = cookies.find((c) => c.startsWith('hr_optout='))!;
    expect(fresh).toContain('Max-Age=0');
    expect(legacy).toContain('Max-Age=0');
    expect(legacy).toContain('Path=/r/');

    // And the browser really is left holding neither.
    jar.take(res);
    expect(jar.get('__Host-hr_optout')).toBeNull();
    expect(jar.get('hr_optout')).toBeNull();
  });
});
