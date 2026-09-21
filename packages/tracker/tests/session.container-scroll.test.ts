// Decks that scroll inside a `.deck` container instead of the window.
//
// The pattern (our own sales decks are built this way):
//
//   .deck { height: 100vh; overflow-y: scroll; scroll-snap-type: y mandatory }
//   <div class="deck"><section class="slide">…</section>…</div>
//
// The window never scrolls, so depth measured against the document reported
// every such deck as fully read on load, which also counted as "evidence" for
// the first-read alert. Depth is measured against the container now.
//
// jsdom does no layout, so the fixture pins the geometry a browser would give it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, findScrollContainer } from '../src/session.js';
import { SectionTracker } from '../src/sections-v2.js';
import { DEFAULTS } from '../src/config.js';
import type { FlushPayload, TrackerConfig } from '../src/types.js';

const VIEWPORT = 800;
const SLIDES = ['Why Hivemarket', 'The product', 'Pricing', 'Next steps'];

function mountDeck(): HTMLElement {
  document.head.innerHTML = `<style>
    .deck { height: 100vh; overflow-y: scroll; scroll-snap-type: y mandatory }
    section.slide { height: 100vh; scroll-snap-align: start }
  </style>`;
  document.body.innerHTML = `<div class="deck">${SLIDES.map(
    (t, i) =>
      `<section class="slide"><div class="num">0${i + 1}</div><h2>${t}</h2><p>Body ${i}</p></section>`,
  ).join('')}</div>`;
  const deck = document.querySelector('.deck') as HTMLElement;
  // The window fits its content exactly; the deck holds four viewports.
  pin(document.documentElement, 'scrollHeight', VIEWPORT);
  pin(document.documentElement, 'clientHeight', VIEWPORT);
  pin(deck, 'clientHeight', VIEWPORT);
  pin(deck, 'scrollHeight', VIEWPORT * SLIDES.length);
  return deck;
}

function pin(el: Element, prop: string, value: number): void {
  Object.defineProperty(el, prop, { configurable: true, get: () => value });
}

let captured: FlushPayload | null = null;

function makeConfig(): TrackerConfig {
  return {
    ...DEFAULTS,
    endpoint: 'https://example.test',
    shareSlug: 'deck',
    hooks: {
      beforeFlush: (p: FlushPayload) => {
        captured = p;
        return false;
      },
    },
  };
}

async function depthAfterFlush(session: Session): Promise<number> {
  captured = null;
  // Anything to report: mark dirty so an unchanged depth still flushes.
  (session as unknown as { dirty: boolean }).dirty = true;
  await session.flush();
  return captured ? (captured as FlushPayload).maxScrollDepth : NaN;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  vi.stubGlobal('innerHeight', VIEWPORT);
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
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  captured = null;
});

describe('container-scrolled decks', () => {
  it('finds the .deck container as the scroller', () => {
    const deck = mountDeck();
    expect(findScrollContainer()).toBe(deck);
  });

  it('finds nothing on a genuinely single-screen document', () => {
    document.body.innerHTML = '<main><h1>One screen</h1></main>';
    expect(findScrollContainer()).toBeNull();
  });

  it('ignores a small scrolling widget (under half the viewport)', () => {
    document.body.innerHTML = '<pre style="overflow-y: auto">code</pre>';
    const pre = document.querySelector('pre')!;
    pin(pre, 'clientHeight', 120);
    pin(pre, 'scrollHeight', 2000);
    expect(findScrollContainer()).toBeNull();
  });

  it('reports depth from the container, not 100% on load', async () => {
    const deck = mountDeck();
    const session = new Session({ config: makeConfig(), email: null, fingerprint: 'fp' });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await started;

    // Loaded on slide 1: nothing read yet (was: 1.0).
    expect(await depthAfterFlush(session)).toBe(0);

    // Snap to slide 3 of 4: two of three scrollable viewports.
    deck.scrollTop = VIEWPORT * 2;
    deck.dispatchEvent(new Event('scroll'));
    expect(await depthAfterFlush(session)).toBeCloseTo(2 / 3, 5);

    // Last slide.
    deck.scrollTop = VIEWPORT * 3;
    deck.dispatchEvent(new Event('scroll'));
    expect(await depthAfterFlush(session)).toBe(1);

    // Scrolling back up never lowers the max.
    deck.scrollTop = 0;
    deck.dispatchEvent(new Event('scroll'));
    expect(await depthAfterFlush(session)).toBe(1);
    session.stop();
  });

  it('discovers one section per slide, titled by its heading', () => {
    mountDeck();
    const tracker = new SectionTracker({
      selector: 'h1, h2, h3',
      boundaryOffsetPx: 120,
      minDwellMs: 0,
      consumeActiveMs: () => 0,
    });
    tracker.start();
    const found = (tracker as unknown as { sections: Array<{ title: string }> }).sections;
    expect(found.map((s) => s.title)).toEqual(SLIDES);
    tracker.stop();
  });
});
