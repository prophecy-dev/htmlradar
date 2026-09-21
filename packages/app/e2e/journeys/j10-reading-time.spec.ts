// Journey 10 — the reading clock itself.
//
// Since 21 September 2026 reading time is measured with a flat thirty-second
// silent-reading allowance: the clock credits a few warm-up seconds, keeps
// running for up to thirty seconds after the last trusted human input, counts
// only while the tab is visible, and is the same clock the sections are
// measured on. Every one of those five claims is a number somebody can check,
// so this journey checks them in a real browser against the database.
//
// Four readers, each a case the old clock got wrong:
//
//   silent     reads without touching anything for forty seconds. The old
//              clock stopped at the first idle timeout and reported almost
//              nothing; the new one should report about thirty-five — five
//              of warm-up and thirty of allowance — and then stop.
//   nudge      the same forty seconds, but with one key press at about
//              twenty-three. That press renews the allowance, so the whole
//              forty seconds is covered and the figure should be about forty.
//              The five-second gap between this reader and the silent one IS
//              the allowance working.
//   away       reads for ten seconds and then leaves the tab in front,
//              untouched, for three minutes. The allowance caps it: about
//              forty-five at the very most, not three minutes.
//   hidden     switches to another tab for a minute. Nothing may accrue.
//
// This file makes its share through the public API rather than the sharing
// form. Its subject is the clock, not the form; J1 owns the form, and a
// second copy of that recipe here is a second thing to keep in step.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  API_KEY,
  BASE,
  FIXTURES,
  JOURNEY_EMAIL,
  cleanupDocuments,
  durationToSeconds,
  flush,
  journeyTitle,
  passEmailGate,
  readerEmail,
  record,
  rest,
  signIn,
  statValue,
} from './lib';

test.describe.configure({ mode: 'serial' });

const title = journeyTitle('j10');

/** What the clock should credit before anyone has done anything. */
const WARM_UP = 5;
/** How long the clock keeps running after the last trusted human input. */
const ALLOWANCE = 30;

let shareId = '';
let shareSlug = '';
let shareUrl = '';

test.beforeAll(async () => {
  test.skip(!JOURNEY_EMAIL || !API_KEY, 'journey account or API key not set');

  const res = await fetch(`${BASE}/api/v1/shares`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      require_email: true,
      recipient_label: 'golden j10 reading time',
      html: readFileSync(path.join(FIXTURES, 'golden-deck.html'), 'utf8'),
      // Pinned to htmlradar.page. The subject of this journey is the clock,
      // and the clock lives in the tracker bundle the serving host hands
      // out. On 21 September 2026 the journey account's own domain was
      // serving a cached pre-fix bundle, so measuring there measured a
      // stale deploy rather than the product: the same silent reader
      // recorded 35 seconds on the apex and 0 on the custom domain.
      //
      // That staleness is worth catching, and it IS caught — by J4b, which
      // compares the bundle each host serves. Keeping the two apart means a
      // failure here says "the clock changed" and a failure there says "a
      // host is behind", instead of both saying something ambiguous.
      domain_id: null,
    }),
  });
  expect(res.ok, `creating the reading-time link answered ${res.status}`).toBe(true);
  const share = (await res.json()) as { share_id: string; url: string };
  shareId = share.share_id;
  shareUrl = share.url;
  shareSlug = new URL(share.url).pathname.split('/').pop()!;
});

test.afterAll(async () => {
  await cleanupDocuments([title]);
});

/** The recorded reading time for one reader, by the address they gave. */
async function secondsFor(email: string): Promise<number> {
  const viewer = (
    await rest<{ id: string }>(
      `/viewers?share_id=eq.${shareId}&email=eq.${encodeURIComponent(email.toLowerCase())}&select=id`,
    )
  )[0];
  expect(viewer, `no viewer row for ${email} — the tracker never flushed`).toBeTruthy();
  const sessions = await rest<{ id: string; active_time_seconds: number }>(
    `/sessions?viewer_id=eq.${viewer!.id}&select=id,active_time_seconds&order=started_at.desc&limit=1`,
  );
  expect(sessions.length, `no session row for ${email}`).toBe(1);
  return sessions[0]!.active_time_seconds ?? 0;
}

test('J10a a silent reader is credited the allowance and no more', async ({ browser }) => {
  const email = readerEmail('silent');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    await passEmailGate(page, email);
    // Nothing at all after the gate: no scroll, no key, no pointer. This is
    // the reader the old clock called idle.
    await page.waitForTimeout(40_000);
    await flush(page);

    const seconds = await secondsFor(email);
    // Warm-up plus the allowance, and then the clock stops. The upper bound
    // is the real assertion: forty seconds of tab time must NOT all be
    // credited when nobody touched anything.
    expect(
      seconds,
      `a silent reader recorded ${seconds}s; the allowance says about ${WARM_UP + ALLOWANCE}s`,
    ).toBeGreaterThanOrEqual(WARM_UP + ALLOWANCE - 5);
    expect(
      seconds,
      `a silent reader recorded ${seconds}s — the clock did not stop when the allowance ran out`,
    ).toBeLessThanOrEqual(WARM_UP + ALLOWANCE + 7);
    record('j10a', { db: { silent_seconds: seconds }, screen: {} });
  } finally {
    await context.close();
  }
});

test('J10b one key press renews the allowance', async ({ browser }) => {
  const email = readerEmail('nudge');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    await passEmailGate(page, email);
    await page.waitForTimeout(23_000);
    // One press, which is trusted human input and renews the allowance.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(17_000);
    await flush(page);

    const seconds = await secondsFor(email);
    // The same forty seconds as the silent reader, now covered end to end.
    expect(
      seconds,
      `a reader who pressed a key recorded ${seconds}s; forty seconds were covered`,
    ).toBeGreaterThanOrEqual(35);
    expect(seconds, 'the clock credited more than the tab was even open').toBeLessThanOrEqual(50);
    record('j10b', { db: { nudged_seconds: seconds }, screen: {} });
  } finally {
    await context.close();
  }
});

test('J10c a reader who walks away is capped by the allowance', async ({ browser }) => {
  const email = readerEmail('away');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    await passEmailGate(page, email);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(10_000);
    await page.mouse.wheel(0, 200);
    // Three minutes with the tab in front and nobody there. This is the
    // case that produced the thirty-three-minute reads in the old reports.
    await page.waitForTimeout(3 * 60_000);
    await flush(page);

    const seconds = await secondsFor(email);
    expect(seconds, 'a ten-second read recorded as nothing').toBeGreaterThanOrEqual(10);
    expect(
      seconds,
      `three minutes at an untouched tab recorded ${seconds}s — the allowance is not capping it`,
    ).toBeLessThanOrEqual(50);
    record('j10c', { db: { walked_away_seconds: seconds }, screen: {} });
  } finally {
    await context.close();
  }
});

test('J10d a hidden tab accrues nothing, and sections never exceed the session', async ({
  browser,
}) => {
  const email = readerEmail('hidden');
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    await passEmailGate(page, email);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(8_000);
    await flush(page);
    const before = await secondsFor(email);

    // Hidden the only way a headless browser can be.
    //
    // `page.bringToFront()` on a second tab does NOT hide the first one in
    // headless Chromium — measured on 21 September 2026, `visibilityState`
    // stayed "visible" and `visibilitychange` never fired, so the version of
    // this test that used it was asserting nothing and failed on the clock
    // simply running its allowance.
    //
    // So the page is told it is hidden, in the two ways the tracker asks:
    // `document.hidden` and `document.visibilityState`, followed by the
    // event it listens for (packages/tracker/src/session.ts). That is
    // precisely what a real hide looks like to the code under test.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(60_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush(page);
    const after = await secondsFor(email);

    expect(
      after - before,
      `a minute in a hidden tab added ${after - before}s of "reading"`,
    ).toBeLessThanOrEqual(8);

    // One clock: a section cannot have been read for longer than the session
    // it happened in. This is checked across every reader in this journey,
    // because it is the invariant that made the old reports contradict
    // themselves on the same screen.
    const sessions = await rest<{ id: string; active_time_seconds: number }>(
      `/sessions?share_id=eq.${shareId}&select=id,active_time_seconds`,
    );
    for (const session of sessions) {
      const events = await rest<{ time_seconds: number }>(
        `/section_events?session_id=eq.${session.id}&select=time_seconds`,
      );
      const total = events.reduce((sum, e) => sum + (e.time_seconds ?? 0), 0);
      expect(
        total,
        `sections total ${total}s inside a ${session.active_time_seconds}s session`,
      ).toBeLessThanOrEqual((session.active_time_seconds ?? 0) + 2);
    }

    record('j10d', {
      db: {
        hidden_tab_added_seconds_at_most: 8,
        sections_never_exceed_session: true,
      },
      screen: {},
    });
  } finally {
    await context.close();
  }
});

test('J10e the report prints the same clock it recorded', async ({ browser }) => {
  const owner = await browser.newContext();
  try {
    const page = await signIn(owner);
    await page.goto(`${BASE}/dashboard/${shareSlug}`);
    const shown = durationToSeconds(await statValue(page, 'Avg reading time'));

    const sessions = await rest<{ active_time_seconds: number }>(
      `/sessions?share_id=eq.${shareId}&select=active_time_seconds`,
    );
    const average =
      sessions.reduce((sum, s) => sum + (s.active_time_seconds ?? 0), 0) / sessions.length;
    expect(
      Math.abs(shown - average),
      `the report prints ${shown}s where the database averages ${Math.round(average)}s`,
    ).toBeLessThanOrEqual(2);

    // The number is labelled as an estimate on the screen, not only in a
    // tooltip. This is the honesty half of the reading-time work.
    await expect(
      page.getByText('Estimated reading time', { exact: false }).first(),
      'the report no longer says the number is an estimate',
    ).toBeVisible();

    record('j10e', { db: {}, screen: { avg_reading_time: shown, labelled_estimate: true } });
  } finally {
    await owner.close();
  }
});
