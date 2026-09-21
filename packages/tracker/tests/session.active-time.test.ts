// Active-time accrual: the cases that produced `active_time_seconds = 0`
// for readers who demonstrably read the document.
//
// Three reproduced causes:
//   1. The session was born idle. `lastActivityMs` is stamped in the field
//      initialiser, then `start()` waits out the 5s bot warm-up, so the
//      clock started already past its deadline and no time was ever
//      credited until the first qualifying event.
//   2. A mouse-only reader emits wheel / mousedown / mousemove. Session
//      listened for none of them, so section dwell accrued while active
//      time stayed 0.
//   3. Documents that scroll an inner element, not the window. Those
//      events do not bubble, so a bubble-phase window listener never saw
//      them; every presence listener is capture-phase now.
//
// Plus the guard that must survive the fix: a visible tab nobody touches
// still stops accruing once the reading allowance runs out.
//
// Every figure below includes the five warm-up seconds, which a session
// that survives the warm-up is credited back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { DEFAULTS } from '../src/config.js';
import type { FlushPayload, TrackerConfig } from '../src/types.js';
import { human } from './trusted-events.js';

const IDLE_MS = 30_000;
const WARM_UP_S = 5;

let captured: FlushPayload | null = null;

function makeConfig(): TrackerConfig {
  return {
    ...DEFAULTS,
    endpoint: 'https://example.test',
    shareSlug: 'test-slug',
    // beforeFlush returning false short-circuits the network call, and hands
    // us the exact payload the tracker would have sent.
    hooks: {
      beforeFlush: (p: FlushPayload) => {
        captured = p;
        return false;
      },
    },
  };
}

async function startSession(): Promise<Session> {
  const session = new Session({ config: makeConfig(), email: null, fingerprint: 'fp' });
  const started = session.start();
  // Wait out the 5s bot/accidental-tap warm-up.
  await vi.advanceTimersByTimeAsync(WARM_UP_S * 1000);
  await started;
  return session;
}

async function activeSecondsAfter(session: Session): Promise<number> {
  captured = null;
  await session.flush();
  return captured ? (captured as FlushPayload).activeSeconds : 0;
}

beforeEach(() => {
  // `performance` is not in Vitest's default toFake list, and the
  // accumulator is driven entirely by performance.now(). rAF is left real
  // on purpose: faking it makes a two-hour advance run two hours of
  // section-sampler frames.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  captured = null;
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

describe('active time', () => {
  it('credits the opening seconds of a visible session (was: born idle, credited nothing)', async () => {
    const session = await startSession();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 4);
    session.stop();
  });

  it('counts a reader who only uses the mouse wheel', async () => {
    const session = await startSession();
    // 20 seconds of reading, a wheel notch every 2s — well inside the idle
    // threshold, so every second should be credited.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      human('wheel');
    }
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 20);
    session.stop();
  });

  it('counts a reader who only clicks (mousedown)', async () => {
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      human('mousedown');
    }
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 10);
    session.stop();
  });

  it('counts a reader who only moves the mouse', async () => {
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      human('mousemove');
    }
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 10);
    session.stop();
  });

  it('throttles mousemove so a moving pointer costs at most one bump a second', async () => {
    const session = await startSession();
    const internals = session as unknown as { lastActivityMs: number };
    human('mousemove');
    const first = internals.lastActivityMs;
    await vi.advanceTimersByTimeAsync(100);
    human('mousemove');
    expect(internals.lastActivityMs).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    human('mousemove');
    expect(internals.lastActivityMs).toBeGreaterThan(first);
    session.stop();
  });

  it('sees input inside an inner element, whose event the window sees only in capture', async () => {
    document.body.innerHTML = '<div id="pane"></div>';
    const pane = document.getElementById('pane') as HTMLElement;
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      human('wheel', pane);
    }
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 10);
    session.stop();
  });

  it('still stops accruing on a visible tab nobody touches', async () => {
    const session = await startSession();
    // Two hours parked in a visible window. Only the warm-up and the one
    // reading allowance may be credited — never the two hours.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    const seconds = await activeSecondsAfter(session);
    expect(seconds).toBe(WARM_UP_S + IDLE_MS / 1000);
    session.stop();
    // Two simulated hours is 480 heartbeats; the default 5s budget is tight.
  }, 20_000);

  it('stops accruing IDLE_MS after the reader’s last action', async () => {
    const session = await startSession();
    await vi.advanceTimersByTimeAsync(1_000);
    human('wheel');
    // Walk away for ten minutes with the tab still in front.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // 1s before the wheel + the 30s allowance that follows it, on top of
    // the warm-up. Not ten minutes.
    expect(await activeSecondsAfter(session)).toBe(WARM_UP_S + 1 + IDLE_MS / 1000);
    session.stop();
  });
});
