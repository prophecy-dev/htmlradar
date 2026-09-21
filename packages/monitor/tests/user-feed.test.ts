import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Env, userFeed, userFeedDaily } from '../src/index.js';

// The user feed exists because the people were invisible: the first paying
// customer was noticed a day after he paid. These tests hold the properties
// that stop being true if it regresses — one message per moment and not one
// per row, our own accounts and the public demo link never counted as news,
// the cursor closing the window so a second run over the same rows is silent,
// and a Supabase refusal costing nothing (nothing sent, cursor unmoved, so the
// next run covers the same window rather than skipping it).
//
// And, since the trim: a share is worth exactly one read message, its first.
// Every later read is a number in the daily line, which is itself silent on a
// day nobody read anything.

// Run on vitest's forks pool (see package.json), same as sentinel.test.ts.

const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  RESEND_API_KEY: 'resend-key',
  RESEND_FROM: 'HTMLRadar <hello@htmlradar.com>',
  ALERT_TO: 'hello@htmlradar.com',
  POSTHOG_HOST: 'https://posthog.test',
  TELEGRAM_BOT_TOKEN: 'bot-token-that-must-never-appear-in-a-row',
  TELEGRAM_CHAT_ID: '106874',
} as Env;

const OUTBOX_URL = 'https://db.test/rest/v1/telegram_outbox';
const TELEGRAM_URL = 'https://api.telegram.org/bot';

const NOW = Date.parse('2026-09-16T10:05:00.000Z');
const NEXT_RUN = NOW + 5 * 60_000;
const CURSOR_AT = '2026-09-16T10:00:00.000Z';
/** Inside [CURSOR_AT, NOW) — every fixture row is stamped with it. */
const AT = '2026-09-16T10:02:00.000Z';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NEWCOMER = '22222222-2222-4222-8222-222222222222';
const US = '33333333-3333-4333-8333-333333333333';

interface OutboxWrite {
  kind: string;
  source: string;
  message: string;
  telegram_ok: boolean | null;
  meta?: Record<string, unknown>;
}

/** Canned rows, or a Response for a refusal (a 500 is not an empty table). */
type Answer = unknown[] | Response;

interface World {
  /** Rows in the tables the feed reads per run. Anything unnamed is empty. */
  signups?: Answer;
  shares?: Answer;
  sessions?: Answer;
  /** sessions?share_id=eq.… — what the share was opened by BEFORE the window. */
  priorSessions?: Answer;
  /** The app_events read: money moving and money being considered. */
  events?: Answer;
  /** app_events?user_id=eq.… — the same user's intent in the day before. */
  priorIntents?: Answer;
  /** Every share the named owners hold, for the "first ever" test. */
  allShares?: Answer;
  /** profiles?id=in.(...) — the owner-email lookup. */
  profiles?: Answer;
  /** The user.signed_up attribution rows. */
  signupEvents?: Answer;
  /** Absent means the cursor row exists and reads CURSOR_AT. */
  cursorMissing?: boolean;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Applies the request's own [gte, lt) to the canned rows, so "the second run
 * says nothing" is the real behaviour rather than an assertion about a URL.
 * A row with no timestamp is a fixture bug and says so.
 */
function inWindow(url: string, rows: unknown[]): unknown[] {
  const bound = (op: string): number =>
    Date.parse(decodeURIComponent(new RegExp(`${op}\\.([^&]+)`).exec(url)![1]!));
  const gte = bound('gte');
  const lt = bound('lt');
  return rows.filter((r) => {
    const row = r as Record<string, unknown>;
    const stamp = row['created_at'] ?? row['started_at'] ?? row['timestamp'];
    if (typeof stamp !== 'string') throw new Error(`fixture row has no timestamp: ${url}`);
    const at = Date.parse(stamp);
    return at >= gte && at < lt;
  });
}

/**
 * Routes every fetch by URL, keeps what was sent and written, and honours the
 * PATCH — so a second userFeed() call against the same stub sees the window the
 * first one closed.
 */
function stubWorld(world: World) {
  const outbox: OutboxWrite[] = [];
  const telegram: { text: string; chat_id: string }[] = [];
  const cursor = { at: world.cursorMissing ? null : CURSOR_AT };
  const reply = (url: string, value: Answer | undefined, windowed: boolean): Response => {
    if (value instanceof Response) return value.clone();
    return json(windowed ? inWindow(url, value ?? []) : (value ?? []));
  };

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(TELEGRAM_URL)) {
        telegram.push(JSON.parse(String(init?.body)) as { text: string; chat_id: string });
        return json({ ok: true, result: { message_id: 7 } });
      }
      if (url.startsWith(OUTBOX_URL) && init?.method === 'POST') {
        outbox.push(JSON.parse(String(init.body)) as OutboxWrite);
        return new Response('', { status: 201 });
      }
      if (url.includes('/user_feed_cursor')) {
        if (init?.method === 'PATCH') {
          cursor.at = (JSON.parse(String(init.body)) as { last_run_at: string }).last_run_at;
          // PostgREST answers a PATCH with 204 and no body.
          return new Response(null, { status: 204 });
        }
        return json(cursor.at ? [{ last_run_at: cursor.at }] : []);
      }
      // A window filter is what separates a per-run read from a lookup.
      const windowed = url.includes('gte.') && url.includes('lt.');
      if (url.includes('/profiles')) {
        return reply(url, windowed ? world.signups : world.profiles, windowed);
      }
      if (url.includes('/document_shares')) {
        return reply(url, windowed ? world.shares : world.allShares, windowed);
      }
      if (url.includes('/sessions')) {
        // The "has anyone opened this share before?" lookup: one share, an
        // open-ended past, so it is not a windowed read.
        if (url.includes('share_id=eq.')) return reply(url, world.priorSessions, false);
        return reply(url, world.sessions, windowed);
      }
      if (url.includes('/app_events')) {
        if (url.includes('user.signed_up')) return reply(url, world.signupEvents, windowed);
        // "Has this user done this in the day before the window?" — one user,
        // one event, its own 24 hours.
        if (url.includes('user_id=eq.')) {
          const event = /event=eq\.([^&]+)/.exec(url)![1]!;
          const rows = world.priorIntents;
          if (rows instanceof Response) return rows.clone();
          return reply(
            url,
            (rows ?? []).filter((r) => (r as { event: string }).event === event),
            true,
          );
        }
        // Honour the event=in.(…) filter, so "the feed no longer asks for that
        // event" is provable by handing it the event anyway.
        const answer = world.events;
        if (Array.isArray(answer)) {
          const wanted = /event=in\.\(([^)]+)\)/.exec(url)![1]!.split(',');
          return reply(
            url,
            answer.filter((r) => wanted.includes((r as { event: string }).event)),
            windowed,
          );
        }
        return reply(url, answer, windowed);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
  return { outbox, telegram, cursor };
}

const ownersShare = {
  slug: 'quiet-otter',
  owner_id: OWNER,
  document_id: 'doc-1',
  documents: { title: 'Series A deck' },
};

/** One of each moment, all inside [CURSOR_AT, NOW). */
const busyWindow = (): World => ({
  signups: [{ id: NEWCOMER, email: 'ceo@northwind.example', created_at: AT }],
  signupEvents: [
    {
      event: 'user.signed_up',
      user_id: NEWCOMER,
      properties: {
        provider: 'google',
        first_referrer: 'https://news.ycombinator.com/item?id=1',
        first_landing: '/convert',
      },
    },
  ],
  shares: [{ id: 'share-1', ...ownersShare, created_at: AT }],
  allShares: [{ owner_id: OWNER }],
  sessions: [
    {
      started_at: AT,
      share_id: 'share-1',
      viewers: { email: 'partner@fund.example', country_code: 'DE', device_type: 'desktop' },
      document_shares: ownersShare,
    },
  ],
  events: [{ event: 'subscription.activated', user_id: OWNER, timestamp: AT }],
  profiles: [{ id: OWNER, email: 'founder@acme.example' }],
});

afterEach(() => vi.restoreAllMocks());

describe('one message per moment', () => {
  it('says each of the four moments once, and nothing else', async () => {
    const { outbox, telegram } = stubWorld(busyWindow());

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      'New sign-up: northwind.example (google) via news.ycombinator.com /convert',
      "First share: acme.example — 'Series A deck'",
      "First read: acme.example's 'Series A deck' opened from DE/desktop",
      'acme.example upgraded to Pro',
    ]);
    // Every send leaves its receipt, under the kind schema/051 widened for.
    expect(outbox).toHaveLength(4);
    expect(outbox.every((r) => r.kind === 'user_feed')).toBe(true);
    expect(outbox.map((r) => r.source)).toEqual(['signup', 'first-share', 'first-read', 'billing']);
    expect(outbox[0]!.message).toBe(telegram[0]!.text);
    // The bot token is in the URL, never in a row (schema/038).
    expect(JSON.stringify(outbox)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it('falls back to "source unknown" when the sign-up carries no attribution', async () => {
    const { telegram } = stubWorld({
      signups: [{ id: NEWCOMER, email: 'ceo@northwind.example', created_at: AT }],
      signupEvents: [],
    });

    await userFeed(env, NOW);

    expect(telegram[0]!.text).toBe('New sign-up: northwind.example via source unknown');
  });

  it('names the campaign tag on a sign-up that carries one', async () => {
    const { telegram } = stubWorld({
      signups: [{ id: NEWCOMER, email: 'ceo@northwind.example', created_at: AT }],
      signupEvents: [
        {
          event: 'user.signed_up',
          user_id: NEWCOMER,
          // An assistant sends no referrer, so the tag is the only evidence.
          properties: { first_utm_source: 'chatgpt.com', first_landing: '/convert' },
        },
      ],
    });

    await userFeed(env, NOW);

    expect(telegram[0]!.text).toBe('New sign-up: northwind.example via chatgpt.com /convert');
  });

  it('says a tag that repeats the referrer host once, not twice', async () => {
    const { telegram } = stubWorld({
      signups: [{ id: NEWCOMER, email: 'ceo@northwind.example', created_at: AT }],
      signupEvents: [
        {
          event: 'user.signed_up',
          user_id: NEWCOMER,
          properties: {
            first_utm_source: 'news.ycombinator.com',
            first_referrer: 'https://news.ycombinator.com/item?id=1',
            first_landing: '/',
          },
        },
      ],
    });

    await userFeed(env, NOW);

    expect(telegram[0]!.text).toBe('New sign-up: northwind.example via news.ycombinator.com /');
  });

  it('stays quiet about a share that is not the owner’s first', async () => {
    const world = busyWindow();
    world.allShares = [{ owner_id: OWNER }, { owner_id: OWNER }];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).not.toContain(
      "First share: acme.example — 'Series A deck'",
    );
    expect(telegram).toHaveLength(3);
  });

  it('reports one read per share, however many sessions it had', async () => {
    const world = busyWindow();
    const session = (world.sessions as unknown[])[0];
    world.sessions = [session, session, session];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.filter((t) => t.text.startsWith('First read:'))).toHaveLength(1);
  });

  it('ignores an owner reading their own document', async () => {
    const world = busyWindow();
    world.sessions = [
      {
        started_at: AT,
        share_id: 'share-1',
        viewers: { email: 'founder@acme.example', country_code: 'IN', device_type: 'desktop' },
        document_shares: ownersShare,
      },
    ];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.filter((t) => t.text.startsWith('First read:'))).toHaveLength(0);
  });

  it('counts an anonymous reader, whose domain is nobody’s', async () => {
    const world = busyWindow();
    world.sessions = [
      {
        started_at: AT,
        share_id: 'share-1',
        viewers: { email: null, country_code: null, device_type: null },
        document_shares: ownersShare,
      },
    ];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toContain(
      "First read: acme.example's 'Series A deck' opened from ??/unknown",
    );
  });

  it('names each money moment, once per user per event', async () => {
    const { telegram } = stubWorld({
      events: [
        { event: 'subscription.activated', user_id: OWNER, timestamp: AT },
        // Polar retries a webhook; the founder hears it once.
        { event: 'subscription.activated', user_id: OWNER, timestamp: AT },
        { event: 'subscription.canceled', user_id: OWNER, timestamp: AT },
        { event: 'subscription.revoked', user_id: OWNER, timestamp: AT },
        // No account behind it: nothing to name, so nothing to say.
        { event: 'subscription.activated', user_id: null, timestamp: AT },
      ],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      'acme.example upgraded to Pro',
      'acme.example cancelled Pro',
      'acme.example dropped back to free',
    ]);
  });

  it('names both buying signals', async () => {
    const { telegram, outbox } = stubWorld({
      events: [
        { event: 'free_tier.share_cap_hit', user_id: OWNER, timestamp: AT },
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
      ],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      'acme.example hit the free link limit',
      'acme.example looked at the upgrade page',
    ]);
    expect(outbox.map((r) => r.source)).toEqual(['intent', 'intent']);
  });

  it('never asks about the cap card, which fires hundreds of times a week', async () => {
    stubWorld({});

    await userFeed(env, NOW);

    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('cap_card_seen'))).toBe(false);
  });
});

describe('buying intent is said once a day, not once an hour', () => {
  const intentWorld = (priorIntents: unknown[]): World => ({
    events: [
      { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
      // The same page opened twice inside one window is still one message.
      { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
    ],
    priorIntents,
    profiles: [{ id: OWNER, email: 'founder@acme.example' }],
  });

  it('stays quiet when the same user did the same thing earlier today', async () => {
    const { telegram } = stubWorld(
      // Four hours before this window opened.
      intentWorld([
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: '2026-09-16T06:00:00.000Z' },
      ]),
    );

    await userFeed(env, NOW);

    expect(telegram).toHaveLength(0);
  });

  it('says it again once the day has passed', async () => {
    const { telegram } = stubWorld(
      // Thirty hours ago: outside the 24 hours the rule looks at.
      intentWorld([
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: '2026-09-15T04:00:00.000Z' },
      ]),
    );

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual(['acme.example looked at the upgrade page']);
  });

  it('does not let one signal silence the other', async () => {
    const { telegram } = stubWorld({
      events: [
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
        { event: 'free_tier.share_cap_hit', user_id: OWNER, timestamp: AT },
      ],
      priorIntents: [
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: '2026-09-16T06:00:00.000Z' },
      ],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual(['acme.example hit the free link limit']);
  });

  it('asks about a user once per event, however many rows are in the window', async () => {
    stubWorld(intentWorld([]));

    await userFeed(env, NOW);

    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('user_id=eq.'))).toHaveLength(1);
  });

  it('never asks about an internal account at all', async () => {
    const { telegram } = stubWorld({
      events: [{ event: 'upgrade.viewed', user_id: US, timestamp: AT }],
      profiles: [{ id: US, email: 'abhinandan@draconic.ai' }],
    });

    await userFeed(env, NOW);

    expect(telegram).toHaveLength(0);
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('user_id=eq.'))).toHaveLength(0);
  });
});

describe('a share is worth one read message, its first', () => {
  it('says nothing when somebody opened the share before this window', async () => {
    const world = busyWindow();
    world.priorSessions = [{ viewers: { email: 'partner@fund.example' } }];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.filter((t) => t.text.startsWith('First read:'))).toHaveLength(0);
    expect(telegram).toHaveLength(3);
  });

  it('still says it when the only earlier opens were the owner’s own', async () => {
    const world = busyWindow();
    // A user clicking their own link to check it is not a read, so it must not
    // consume the one message the recipient's open is supposed to produce.
    world.priorSessions = [
      { viewers: { email: 'founder@acme.example' } },
      { viewers: { email: 'founder@acme.example' } },
    ];
    const { telegram } = stubWorld(world);

    await userFeed(env, NOW);

    expect(telegram.map((t) => t.text)).toContain(
      "First read: acme.example's 'Series A deck' opened from DE/desktop",
    );
  });

  it('asks about a share once, however many sessions it has in the window', async () => {
    const world = busyWindow();
    const session = (world.sessions as unknown[])[0];
    world.sessions = [session, session, session];
    stubWorld(world);

    await userFeed(env, NOW);

    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('share_id=eq.'))).toHaveLength(1);
  });
});

describe('our own accounts and our own demo link are never news', () => {
  it('drops internal sign-ups, shares, reads and upgrade views', async () => {
    const internalShare = {
      slug: 'internal-test',
      owner_id: US,
      document_id: 'doc-us',
      documents: { title: 'Test upload' },
    };
    const { telegram, outbox, cursor } = stubWorld({
      signups: [
        { id: US, email: 'abhinandan@draconic.ai', created_at: AT },
        { id: US, email: 'hello@htmlradar.com', created_at: AT },
      ],
      signupEvents: [],
      shares: [{ id: 'share-us', ...internalShare, created_at: AT }],
      allShares: [{ owner_id: US }],
      sessions: [
        {
          started_at: AT,
          share_id: 'share-us',
          viewers: { email: 'stranger@example.com', country_code: 'US', device_type: 'mobile' },
          document_shares: internalShare,
        },
      ],
      events: [{ event: 'subscription.activated', user_id: US, timestamp: AT }],
      profiles: [{ id: US, email: 'abhinandan@draconic.ai' }],
    });

    await userFeed(env, NOW);

    expect(telegram).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    // Silent, but the window still closed.
    expect(cursor.at).toBe(new Date(NOW).toISOString());
  });

  it('drops the public demo share, whose readers are blog traffic', async () => {
    const demoShare = {
      slug: 'lumenforge-demo',
      owner_id: OWNER,
      document_id: 'doc-demo',
      documents: { title: 'Lumenforge' },
    };
    const { telegram } = stubWorld({
      shares: [{ id: 'share-demo', ...demoShare, created_at: AT }],
      allShares: [{ owner_id: OWNER }],
      sessions: [
        {
          started_at: AT,
          share_id: 'share-demo',
          viewers: { email: null, country_code: 'BR', device_type: 'mobile' },
          document_shares: demoShare,
        },
      ],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeed(env, NOW);

    expect(telegram).toHaveLength(0);
  });
});

describe('the cursor, not the worker, is what stops a repeat', () => {
  it('advances to now, and a second run over the same rows says nothing', async () => {
    const stub = stubWorld(busyWindow());

    await userFeed(env, NOW);
    expect(stub.telegram).toHaveLength(4);
    expect(stub.cursor.at).toBe(new Date(NOW).toISOString());

    // Same stub, same rows, five minutes later. The rows now sit before the
    // window's open edge, so nothing is said a second time.
    await userFeed(env, NEXT_RUN);
    expect(stub.telegram).toHaveLength(4);
    expect(stub.outbox).toHaveLength(4);
    expect(stub.cursor.at).toBe(new Date(NEXT_RUN).toISOString());
  });

  it('opens a five-minute window when there is no cursor row yet', async () => {
    const { telegram } = stubWorld({ ...busyWindow(), cursorMissing: true });

    // AT is three minutes before NOW, so it falls inside the fallback window.
    await userFeed(env, NOW);

    expect(telegram).toHaveLength(4);
  });
});

describe('a Supabase refusal costs nothing', () => {
  it('sends nothing and leaves the cursor alone', async () => {
    const world = busyWindow();
    world.shares = new Response('permission denied', { status: 500 });
    const { telegram, outbox, cursor } = stubWorld(world);

    // The caller logs this; scheduled() catches it so the health checks run on.
    await expect(userFeed(env, NOW)).rejects.toThrow('document_shares read HTTP 500');

    expect(telegram).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    // Unmoved, so the next run covers this window again rather than skipping it.
    expect(cursor.at).toBe(CURSOR_AT);
  });

  it('does nothing at all when there is no Telegram to say it to', async () => {
    const { telegram, cursor } = stubWorld(busyWindow());

    await userFeed({ ...env, TELEGRAM_BOT_TOKEN: undefined }, NOW);

    expect(telegram).toHaveLength(0);
    expect(cursor.at).toBe(CURSOR_AT);
  });
});

describe('a quiet window', () => {
  it('sends nothing, closes the window, and skips the lookups it cannot need', async () => {
    const { telegram, cursor } = stubWorld({});

    await userFeed(env, NOW);

    expect(telegram).toHaveLength(0);
    expect(cursor.at).toBe(new Date(NOW).toISOString());

    // Four window reads, the cursor read, the cursor write. No id=in.() lookup
    // and no attribution read when there is nothing to look up.
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('id=in.('))).toHaveLength(0);
    expect(urls.filter((u) => u.includes('user.signed_up'))).toHaveLength(0);
    expect(urls).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// The daily read line: everything the live feed spent the day not saying.

const OTHER = '44444444-4444-4444-8444-444444444444';

const othersShare = {
  slug: 'brave-heron',
  owner_id: OTHER,
  document_id: 'doc-2',
  documents: { title: 'Pricing' },
};

/** An outside open of `share`, stamped inside the daily window. */
const read = (shareId: string, share: unknown, email: string | null = null) => ({
  started_at: AT,
  share_id: shareId,
  viewers: { email, country_code: 'DE', device_type: 'desktop' },
  document_shares: share,
});

describe('the daily read line', () => {
  it('counts the reads, the senders, and the document that was read most', async () => {
    const { telegram, outbox } = stubWorld({
      sessions: [
        read('share-1', ownersShare),
        read('share-1', ownersShare),
        read('share-1', ownersShare),
        read('share-2', othersShare),
        // Not a read: the owner opening their own link.
        read('share-1', ownersShare, 'founder@acme.example'),
      ],
      profiles: [
        { id: OWNER, email: 'founder@acme.example' },
        { id: OTHER, email: 'ceo@northwind.example' },
      ],
    });

    await userFeedDaily(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      "Last 24h: 4 reads across 2 senders; most read 'Series A deck' (acme.example) with 3",
    ]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.kind).toBe('user_feed');
    expect(outbox[0]!.source).toBe('daily-reads');
  });

  it('says nothing on a day nobody read anything', async () => {
    const { telegram } = stubWorld({});

    await userFeedDaily(env, NOW);

    expect(telegram).toHaveLength(0);
    // The two window reads, and not even the owner lookup: nothing to look up.
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/profiles'))).toHaveLength(0);
    expect(urls).toHaveLength(2);
  });

  it('adds the day’s intent totals, and only when they are not zero', async () => {
    const { telegram, outbox } = stubWorld({
      sessions: [
        read('share-1', ownersShare),
        read('share-1', ownersShare),
        read('share-1', ownersShare),
        read('share-2', othersShare),
      ],
      events: [{ event: 'free_tier.share_cap_hit', user_id: OTHER, timestamp: AT }],
      profiles: [
        { id: OWNER, email: 'founder@acme.example' },
        { id: OTHER, email: 'ceo@northwind.example' },
      ],
    });

    await userFeedDaily(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      "Last 24h: 4 reads across 2 senders; most read 'Series A deck' (acme.example) with 3; " +
        '1 hit the free limit',
    ]);
    // No upgrade.viewed that day, so no clause about it — not a zero.
    expect(telegram[0]!.text).not.toContain('upgrade page');
    expect(outbox[0]!.meta!['free_tier.share_cap_hit']).toBe(1);
  });

  it('counts every intent row, not one per person, and speaks on a read-less day', async () => {
    const { telegram } = stubWorld({
      events: [
        // Three visits to the upgrade page by one user: one message that day,
        // but the total is what says he kept coming back.
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
        { event: 'upgrade.viewed', user_id: OWNER, timestamp: AT },
        // Ours, and the demo link's traffic has no account at all.
        { event: 'upgrade.viewed', user_id: US, timestamp: AT },
        { event: 'upgrade.viewed', user_id: null, timestamp: AT },
      ],
      profiles: [
        { id: OWNER, email: 'founder@acme.example' },
        { id: US, email: 'hello@htmlradar.com' },
      ],
    });

    await userFeedDaily(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual(['Last 24h: 3 looked at the upgrade page']);
  });

  it('counts neither our own accounts nor the demo link', async () => {
    const internalShare = {
      slug: 'internal-test',
      owner_id: US,
      document_id: 'doc-us',
      documents: { title: 'Test upload' },
    };
    const demoShare = {
      slug: 'lumenforge-demo',
      owner_id: OWNER,
      document_id: 'doc-demo',
      documents: { title: 'Lumenforge' },
    };
    const { telegram } = stubWorld({
      sessions: [
        read('share-us', internalShare),
        read('share-demo', demoShare),
        read('share-1', ownersShare),
      ],
      profiles: [
        { id: OWNER, email: 'founder@acme.example' },
        { id: US, email: 'abhinandan@draconic.ai' },
      ],
    });

    await userFeedDaily(env, NOW);

    expect(telegram.map((t) => t.text)).toEqual([
      "Last 24h: 1 read across 1 sender; most read 'Series A deck' (acme.example) with 1",
    ]);
  });

  it('stays silent when every read in the day was excluded', async () => {
    const { telegram } = stubWorld({
      sessions: [read('share-1', ownersShare, 'founder@acme.example')],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeedDaily(env, NOW);

    expect(telegram).toHaveLength(0);
  });

  it('does nothing at all when there is no Telegram to say it to', async () => {
    const { telegram } = stubWorld({
      sessions: [read('share-1', ownersShare)],
      profiles: [{ id: OWNER, email: 'founder@acme.example' }],
    });

    await userFeedDaily({ ...env, TELEGRAM_CHAT_ID: undefined }, NOW);

    expect(telegram).toHaveLength(0);
  });
});
