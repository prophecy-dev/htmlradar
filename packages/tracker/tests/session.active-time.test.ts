// Active-time accrual: the cases that produced `active_time_seconds = 0`
// for readers who demonstrably read the document.
//
// Three reproduced causes:
//   1. The session was born idle. `lastActivityMs` is stamped in the field
//      initialiser, then `start()` waits out the 5s bot warm-up — exactly
//      the idle threshold — so the clock started already past its deadline
//      and no time was ever credited until the first qualifying event.
//   2. A mouse-only reader emits wheel / mousedown / mousemove. Session
//      listened for none of them (sections-v2 listens for wheel and
//      mousedown), so section dwell accrued while active time stayed 0.
//   3. Documents that scroll an inner element, not the window. A scroll
//      event on an element does not bubble, so a bubble-phase window
//      listener never sees it.
//
// Plus the guard that must survive the fix: a visible tab nobody touches
// still stops accruing after the idle threshold.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { DEFAULTS } from '../src/config.js';
import type { FlushPayload, TrackerConfig } from '../src/types.js';

const IDLE_MS = 5_000;

let captured: FlushPayload | null = null;

function makeConfig(): TrackerConfig {
  return {
    ...DEFAULTS,
    supabaseUrl: 'https://example.test',
    supabaseAnonKey: 'anon',
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
  await vi.advanceTimersByTimeAsync(IDLE_MS);
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
    expect(await activeSecondsAfter(session)).toBe(4);
    session.stop();
  });

  it('counts a reader who only uses the mouse wheel', async () => {
    const session = await startSession();
    // 20 seconds of reading, a wheel notch every 2s — well inside the idle
    // threshold, so every second should be credited.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new Event('wheel'));
    }
    expect(await activeSecondsAfter(session)).toBe(20);
    session.stop();
  });

  it('counts a reader who only clicks (mousedown)', async () => {
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new Event('mousedown'));
    }
    expect(await activeSecondsAfter(session)).toBe(10);
    session.stop();
  });

  it('counts a reader who only moves the mouse', async () => {
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new Event('mousemove'));
    }
    expect(await activeSecondsAfter(session)).toBe(10);
    session.stop();
  });

  it('throttles mousemove so a moving pointer costs at most one bump a second', async () => {
    const session = await startSession();
    const internals = session as unknown as { lastActivityMs: number };
    window.dispatchEvent(new Event('mousemove'));
    const first = internals.lastActivityMs;
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('mousemove'));
    expect(internals.lastActivityMs).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    window.dispatchEvent(new Event('mousemove'));
    expect(internals.lastActivityMs).toBeGreaterThan(first);
    session.stop();
  });

  it('sees scrolling inside an inner element, whose scroll event does not bubble', async () => {
    document.body.innerHTML = '<div id="pane"></div>';
    const pane = document.getElementById('pane') as HTMLElement;
    const session = await startSession();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      pane.dispatchEvent(new Event('scroll')); // bubbles: false, as in a real browser
    }
    expect(await activeSecondsAfter(session)).toBe(10);
    session.stop();
  });

  it('still stops accruing on a visible tab nobody touches', async () => {
    const session = await startSession();
    // Two hours parked in a visible window. Only the opening grace window
    // may be credited — never the two hours.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    const seconds = await activeSecondsAfter(session);
    expect(seconds).toBeLessThanOrEqual(IDLE_MS / 1000);
    session.stop();
  });

  it('stops accruing IDLE_MS after the reader’s last action', async () => {
    const session = await startSession();
    await vi.advanceTimersByTimeAsync(1_000);
    window.dispatchEvent(new Event('wheel'));
    // Walk away for ten minutes with the tab still in front.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // 1s before the wheel + the 5s grace that follows it. Not ten minutes.
    expect(await activeSecondsAfter(session)).toBe(6);
    session.stop();
  });
});
