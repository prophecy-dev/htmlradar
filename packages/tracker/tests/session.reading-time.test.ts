// The reading-time rules, one test per item on the failure list in
// docs/workstreams/product-and-engineering/READING-TIME-DESIGN-2026-09-21.md.
//
// The rule being defended: reading time is the time the document was
// visible and the reader showed a sign of presence within the last thirty
// seconds. Nothing else counts — not a playing video, not a carousel that
// advances itself, not a script that scrolls the page.
//
// Sessions here are pre-started (as the email gate starts them) unless the
// warm-up itself is the subject, so the figures are the clock alone with no
// warm-up seconds folded in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { DEFAULTS } from '../src/config.js';
import type { FlushPayload, TrackerConfig } from '../src/types.js';
import { human, script } from './trusted-events.js';

const ALLOWANCE_MS = 30_000;
const WARM_UP_MS = 5_000;

let captured: FlushPayload | null = null;
let flushCount = 0;

function makeConfig(over: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    ...DEFAULTS,
    supabaseUrl: 'https://example.test',
    supabaseAnonKey: 'anon',
    shareSlug: 'test-slug',
    hooks: {
      beforeFlush: (p: FlushPayload) => {
        captured = p;
        flushCount += 1;
        return false;
      },
    },
    ...over,
  };
}

// A session the gate already started: no warm-up wait, no warm-up credit.
function preStartedSession(config: TrackerConfig = makeConfig()): Session {
  return new Session({
    config,
    email: 'reader@example.test',
    fingerprint: 'fp',
    preStarted: { sessionId: 'sid', token: 'tok', documentId: 'did', documentVersion: 1 },
  });
}

async function activeSeconds(session: Session): Promise<number> {
  captured = null;
  await session.flush();
  return captured ? (captured as FlushPayload).activeSeconds : 0;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  captured = null;
  flushCount = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        session_id: 'sid',
        token: 'tok',
        document_id: 'did',
        document_version: 1,
      }),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('A — input after the allowance expired credits nothing for the silent gap', () => {
  it('credits up to the old deadline before moving it', async () => {
    const session = preStartedSession();
    await session.start();

    // Forty silent seconds: the allowance ran out at thirty. Then the
    // reader touches the page, and reads for ten more.
    await vi.advanceTimersByTimeAsync(40_000);
    human('wheel');
    await vi.advanceTimersByTimeAsync(10_000);

    // 30 (the allowance) + 10 (real reading). NOT 50: the ten silent
    // seconds between the deadline and the wheel are not reading.
    expect(await activeSeconds(session)).toBe(40);
    session.stop();
  });
});

describe('B — the thirty-second allowance', () => {
  it('credits thirty silent seconds in front of a visible tab', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(ALLOWANCE_MS);
    expect(await activeSeconds(session)).toBe(30);
    session.stop();
  });

  it('credits thirty and then stops, over five silent minutes', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await activeSeconds(session)).toBe(30);
    session.stop();
  });
});

describe('C — hidden, frozen, printing', () => {
  it('credits nothing while the tab is hidden, and resumes on return', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await activeSeconds(session)).toBe(10);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await activeSeconds(session)).toBe(20);
    session.stop();
  });

  it('credits nothing while the page is frozen', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event('freeze'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await activeSeconds(session)).toBe(10);
    document.dispatchEvent(new Event('resume'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await activeSeconds(session)).toBe(15);
    session.stop();
  });

  it('credits nothing while a print dialog is open', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event('beforeprint'));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await activeSeconds(session)).toBe(10);
    window.dispatchEvent(new Event('afterprint'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await activeSeconds(session)).toBe(15);
    session.stop();
  });

  it('does not resume a frozen page that comes back hidden', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event('freeze'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('resume'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await activeSeconds(session)).toBe(10);
    session.stop();
  });
});

describe('D — restored from the back-forward cache', () => {
  it('keeps one session and credits nothing for the time away', async () => {
    const session = preStartedSession();
    const info = await session.start();
    const startCalls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    const restore = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(restore, 'persisted', { value: true });
    window.dispatchEvent(restore);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await activeSeconds(session)).toBe(20);
    // Same session row: nothing here calls start_session a second time.
    const internals = session as unknown as { info: { sessionId: string } | null };
    expect(internals.info?.sessionId).toBe(info?.sessionId);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      startCalls,
    );
    session.stop();
  });
});

describe('E — only a person renews the allowance', () => {
  it('ignores events a script dispatched', async () => {
    const session = preStartedSession();
    await session.start();
    // An autoplaying video, an auto-advancing carousel and a scripted
    // scroll, every second, for five minutes.
    for (let i = 0; i < 300; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      script('timeupdate');
      script('wheel');
      script('mousemove');
      script('keydown');
      script('scroll');
    }
    expect(await activeSeconds(session)).toBe(30);
    session.stop();
  });

  it('ignores a scroll even when the browser marks it trusted', async () => {
    // A script's `scrollTo` produces a scroll event the browser marks
    // trusted, exactly like a human's. Scroll is a position signal only.
    const session = preStartedSession();
    await session.start();
    for (let i = 0; i < 300; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      human('scroll');
    }
    expect(await activeSeconds(session)).toBe(30);
    session.stop();
  });

  it('still counts the human input that real scrolling comes with', async () => {
    const session = preStartedSession();
    await session.start();
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      human(i % 2 === 0 ? 'wheel' : 'touchstart');
    }
    expect(await activeSeconds(session)).toBe(60);
    session.stop();
  });
});

describe('F — a timer callback that fires late', () => {
  it('credits at most up to the deadline', async () => {
    const session = preStartedSession();
    await session.start();
    human('wheel');
    // The tab is throttled: the next update lands sixty seconds late.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await activeSeconds(session)).toBe(30);
    session.stop();
  });
});

describe('H — the warm-up seconds', () => {
  it('credits them once, to a session that was visible throughout', async () => {
    const session = new Session({ config: makeConfig(), email: null, fingerprint: 'fp' });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(WARM_UP_MS);
    await started;
    expect(await activeSeconds(session)).toBe(5);
    // Once, not on every flush.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await activeSeconds(session)).toBe(15);
    session.stop();
  });

  it('withholds them when the tab was hidden during the warm-up', async () => {
    const session = new Session({ config: makeConfig(), email: null, fingerprint: 'fp' });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(2_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(1_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await started;
    expect(await activeSeconds(session)).toBe(0);
    session.stop();
  });

  it('records nothing at all for a visit that never survives the warm-up', async () => {
    const session = new Session({ config: makeConfig(), email: null, fingerprint: 'fp' });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(2_000);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await started).toBeNull();
    // No session row, so no report of any kind.
    expect(flushCount).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('G — sections spend the session clock and nothing else', () => {
  it('hands out only what has been credited, once each', async () => {
    const session = preStartedSession();
    await session.start();
    const consume = (
      session as unknown as { consumeActiveMs(n: number): number }
    ).consumeActiveMs.bind(session);

    await vi.advanceTimersByTimeAsync(10_000);
    const first = consume(performance.now());
    const second = consume(performance.now());
    await vi.advanceTimersByTimeAsync(5 * 60_000); // the reader walks away
    const third = consume(performance.now());

    expect(first).toBe(10_000);
    expect(second).toBe(0); // nothing is credited twice
    expect(third).toBe(ALLOWANCE_MS - 10_000); // and never past the allowance
    expect(first + second + third).toBe(await activeSeconds(session).then((s) => s * 1000));
    session.stop();
  });
});

describe('I — the final report', () => {
  it('is sent with keepalive when the page hides', async () => {
    const session = preStartedSession(makeConfig({ hooks: {} }));
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(0);

    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } })
      .mock.calls;
    const last = calls[calls.length - 1]!;
    expect(last[0]).toContain('update_session');
    expect(last[1].keepalive).toBe(true);
    session.stop();
  });

  it('carries the cumulative figures even when an earlier save is still open', async () => {
    // A slow save in flight when the page hides. The old code dropped the
    // second call, which is exactly the one that matters.
    let releaseFirst: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: Array<Record<string, unknown>> = [];
    let update = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('update_session')) {
          sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          update += 1;
          if (update === 1) await slow;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session_id: 'sid',
            token: 'tok',
            document_id: 'did',
            document_version: 1,
          }),
        };
      }),
    );

    const session = preStartedSession(makeConfig({ hooks: {} }));
    await session.start();

    await vi.advanceTimersByTimeAsync(10_000);
    const firstSave = session.flush(); // the slow one, now stuck inside fetch
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(true); // the final report, while the slow one is still open

    releaseFirst!();
    // The queued report runs as the first one finishes, so awaiting the
    // first also waits for the last.
    await firstSave;

    // The queued report ran rather than being dropped, and it is re-read
    // from the live counters, so it carries the full twenty seconds and
    // not the ten the first one saw.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[sent.length - 1]!['p_active_seconds']).toBe(20);
    session.stop();
  });
});

describe('J — a tab still running the old tracker keeps reporting', () => {
  it('sends the same fields, with no additions', async () => {
    const session = preStartedSession();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await session.flush();
    expect(Object.keys(captured ?? {}).sort()).toEqual([
      'activeSeconds',
      'maxScrollDepth',
      'sections',
      'sessionId',
      'token',
    ]);
    session.stop();
  });
});
