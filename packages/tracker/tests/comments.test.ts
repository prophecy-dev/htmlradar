// The reader's comment boxes: when they exist at all, what they send, and the
// thing they must never do — change what the section tracker measures.
//
// jsdom lays nothing out, so every box here is mocked the same way
// sections-v2.ranges.test.ts does it: `place` fixes an element in document
// coordinates and the tracker reads it back through getBoundingClientRect.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountComments, type CommentDraft } from '../src/comments.js';
import { resolveConfig } from '../src/config.js';
import { SectionTracker, TRACKER_UI_ATTR } from '../src/sections-v2.js';

const VIEWPORT = 800;
const HEADING_HEIGHT = 40;
const BODY_HEIGHT = 700;
const TICK_MS = 250;

let clock = 0;
let scrollY = 0;
const frames: Array<(ts: number) => void> = [];

function place(el: Element, top: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      top: top - scrollY,
      bottom: top + height - scrollY,
      height,
      width: 1000,
      left: 0,
      right: 1000,
      x: 0,
      y: top - scrollY,
      toJSON: () => ({}),
    }) as DOMRect;
}

function advance(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    clock += TICK_MS;
    for (const frame of frames.splice(0)) frame(clock);
  }
}

let lastConsumed = 0;
function fullyActive(nowMs: number): number {
  const credited = nowMs - lastConsumed;
  lastConsumed = nowMs;
  return credited;
}

/** Two `<h2>` sections, each a heading plus one body paragraph. */
function twoSections(): void {
  document.body.innerHTML = `
    <h2 id="one">Section one</h2><p id="one-body">First.</p>
    <h2 id="two">Section two</h2><p id="two-body">Second.</p>`;
  let top = 0;
  for (const name of ['one', 'two']) {
    place(document.getElementById(name)!, top, HEADING_HEIGHT);
    top += HEADING_HEIGHT;
    place(document.getElementById(`${name}-body`)!, top, BODY_HEIGHT);
    top += BODY_HEIGHT;
  }
}

/** A fresh tracker over whatever is in the document, read for a while. */
function readSections(): Record<string, number> {
  lastConsumed = clock;
  const t = new SectionTracker({
    selector: 'h1, h2, h3',
    boundaryOffsetPx: 100,
    minDwellMs: 500,
    consumeActiveMs: fullyActive,
  });
  t.start();
  advance(4000);
  scrollY = HEADING_HEIGHT + BODY_HEIGHT;
  advance(4000);
  t.stop();
  const out: Record<string, number> = {};
  for (const s of t.snapshot()) out[s.id] = s.timeSeconds;
  return out;
}

const anchors = () =>
  Array.from(document.querySelectorAll<HTMLElement>('h2')).map((element) => ({
    id: element.id,
    title: element.textContent ?? '',
    element,
  }));

/** Every host the comment UI put in the document, given a real height. */
function placeInjected(height: number): HTMLElement[] {
  const hosts = Array.from(document.querySelectorAll<HTMLElement>(`[${TRACKER_UI_ATTR}]`));
  for (const host of hosts) place(host, 0, height);
  return hosts;
}

// The roots the UI creates are CLOSED, so neither the deck nor this test can
// reach the reader's draft through the host. Watching them being made is the
// one way in, and it is a way only a test has.
const roots = new Map<Element, ShadowRoot>();

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clock = 1000;
  lastConsumed = 1000;
  scrollY = 0;
  frames.length = 0;
  roots.clear();
  document.body.innerHTML = '';
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = attachShadow.call(this, init);
    roots.set(this, root);
    return root;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { height: VIEWPORT, offsetTop: 0 },
  });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
});

describe('when there is a box at all', () => {
  it('is off in the resolved config unless something turns it on', () => {
    const el = document.createElement('script');
    el.setAttribute('data-endpoint', 'https://docs.example');
    el.setAttribute('data-share-slug', 'acme');
    expect(resolveConfig(el)?.comments.enabled).toBe(false);

    // What the proxy injects on a verified link read by a verified reader.
    window.HTMLRadarConfig = { comments: { enabled: true } };
    expect(resolveConfig(el)?.comments.enabled).toBe(true);
    delete window.HTMLRadarConfig;
  });

  it('puts one affordance under each heading and one box at the end', () => {
    twoSections();
    mountComments({ anchors: anchors(), send: async () => null });
    const hosts = Array.from(document.querySelectorAll(`[${TRACKER_UI_ATTR}]`));
    expect(hosts).toHaveLength(3);
    // Each section's affordance sits with its heading; the last is the
    // document-wide box at the end of the deck.
    expect(hosts[0]!.previousElementSibling?.id).toBe('one');
    expect(hosts[1]!.previousElementSibling?.id).toBe('two');
    expect(hosts[2]!.parentElement).toBe(document.body);
  });
});

describe('sending one', () => {
  const rootOf = (host: Element): ShadowRoot => roots.get(host)!;

  it('carries the section it was left on, and then goes quiet', async () => {
    twoSections();
    const sent: CommentDraft[] = [];
    mountComments({
      anchors: anchors(),
      send: async (draft) => {
        sent.push(draft);
        return null;
      },
    });
    const host = document.querySelectorAll(`[${TRACKER_UI_ATTR}]`)[1]!;
    const root = rootOf(host);
    root.querySelector<HTMLButtonElement>('.open')!.click();
    const form = root.querySelector<HTMLFormElement>('form')!;
    expect(form.hidden).toBe(false);
    root.querySelector<HTMLTextAreaElement>('textarea')!.value = '  Can we see the contract?  ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    expect(sent).toEqual([
      { sectionId: 'two', sectionTitle: 'Section two', body: 'Can we see the contract?' },
    ]);
    // Nothing is echoed back — not their own comment, not anyone else's.
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('.done')?.textContent).toBe('Sent to the sender.');
    expect(document.body.textContent).not.toContain('Can we see the contract?');
  });

  it('keeps the note and shows the refusal when the worker says no', async () => {
    twoSections();
    mountComments({ anchors: anchors(), send: async () => 'Only verified readers can comment.' });
    const root = rootOf(document.querySelectorAll(`[${TRACKER_UI_ATTR}]`)[0]!);
    root.querySelector<HTMLButtonElement>('.open')!.click();
    const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Hello?';
    root
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    expect(root.querySelector('.err')?.textContent).toBe('Only verified readers can comment.');
    expect(input.value).toBe('Hello?');
    expect(root.querySelector<HTMLButtonElement>('.send')!.disabled).toBe(false);
  });

  it('refuses to send an empty note without troubling the worker', async () => {
    twoSections();
    const send = vi.fn(async () => null);
    mountComments({ anchors: anchors(), send });
    const root = rootOf(document.querySelectorAll(`[${TRACKER_UI_ATTR}]`)[0]!);
    root.querySelector<HTMLButtonElement>('.open')!.click();
    root
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(root.querySelector('.err')?.textContent).toBe('Write something first.');
  });
});

// The defect this exists to prevent: a box inserted between a heading and its
// body becomes the next element in that heading's range, and the box at the
// end of the deck becomes the last section's. Both would add their own height
// to a section's geometry — and grow it again the moment a reader opened one.
describe('what the section tracker measures', () => {
  it('is the same with the comment UI standing in the document', () => {
    twoSections();
    const clean = readSections();

    mountComments({ anchors: anchors(), send: async () => null });
    // Tall enough that a range taking one in could not possibly agree.
    expect(placeInjected(600)).toHaveLength(3);
    scrollY = 0;

    expect(readSections()).toEqual(clean);
  });

  it('never calls a comment box a section of its own', () => {
    // A deck with no headings, where discovery falls through to the slide
    // strategy and every `div.slide` becomes a section. The marker decides,
    // not what the element looks like — so the box is given the deck's own
    // slide class, which is the one thing that could make it look like one.
    document.body.innerHTML =
      '<div class="slide" id="s1">One.</div><div class="slide" id="s2">Two.</div>';
    mountComments({ anchors: [], send: async () => null });
    const box = placeInjected(600)[0]!;
    box.className = 'slide';
    place(document.getElementById('s1')!, 0, BODY_HEIGHT);
    place(document.getElementById('s2')!, BODY_HEIGHT, BODY_HEIGHT);

    lastConsumed = clock;
    const t = new SectionTracker({
      selector: 'h1, h2, h3',
      boundaryOffsetPx: 100,
      minDwellMs: 500,
      consumeActiveMs: fullyActive,
    });
    t.start();
    advance(4000);
    expect(t.anchors().map((a) => a.element.id)).toEqual(['s1', 's2']);
  });
});
