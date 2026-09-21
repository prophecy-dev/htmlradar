// Journeys 1 to 4 — the whole reason the product exists, in one story.
//
// A sender signs in by e-mail link, uploads a deck, makes a gated tracked
// link and copies it (J1). A recipient, in a browser that has never seen
// this site, opens that link, gives an e-mail and reads (J2). The sender's
// report, the database and the notification log then have to agree about
// what happened (J3). And the recipient comes back (J4).
//
// These four are one file and run in order on purpose: they are four steps
// of one person's afternoon, not four independent checks, and splitting them
// would mean four uploads and four links to prove one thing.
//
// Every number this file cares about is also written to the parity record,
// so a later milestone can be asked the only question that matters: did the
// same afternoon produce the same records?

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import {
  BASE,
  FIXTURES,
  JOURNEY_EMAIL,
  cleanupDocuments,
  durationToSeconds,
  eventNamesSince,
  flush,
  journeyTitle,
  passEmailGate,
  readSections,
  readerEmail,
  record,
  rest,
  signIn,
  statValue,
} from './lib';

test.describe.configure({ mode: 'serial' });

// Three sections at four seconds each. Four, because the tracker drops any
// section held for under three (packages/tracker/src/config.ts).
const DWELL_MS = 4000;
const SECTIONS = 3;
const EXPECTED_DWELL_SECONDS = (SECTIONS * DWELL_MS) / 1000;

const title = journeyTitle('j1');
const reader = readerEmail('read');
const skimmer = readerEmail('skim');

let owner: BrowserContext;
let ownerPage: Page;
let documentId = '';
let shareSlug = '';
let shareId = '';
let shareAddress = '';
let startedAt = '';

// A second, ungated link, for the anonymous half of journey 4.
let openSlug = '';
let openAddress = '';

test.beforeAll(async ({ browser }) => {
  test.skip(!JOURNEY_EMAIL, 'GOLDEN_JOURNEY_EMAIL (or JOURNEY_EMAIL) is not set');
  // Everything this run emits is timestamped after this moment, which is how
  // the app_events assertion tells this run's events from yesterday's.
  startedAt = new Date(Date.now() - 5_000).toISOString();
  owner = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  ownerPage = await signIn(owner);
});

test.afterAll(async () => {
  // Always, even when a journey failed halfway: a failed run must not leave a
  // document on the account for the next run to trip over.
  await cleanupDocuments([title]);
  await owner?.close();
});

// ────────────────────────────────────────────────────────────────────
// J1 — the sender
// ────────────────────────────────────────────────────────────────────

test('J1 sender: sign in by e-mail link, upload, gate, copy, land on the share', async () => {
  // signIn() already asserted the two halves of the door: the link lands on
  // the confirm page, and only the button finishes the job.
  await expect(ownerPage, 'the button should land the sender on their documents').toHaveURL(
    /\/docs(\?|$)/,
  );

  await ownerPage.goto(`${BASE}/new`);
  await ownerPage.locator('input#title').fill(title);
  await ownerPage.locator('input#file').setInputFiles(path.join(FIXTURES, 'golden-deck.html'));
  await ownerPage.getByRole('button', { name: /create document/i }).click();
  await ownerPage.waitForURL(/\/docs\/[0-9a-f-]{36}/, { timeout: 60_000 });
  documentId = ownerPage.url().match(/\/docs\/([0-9a-f-]{36})/)?.[1] ?? '';
  expect(documentId, 'the upload did not produce a document').toBeTruthy();

  // The link, with the e-mail gate on. The gate is the form's default; the
  // assertion is there so a milestone that flips the default is caught here
  // rather than by a customer whose deck went out ungated.
  await ownerPage.getByRole('button', { name: /create a new share link/i }).click();
  await ownerPage.locator('input[name="recipient_label"]').fill('Golden journey recipient');
  await expect(
    ownerPage.locator('input[name="require_email"]'),
    'the e-mail gate must still be on by default',
  ).toBeChecked();
  await ownerPage.getByRole('button', { name: /^create link$/i }).click();

  // Landing on the share's own page is the last step of creating one.
  await ownerPage.waitForURL(/\/dashboard\/[^/?]+\?just_created=1/, { timeout: 60_000 });
  shareSlug = ownerPage.url().match(/\/dashboard\/([^/?]+)/)?.[1] ?? '';
  expect(shareSlug, 'no slug on the share page').toBeTruthy();

  const shares = await rest<{ id: string; require_email: boolean }>(
    `/document_shares?slug=eq.${shareSlug}&select=id,require_email`,
  );
  shareId = shares[0]?.id ?? '';
  expect(shareId, 'no share row for the slug the browser landed on').toBeTruthy();
  expect(shares[0]?.require_email, 'the gate the form showed was not stored').toBe(true);

  // Copy. The clipboard is the assertion — a "Copied" badge over an empty
  // clipboard is the failure this catches.
  // `.first()`: the page offers the same copy twice — once next to the
  // address and once inside the "waiting for a first read" panel.
  await ownerPage
    .getByRole('button', { name: /copy link/i })
    .first()
    .click();
  await expect(
    ownerPage.getByText(/^copied$/i).first(),
    'the copy button never confirmed',
  ).toBeVisible();
  shareAddress = await ownerPage.evaluate(() => navigator.clipboard.readText());
  expect(shareAddress, 'the clipboard does not hold a link').toMatch(/^https?:\/\/.+\/r\/.+/);
  expect(shareAddress, 'the copied link is not this share').toContain(shareSlug);

  record('j1', {
    db: {
      documents: (await rest(`/documents?id=eq.${documentId}&select=id`)).length,
      shares: (await rest(`/document_shares?document_id=eq.${documentId}&select=id`)).length,
      require_email: true,
    },
    screen: {
      landed_on: 'dashboard/<slug>?just_created=1',
      copy_confirmed: true,
      copied_link_is_share: true,
    },
  });
});

// ────────────────────────────────────────────────────────────────────
// J2 — the recipient
// ────────────────────────────────────────────────────────────────────

test('J2 recipient: a cold browser opens the link, passes the gate and reads', async ({
  browser,
}) => {
  // A separate context, so nothing the sender's browser holds — no cookies,
  // no storage, no tracker identity — can make this read look familiar.
  const recipient = await browser.newContext();
  try {
    const page = await recipient.newPage();
    await page.goto(shareAddress);
    await passEmailGate(page, reader);

    // The tracker having booted is the precondition for everything J3 checks.
    const booted = await page.evaluate(() => {
      const t = (window as unknown as { HTMLRadar?: { flush?: () => unknown } }).HTMLRadar;
      return !!t && typeof t.flush === 'function';
    });
    expect(booted, 'the tracker did not boot — the recipient has no analytics').toBe(true);

    const sections = await readSections(page, DWELL_MS);
    expect(sections, 'the fixture deck lost its sections').toBe(SECTIONS);

    record('j2', {
      db: {},
      screen: { tracker_booted: true, sections_scrolled: SECTIONS },
    });
  } finally {
    // Leaving, which is what ends a session.
    await recipient.close();
  }
});

// ────────────────────────────────────────────────────────────────────
// J2b — the sender's own look, which must never mail the sender
// ────────────────────────────────────────────────────────────────────

test('J2b sender previews their own link', async () => {
  await ownerPage.goto(`${BASE}/docs/${documentId}`);
  // The controls live inside the share card, which opens on click.
  await ownerPage.getByText('Golden journey recipient').first().click();
  const preview = ownerPage.getByRole('button', { name: /preview as you/i });
  await expect(preview, 'no preview control on the share card').toBeVisible({ timeout: 15_000 });
  const [tab] = await Promise.all([owner.waitForEvent('page'), preview.click()]);
  await tab.waitForLoadState('networkidle');
  // Long enough to be a read if the product were counting it as one.
  await tab.waitForTimeout(DWELL_MS);
  await flush(tab);
  await tab.close();
});

// ────────────────────────────────────────────────────────────────────
// J3 — the sender sees the truth
// ────────────────────────────────────────────────────────────────────

test('J3 sender sees the truth: report, database and notifications agree', async () => {
  // ---- what the database holds -------------------------------------
  const viewers = await rest<{ id: string; email: string | null; is_internal: boolean }>(
    `/viewers?share_id=eq.${shareId}&select=id,email,is_internal`,
  );
  const readers = viewers.filter((v) => !v.is_internal);
  expect(readers.length, 'the share should have exactly one real reader').toBe(1);
  expect(
    readers[0]!.email?.toLowerCase(),
    'the reader is not the address that passed the gate',
  ).toBe(reader.toLowerCase());

  const sessions = await rest<{
    id: string;
    viewer_id: string;
    active_time_seconds: number;
    max_scroll_depth: number;
    started_at: string;
  }>(
    `/sessions?share_id=eq.${shareId}&select=id,viewer_id,active_time_seconds,max_scroll_depth,started_at`,
  );
  const readerSessions = sessions.filter((s) => s.viewer_id === readers[0]!.id);
  expect(readerSessions.length, 'the read did not produce exactly one session').toBe(1);
  const activeSeconds = readerSessions[0]!.active_time_seconds ?? 0;
  const readerSessionStartedAt = readerSessions[0]!.started_at;

  // The journey scrolls three sections with a four-second pause on each, so
  // twelve seconds of it are unmistakably reading. Since 21 September the
  // clock also credits a few warm-up seconds and keeps running through a
  // silence of up to thirty, so the recorded figure is legitimately HIGHER
  // than the dwell rather than lower, and the upper bound is what has to be
  // generous now. The lower bound is the real assertion: a clock that has
  // stopped counting cannot reach it.
  expect(
    activeSeconds,
    `active time ${activeSeconds}s is nowhere near the ${EXPECTED_DWELL_SECONDS}s read`,
  ).toBeGreaterThanOrEqual(EXPECTED_DWELL_SECONDS - 4);
  expect(activeSeconds, 'active time is far above the time the journey spent').toBeLessThanOrEqual(
    EXPECTED_DWELL_SECONDS + 35,
  );

  const events = await rest<{ section_title: string; time_seconds: number }>(
    `/section_events?session_id=eq.${readerSessions[0]!.id}&select=section_title,time_seconds,ordinal&order=ordinal.asc`,
  );
  const sectionTitles = events.map((e) => e.section_title);
  expect(events.length, 'the three sections read produced no section rows').toBeGreaterThanOrEqual(
    SECTIONS,
  );

  // ---- what the notification log holds ------------------------------
  const sessionIds = sessions.map((s) => s.id);
  const notifications = await rest<{
    session_id: string;
    email_to: string;
    status: string;
    error_message: string | null;
    created_at: string;
  }>(
    `/notifications_log?session_id=in.(${sessionIds.join(',')})&select=session_id,email_to,status,error_message,created_at`,
  );
  const sent = notifications.filter((n) => n.status !== 'skipped');
  expect(sent.length, 'exactly one "opened" notification should have been queued').toBe(1);
  expect(
    sent[0]!.email_to.toLowerCase(),
    'the notification went somewhere other than the sender',
  ).toBe(JOURNEY_EMAIL.toLowerCase());
  expect(sent[0]!.session_id, 'the notification is not about the reader s session').toBe(
    readerSessions[0]!.id,
  );

  // Since schema/054 the e-mail no longer fires when the session row is
  // inserted; it fires on the first UPDATE that carries evidence of reading,
  // which is the first heartbeat the tracker sends. So the sender learns
  // about a real read within seconds of it starting, not minutes.
  //
  // Thirty-five seconds rather than thirty: the trigger waits for evidence,
  // the tracker's first heartbeat carries it, and a loaded machine can be a
  // few seconds late with that heartbeat. A number far above this would mean
  // the notification had drifted back to a batch or a cron.
  const noticedAfterSeconds =
    (new Date(sent[0]!.created_at).getTime() - new Date(readerSessionStartedAt).getTime()) / 1000;
  expect(
    noticedAfterSeconds,
    `the sender was told ${Math.round(noticedAfterSeconds)}s after the read began`,
  ).toBeLessThanOrEqual(35);
  expect(
    noticedAfterSeconds,
    'the notification predates the read it is about',
  ).toBeGreaterThanOrEqual(0);

  // The sender's own preview must not mail the sender. It is only a real
  // assertion when the preview produced a session at all, which is why it
  // reads the internal viewers rather than assuming one.
  const internalIds = new Set(viewers.filter((v) => v.is_internal).map((v) => v.id));
  const internalSessionIds = new Set(
    sessions.filter((s) => internalIds.has(s.viewer_id)).map((s) => s.id),
  );
  for (const row of notifications) {
    if (internalSessionIds.has(row.session_id)) {
      expect(row.status, 'the sender was mailed about their own preview').toBe('skipped');
    }
  }

  // ---- what the screen says ------------------------------------------
  await ownerPage.goto(`${BASE}/dashboard/${shareSlug}`);
  const shownViewers = await statValue(ownerPage, 'Viewers');
  const shownSessions = await statValue(ownerPage, 'Sessions');
  // Renamed on 21 September 2026 with the reading-time work: the tile used
  // to say "Avg tab-open", which was honest about the clock and dishonest
  // about the meaning. The figure it holds is the same one.
  const shownActive = durationToSeconds(await statValue(ownerPage, 'Avg reading time'));
  await expect(
    ownerPage.getByText('Estimated reading time', { exact: false }).first(),
    'the report no longer says the number is an estimate',
  ).toBeVisible();
  expect(shownViewers, 'the report does not show one reader').toBe('1');
  expect(shownSessions, 'the report does not show one session').toBe('1');
  await expect(
    ownerPage.getByText(reader, { exact: false }),
    'the report does not name the reader',
  ).toBeVisible();
  for (const heading of sectionTitles) {
    await expect(
      ownerPage.getByText(heading, { exact: false }).first(),
      `the report does not list the section "${heading}"`,
    ).toBeVisible();
  }
  // The screen and the database must be telling the same story. They round
  // differently, so this is a tolerance, not an equality.
  expect(
    Math.abs(shownActive - activeSeconds),
    'the report and the database disagree on time',
  ).toBeLessThanOrEqual(2);

  // ---- and what the API says about the same read -----------------------
  // J9 snapshots this endpoint's shape, but only ever with an empty viewer
  // list. This is the one place in the suite where a real reader exists, so
  // it is the only place the fields of a viewer entry can be pinned.
  const activity = (await (
    await fetch(`${BASE}/api/v1/shares/${shareId}/activity`, {
      headers: { Authorization: `Bearer ${process.env['HTMLRADAR_API_KEY'] ?? ''}` },
    })
  ).json()) as { opened: boolean; viewers: Array<Record<string, unknown>> };
  expect(activity.opened, 'the API says a read link was never opened').toBe(true);
  expect(activity.viewers.length, 'the API does not report the one reader').toBe(1);
  expect(
    Object.keys(activity.viewers[0]!).sort(),
    'the fields of a viewer in the public API changed',
  ).toEqual([
    'active_seconds',
    'email',
    'first_open',
    'label',
    'last_seen',
    'max_scroll',
    'sections',
  ]);
  expect(
    Object.keys(
      (activity.viewers[0]!['sections'] as Array<Record<string, unknown>>)[0] ?? {},
    ).sort(),
    'the fields of a section in the public API changed',
  ).toEqual(['time_seconds', 'title']);

  record('j3', {
    db: {
      readers: readers.length,
      sessions: readerSessions.length,
      section_events: events.length,
      notifications_queued: sent.length,
      notifications_skipped: notifications.length - sent.length,
      active_seconds: activeSeconds,
      section_titles: sectionTitles,
    },
    screen: {
      viewers: Number(shownViewers),
      sessions: Number(shownSessions),
      active_seconds: shownActive,
      reader_named: true,
    },
    events: await eventNamesSince(startedAt),
  });
});

// ────────────────────────────────────────────────────────────────────
// J4 — the reader comes back
// ────────────────────────────────────────────────────────────────────

test('J4a returning identified reader is recognised as the same reader', async ({ browser }) => {
  const returning = await browser.newContext();
  try {
    const page = await returning.newPage();
    await page.goto(shareAddress);
    await passEmailGate(page, reader);
    await readSections(page, DWELL_MS);

    const viewers = await rest<{ id: string; email: string | null; is_internal: boolean }>(
      `/viewers?share_id=eq.${shareId}&select=id,email,is_internal`,
    );
    const readers = viewers.filter((v) => !v.is_internal);
    expect(readers.length, 'the returning reader became a second reader').toBe(1);

    const sessions = await rest<{ id: string; viewer_id: string }>(
      `/sessions?viewer_id=eq.${readers[0]!.id}&select=id,viewer_id`,
    );
    expect(sessions.length, 'the second visit should be a second session, same reader').toBe(2);

    const notifications = await rest<{ status: string }>(
      `/notifications_log?session_id=in.(${sessions.map((s) => s.id).join(',')})&select=status`,
    );
    expect(
      notifications.filter((n) => n.status !== 'skipped').length,
      'a second e-mail went out for a reader the sender already knows about',
    ).toBe(1);

    record('j4a', {
      db: {
        readers: readers.length,
        sessions_for_reader: sessions.length,
        notifications_queued: 1,
      },
      screen: {},
    });
  } finally {
    await returning.close();
  }
});

test('J4b returning anonymous reader is recognised as the same reader', async ({ browser }) => {
  // FIXED on 21 September 2026. From 31 August a returning anonymous reader
  // was recorded as a NEW reader, so the sender's report showed two people
  // where there was one. The recipient now carries a server-only
  // `__Host-hr_rid` cookie and the page receives a value derived from it per
  // document, so the same browser is recognised without the document being
  // able to read the identifier.
  //
  // This test carried `test.fail()` until that landed. The annotation is
  // gone and the assertions below — which were always written for the
  // correct behaviour — are now the live check that it stays fixed.
  const anonymous = await browser.newContext();
  try {
    // A link with no gate, because "anonymous" is the case this guards:
    // with a gate the e-mail is the identity and the returning-reader
    // identifier is never asked to do this job.
    await ownerPage.goto(`${BASE}/docs/${documentId}`);
    await ownerPage.getByRole('button', { name: /create a new share link/i }).click();
    await ownerPage.locator('input[name="recipient_label"]').fill('Golden journey open link');
    // The switch a person actually presses. The checkbox itself is `sr-only`
    // — visible to a screen reader, one pixel to a mouse — so `uncheck()` on
    // it times out waiting for something it can click. Pressing the label is
    // both what a person does and what works.
    const gateSwitch = ownerPage.locator('label:has(input[name="require_email"])');
    await gateSwitch.click();
    await expect(
      ownerPage.locator('input[name="require_email"]'),
      'pressing the gate switch did not turn the e-mail gate off',
    ).not.toBeChecked();
    await ownerPage.getByRole('button', { name: /^create link$/i }).click();
    await ownerPage.waitForURL(/\/dashboard\/[^/?]+\?just_created=1/, { timeout: 60_000 });
    openSlug = ownerPage.url().match(/\/dashboard\/([^/?]+)/)?.[1] ?? '';
    openAddress = shareAddress.replace(shareSlug, openSlug);

    const page = await anonymous.newPage();
    await page.goto(openAddress);
    await readSections(page, DWELL_MS);
    await page.goto(openAddress);
    await readSections(page, DWELL_MS);

    const openShare = (
      await rest<{ id: string }>(`/document_shares?slug=eq.${openSlug}&select=id`)
    )[0]!;
    const viewers = await rest<{ id: string; is_internal: boolean }>(
      `/viewers?share_id=eq.${openShare.id}&select=id,is_internal`,
    );
    // Diagnostic first, because it explains the assertion under it.
    //
    // The recognition depends on two halves: the proxy hands the page a
    // `readerId` derived from the `__Host-hr_rid` cookie, and the TRACKER
    // uses it in place of the browser-storage identity it can no longer
    // reach. The second half only works if the bundle the recipient's host
    // serves is the one that was built with it. On 21 September 2026 it was
    // not: htmlradar.page served the new bundle and the customer's own
    // hostname served an older one, so every link on a custom domain kept
    // minting a fresh reader on every visit.
    const bundleOn = async (address: string) =>
      (await (await fetch(new URL('/v1/tracker.js', address).toString())).text()).length;
    const servedHere = await bundleOn(openAddress);
    const servedCanonically = await bundleOn('https://htmlradar.page/');
    expect(
      servedHere,
      `the tracker on ${new URL(openAddress).host} is ${servedHere} bytes and the one on ` +
        `htmlradar.page is ${servedCanonically} — this host is serving a different build, so ` +
        'the returning-reader identity never reaches it',
    ).toBe(servedCanonically);

    const readers = viewers.filter((v) => !v.is_internal);
    expect(readers.length, 'the same browser coming back was recorded as a second reader').toBe(1);

    // Two visits, so two sessions — recognising the reader must not collapse
    // the second visit, only attribute it to the same person.
    const sessions = await rest<{ id: string }>(
      `/sessions?viewer_id=eq.${readers[0]!.id}&select=id`,
    );
    expect(sessions.length, 'the second visit was not recorded as a second session').toBe(2);

    // And the sender hears about this reader once, not twice.
    const notifications = await rest<{ status: string }>(
      `/notifications_log?session_id=in.(${sessions.map((s) => s.id).join(',')})&select=status`,
    );
    expect(
      notifications.filter((n) => n.status !== 'skipped').length,
      'a second "opened" e-mail went out for a reader who had already been reported',
    ).toBe(1);

    record('j4b', {
      db: {
        readers: readers.length,
        sessions_for_reader: sessions.length,
        notifications_queued: 1,
      },
      screen: {},
    });
  } finally {
    await anonymous.close();
  }
});

test('J4c an open with no reading time does not mail the sender', async ({ browser }) => {
  // This was written expecting to fail, and it does not.
  //
  // The reasoning was that notify_on_first_open fires on the INSERT of a
  // session row (schema/003's trigger, schema/049's body) and never looks at
  // how long the person stayed, so a glance should mail the sender. Measured
  // on 21 September 2026, it does not: an open with no dwell and no scroll
  // produces no session row at all, so the trigger never runs. The correct
  // behaviour is already the real behaviour, and marking this `test.fail()`
  // would have made the suite red for a defect that is not there.
  //
  // The count below goes into the parity record, so if a later change starts
  // writing a session for a glance — which would start mailing senders about
  // people who did not read — the comparison shows it as 0 → 1.
  const glancer = await browser.newContext();
  try {
    const page = await glancer.newPage();
    await page.goto(shareAddress);
    await passEmailGate(page, skimmer);
    // No dwell, no scroll: opened and gone.
    await flush(page);

    const viewer = (
      await rest<{ id: string }>(
        `/viewers?share_id=eq.${shareId}&email=eq.${encodeURIComponent(skimmer)}&select=id`,
      )
    )[0];
    const sessions = viewer
      ? await rest<{ id: string }>(`/sessions?viewer_id=eq.${viewer.id}&select=id`)
      : [];
    const notifications = sessions.length
      ? await rest<{ status: string }>(
          `/notifications_log?session_id=in.(${sessions.map((s) => s.id).join(',')})&select=status`,
        )
      : [];
    expect(
      notifications.filter((n) => n.status !== 'skipped').length,
      'the sender was mailed about an open with no reading time',
    ).toBe(0);

    record('j4c', {
      db: { sessions_for_a_glance: sessions.length, notifications_queued: 0 },
      screen: {},
    });
  } finally {
    await glancer.close();
  }
});
