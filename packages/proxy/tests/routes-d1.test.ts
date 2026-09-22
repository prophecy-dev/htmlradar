import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeD1, type FakeD1 } from '../../db/tests/d1-fake.js';
import { DOC, OWNER, seedOwnerAndDoc, seedShare } from '../../db/tests/seed.js';
import { issueCommentProof, issueEmailCookie, issueVerifiedCookie } from '../src/auth.js';
import { TRACKER_JS, TRACKER_VERSION } from '../src/tracker-bundle.js';

// The worker end to end on the real store, over a node:sqlite D1 that has had
// the real migrations applied: the tracker's /t calls, the unfurl card a
// crawler gets, the privacy notice and the card image. Nothing in src/ is
// mocked; the only fakes are the bindings (D1, R2, Email Service) and
// Telegram's fetch.

type Env = import('../src/env.js').Env;

const SENT: Array<{ to: string; subject: string }> = [];
let db: FakeD1 & D1Database;
let objects: Record<string, { body: string; type?: string }>;
let pending: Array<Promise<unknown>>;

const ctx = {
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function env(over: Partial<Env> = {}): Env {
  return {
    DB: db,
    DOCS_BUCKET: {
      get: async (key: string) => {
        const o = objects[key];
        if (!o) return null;
        return {
          body: new Response(o.body).body,
          httpMetadata: o.type ? { contentType: o.type } : {},
        };
      },
    },
    EMAIL: {
      send: async (m: { to: string; subject: string }) => {
        SENT.push({ to: m.to, subject: m.subject });
        return {};
      },
    },
    SESSION_SECRET: 'test-session-secret',
    GATE_FLOOR_MS: '0',
    BRAND_NAME: 'Hivemarket',
    ...over,
  } as unknown as Env;
}

async function call(path: string, init: RequestInit = {}, e: Env = env()): Promise<Response> {
  const worker = (await import('../src/index.js')).default;
  const res = await worker.fetch(new Request(`https://docs.example${path}`, init), e, ctx);
  while (pending.length) await pending.shift();
  return res;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}, e?: Env) =>
  call(
    path,
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
    },
    e,
  );

const SLACKBOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

// HTMLRewriter is a Workers global with no Node equivalent. The comment tests
// need only what the proxy injects into <head> and <body> (the tracker config
// carrying the comment proof), so this keeps exactly that and drops the rest,
// as reader-identity.test.ts does.
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

beforeEach(() => {
  db = fakeD1();
  seedOwnerAndDoc(db, { telegram: '4242' });
  objects = {};
  pending = [];
  SENT.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe('the tracker endpoints', () => {
  it('answers the CORS preflight from an opaque origin', async () => {
    const res = await call('/t/start_session', {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  // Geo comes from request.cf the same way, which Node cannot construct; with
  // no cf the page's value stands, as under `wrangler dev`.
  it('opens a session, taking the user agent from the request, not the page', async () => {
    seedShare(db, { slug: 'open' });
    const res = await post(
      '/t/start_session',
      { p_share_slug: 'open', p_fingerprint: 'fp-1', p_country_code: 'DE', p_user_agent: 'forged' },
      { 'User-Agent': 'Mozilla/5.0 (Macintosh)' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { session_id: string; token: string; document_id: string };
    expect(body.document_id).toBe(DOC.id);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    const [row] = db.rows(`SELECT user_agent, country_code FROM viewers`) as Array<
      Record<string, unknown>
    >;
    expect(row!['user_agent']).toBe('Mozilla/5.0 (Macintosh)');
    expect(row!['country_code']).toBe('DE');
  });

  it('turns a refusal into a 400 carrying the P-code the tracker maps', async () => {
    seedShare(db, { slug: 'dead', revoked_at: '2026-01-01T00:00:00Z' });
    const res = await post('/t/start_session', { p_share_slug: 'dead', p_fingerprint: 'fp' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'P0003' });
  });

  it('rejects a body that is not a JSON object, and anything but POST', async () => {
    expect((await post('/t/start_session', 'not json')).status).toBe(400);
    expect((await post('/t/start_session', '[1]')).status).toBe(400);
    expect((await call('/t/update_session')).status).toBe(405);
  });

  it('writes the heartbeat and sends the first-read alert once, after the reply', async () => {
    seedShare(db, { slug: 'open' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const e = env({ TELEGRAM_BOT_TOKEN: 'bot-token', APP_ORIGIN: 'https://radar.example' });
    const s = (await (
      await post('/t/start_session', { p_share_slug: 'open', p_fingerprint: 'fp-1' }, {}, e)
    ).json()) as { session_id: string; token: string };

    const beat = (over: Record<string, unknown>) =>
      post(
        '/t/update_session',
        { p_session_id: s.session_id, p_token: s.token, p_max_scroll: 0, p_sections: [], ...over },
        {},
        e,
      );

    const first = await beat({
      p_active_seconds: 12,
      p_max_scroll: 0.5,
      p_sections: [{ section_id: 'slide-1', section_title: 'Why', time_seconds: 12, ordinal: 0 }],
    });
    expect(first.status).toBe(204);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await beat({ p_active_seconds: 30 });

    expect(db.rows(`SELECT active_time_seconds, max_scroll_depth FROM sessions`)).toEqual([
      { active_time_seconds: 30, max_scroll_depth: 0.5 },
    ]);
    expect(SENT).toEqual([{ to: OWNER.email, subject: `Someone is reading ${DOC.title}` }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/botbot-token/sendMessage');
    expect(
      db.rows(`SELECT channel, email_to, status FROM notifications_log ORDER BY channel`),
    ).toEqual([
      { channel: 'email', email_to: OWNER.email, status: 'delivered' },
      { channel: 'telegram', email_to: '4242', status: 'delivered' },
    ]);
  });

  it('refuses a heartbeat with the wrong token', async () => {
    seedShare(db, { slug: 'open' });
    const s = (await (
      await post('/t/start_session', { p_share_slug: 'open', p_fingerprint: 'fp-1' })
    ).json()) as { session_id: string };
    const res = await post('/t/update_session', {
      p_session_id: s.session_id,
      p_token: 'f'.repeat(64),
      p_active_seconds: 5,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'P0010' });
    expect(SENT).toEqual([]);
  });
});

describe('the comment endpoint', () => {
  const SECRET = 'test-session-secret';
  const BUYER = 'buyer@acme.test';

  // The reader has already been through the gate by the time the tracker can
  // post: the verification row is what that step leaves behind, and the
  // session is what the tracker holds.
  async function verifiedSession(
    e: Env,
    slug = 'rfp',
    email = BUYER,
  ): Promise<{ session_id: string; token: string }> {
    seedShare(db, { slug, require_email: true, verify_email: true });
    db.rows(
      `INSERT INTO share_email_verifications (share_id, email) VALUES (?, ?)`,
      `share-${slug}`,
      email,
    );
    return (await (
      await post('/t/start_session', { p_share_slug: slug, p_email: email }, {}, e)
    ).json()) as { session_id: string; token: string };
  }

  /** The proof the proxy signs into a deck served to a reader holding a verified cookie. */
  async function proofFromTheDeck(slug: string, email: string, e: Env): Promise<string> {
    objects[DOC.r2_key] = { body: '<html><head></head><body><h2>Pricing</h2></body></html>' };
    const html = await (
      await call(
        `/r/${slug}`,
        { headers: { Cookie: (await issueVerifiedCookie(slug, email, SECRET)).split(';')[0]! } },
        e,
      )
    ).text();
    const proof = /"comments":\{"enabled":true,"proof":"([^"]+)"\}/.exec(html)?.[1];
    if (!proof) throw new Error('no comment proof in the served deck');
    return proof;
  }

  const refusal = async (res: Response) => ({ status: res.status, body: await res.json() });
  const NOT_VERIFIED = { status: 400, body: { code: 'P0012', message: 'not_verified' } };

  it('stores the comment and tells the sender, after the reply', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const e = env({ TELEGRAM_BOT_TOKEN: 'bot-token', APP_ORIGIN: 'https://radar.example' });
    const s = await verifiedSession(e);
    const proof = await proofFromTheDeck('rfp', BUYER, e);

    const res = await post(
      '/t/comment',
      {
        p_session_id: s.session_id,
        p_token: s.token,
        p_proof: proof,
        p_section_id: 'pricing',
        p_section_title: 'Pricing',
        p_body: '  Can you break out the year-two number?  ',
      },
      {},
      e,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(db.rows(`SELECT section_id, section_title, body FROM document_comments`)).toEqual([
      {
        section_id: 'pricing',
        section_title: 'Pricing',
        body: 'Can you break out the year-two number?',
      },
    ]);

    expect(SENT).toEqual([
      { to: OWNER.email, subject: `buyer@acme.test commented on ${DOC.title}` },
    ]);
    const telegram = fetchSpy.mock.calls.find((c) => String(c[0]).includes('sendMessage'));
    expect(String((telegram?.[1] as RequestInit | undefined)?.body)).toContain(
      'commented on Pricing',
    );
    expect(db.rows(`SELECT kind, channel, status FROM notifications_log ORDER BY channel`)).toEqual(
      [
        { kind: 'comment', channel: 'email', status: 'delivered' },
        { kind: 'comment', channel: 'telegram', status: 'delivered' },
      ],
    );
  });

  // The impersonation the proof exists for: the boss verified on this link
  // yesterday, and whoever the link was forwarded to starts a session simply
  // CLAIMING the boss's address. The session and its verification row are both
  // genuine; only the cookie is missing, and without it there is no proof.
  it('refuses a session that claims a verified address but carries no proof of it', async () => {
    const e = env();
    const forged = await verifiedSession(e);
    const res = await post('/t/comment', {
      p_session_id: forged.session_id,
      p_token: forged.token,
      p_body: 'Approved — go ahead.',
    });
    expect(await refusal(res)).toEqual(NOT_VERIFIED);
    expect(db.rows(`SELECT count(*) AS n FROM document_comments`)).toEqual([{ n: 0 }]);
    expect(SENT).toEqual([]);
  });

  it('refuses a proof minted for somebody else, even on the same link', async () => {
    const e = env();
    const forged = await verifiedSession(e);
    // The forwardee verifies their OWN address and so gets a real proof —
    // for their address, which is not the one on the session they post from.
    db.rows(
      `INSERT INTO share_email_verifications (share_id, email) VALUES ('share-rfp', 'fwd@else.test')`,
    );
    const theirs = await proofFromTheDeck('rfp', 'fwd@else.test', e);
    const res = await post('/t/comment', {
      p_session_id: forged.session_id,
      p_token: forged.token,
      p_proof: theirs,
      p_body: 'Approved — go ahead.',
    });
    expect(await refusal(res)).toEqual(NOT_VERIFIED);
  });

  it('refuses a proof minted for another link', async () => {
    const e = env();
    const s = await verifiedSession(e, 'rfp');
    const elsewhere = await issueCommentProof('other-link', BUYER, 4_102_444_800, SECRET);
    const res = await post('/t/comment', {
      p_session_id: s.session_id,
      p_token: s.token,
      p_proof: elsewhere,
      p_body: 'Hello?',
    });
    expect(await refusal(res)).toEqual(NOT_VERIFIED);
  });

  it('refuses an expired proof, and a tampered one', async () => {
    const e = env();
    const s = await verifiedSession(e);
    // Bound to a cookie that ran out a minute ago.
    const expired = await issueCommentProof(
      'rfp',
      BUYER,
      Math.floor(Date.now() / 1000) - 60,
      SECRET,
    );
    const good = await proofFromTheDeck('rfp', BUYER, e);
    const [exp, mac] = good.split('.') as [string, string];
    for (const p_proof of [expired, `${Number(exp) + 3600}.${mac}`, `${exp}.${'0'.repeat(64)}`]) {
      const res = await post('/t/comment', {
        p_session_id: s.session_id,
        p_token: s.token,
        p_proof,
        p_body: 'Hello?',
      });
      expect(await refusal(res)).toEqual(NOT_VERIFIED);
    }
  });

  // The oracle the old refusals were: a stored comment for an address that had
  // verified, P0012 for one that had not. Without a proof every one of these
  // must read the same, so posting learns nothing about who verified.
  it('answers identically whether or not the claimed address ever verified', async () => {
    const e = env();
    const verified = await verifiedSession(e);
    const walkIn = (await (
      await post('/t/start_session', { p_share_slug: 'rfp', p_email: 'walkin@acme.test' }, {}, e)
    ).json()) as { session_id: string; token: string };
    const answers = [];
    for (const s of [verified, walkIn, { session_id: 'no-such-session', token: 'x' }]) {
      answers.push(
        await refusal(
          await post('/t/comment', { p_session_id: s.session_id, p_token: s.token, p_body: 'Hi' }),
        ),
      );
    }
    expect(answers).toEqual([NOT_VERIFIED, NOT_VERIFIED, NOT_VERIFIED]);
  });

  it('refuses a comment carrying the wrong token, proof or not', async () => {
    const e = env();
    const s = await verifiedSession(e);
    const proof = await proofFromTheDeck('rfp', BUYER, e);
    const res = await post(
      '/t/comment',
      { p_session_id: s.session_id, p_token: 'f'.repeat(64), p_proof: proof, p_body: 'Hello?' },
      {},
      e,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'P0010' });
  });

  it('puts no proof in a deck served without a verified cookie', async () => {
    seedShare(db, { slug: 'plain', require_email: true });
    objects[DOC.r2_key] = { body: '<html><head></head><body><h2>Pricing</h2></body></html>' };
    const cookie = (await issueEmailCookie('plain', BUYER, SECRET)).split(';')[0]!;
    const html = await (await call('/r/plain', { headers: { Cookie: cookie } })).text();
    // Served and tracked — the reader got past the gate — just with no box.
    expect(html).toContain('"email":"buyer@acme.test"');
    expect(html).not.toContain('"comments"');
  });
});

describe('the unfurl card', () => {
  it("gives a crawler the sender's card and nothing else", async () => {
    seedShare(db, { slug: 'open' });
    const res = await call('/r/open', { headers: { 'User-Agent': SLACKBOT } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<meta property="og:title" content="${DOC.title}">`);
    expect(html).toContain('<meta property="og:description" content="Per-slide read tracking">');
    expect(html).toContain('<meta property="og:url" content="https://docs.example/r/open">');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('HTMLRadarConfig');
    expect(html).not.toContain('/v1/tracker');
    expect(res.headers.getSetCookie()).toEqual([]);
    // A preview is not a read.
    expect(db.rows(`SELECT count(*) AS n FROM sessions`)).toEqual([{ n: 0 }]);
  });

  it('shows the same card for a gated link, and never the gate or the document', async () => {
    seedShare(db, { slug: 'rfp', require_email: true, verify_email: true });
    objects[DOC.r2_key] = { body: '<html><body><h1>SECRET PRICING</h1></body></html>' };
    const html = await (await call('/r/rfp', { headers: { 'User-Agent': SLACKBOT } })).text();
    expect(html).toContain(DOC.title);
    expect(html).not.toContain('SECRET PRICING');
    expect(html).not.toContain('<form');
  });

  it('carries og:image when the document has a card image', async () => {
    seedShare(db, { slug: 'open' });
    db.rows(`UPDATE documents SET og_image_r2_key = 'og/owner-1/doc-1/x.png'`);
    const html = await (await call('/r/open', { headers: { 'User-Agent': SLACKBOT } })).text();
    expect(html).toContain(
      '<meta property="og:image" content="https://docs.example/r/open/og-image">',
    );
  });

  it('unfurls a revoked link as revoked', async () => {
    seedShare(db, { slug: 'dead', revoked_at: '2026-01-01T00:00:00Z' });
    const res = await call('/r/dead', { headers: { 'User-Agent': SLACKBOT } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(DOC.title);
  });

  it("puts the share's card on a gate a person sees", async () => {
    seedShare(db, { slug: 'gated', require_email: true });
    const html = await (await call('/r/gated')).text();
    expect(html).toContain('action="/r/gated/email"');
    expect(html).toContain(`<meta property="og:title" content="${DOC.title}">`);
    expect((html.match(/property="og:title"/g) ?? []).length).toBe(1);
  });
});

describe('the card image', () => {
  it('serves the image from R2, publicly cacheable', async () => {
    seedShare(db, { slug: 'open' });
    db.rows(`UPDATE documents SET og_image_r2_key = 'og/owner-1/doc-1/x.png'`);
    objects['og/owner-1/doc-1/x.png'] = { body: 'PNG', type: 'image/png' };
    const res = await call('/r/open/og-image');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(await res.text()).toBe('PNG');
  });

  it('is not found without an image, for an SVG, or on a revoked link', async () => {
    seedShare(db, { slug: 'open' });
    expect((await call('/r/open/og-image')).status).toBe(404);

    db.rows(`UPDATE documents SET og_image_r2_key = 'og/owner-1/doc-1/x.svg'`);
    objects['og/owner-1/doc-1/x.svg'] = { body: '<svg/>', type: 'image/svg+xml' };
    expect((await call('/r/open/og-image')).status).toBe(404);

    db.rows(`UPDATE documents SET og_image_r2_key = 'og/owner-1/doc-1/x.png'`);
    objects['og/owner-1/doc-1/x.png'] = { body: 'PNG', type: 'image/png' };
    db.rows(`UPDATE document_shares SET revoked_at = '2026-01-01T00:00:00Z'`);
    expect((await call('/r/open/og-image')).status).toBe(404);
  });
});

describe('the privacy notice and the tracker script', () => {
  it('serves /privacy with the configured contact', async () => {
    const res = await call('/privacy', {}, env({ PRIVACY_CONTACT: 'privacy@hive.land' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('the Hivemarket team (Somnia)');
    expect(html).toContain('mailto:privacy@hive.land');
  });

  it('serves the bundled tracker, immutable at its own version', async () => {
    const pinned = await call(`/v1/tracker.${TRACKER_VERSION}.js`);
    expect(pinned.headers.get('Cache-Control')).toContain('immutable');
    expect(await pinned.text()).toBe(TRACKER_JS);
    const floating = await call('/v1/tracker.js');
    expect(floating.headers.get('Cache-Control')).not.toContain('immutable');
  });
});
