import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pre-deploy smoke test harness. Runs against PROD by default
// (https://htmlradar.com) so it catches CDN / deploy / cache issues
// that mocked local tests can't see. Override with PLAYWRIGHT_BASE_URL
// if you want to point it at a preview deploy.
//
// Architecture:
//   - One project: Mobile Chromium with iPhone 14 Pro touch emulation.
//     90% of HTMLRadar recipients open links on mobile, and the bugs
//     we keep finding are mobile-specific (Lenis-style smooth scroll,
//     swipe decks, momentum scroll suppressing events).
//   - globalSetup mints a one-shot magic link for qa-bot@htmlradar.com
//     via the Supabase Admin API and consumes it in a Playwright
//     context, saving authenticated cookies to e2e/.auth/qa-bot.json.
//     Smoke tests reuse this storageState for the owner-dashboard half
//     of the run.
//
// Run with: pnpm qa:smoke (or `npx playwright test e2e/smoke.spec.ts`).

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'https://htmlradar.com';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  // We hit prod — don't hammer it. One worker keeps state predictable
  // (each test creates a session row; running parallel would mix
  // viewer rows in the dashboard assertion).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  // No global setup in v1 — auth-required tests are deferred. All
  // assertions either don't need auth (proxy responses, recipient
  // flow) or query Supabase REST directly with service-role. When
  // the dashboard UI test gets added back, restore this line:
  //   globalSetup: path.resolve(__dirname, './e2e/setup.ts'),
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Useful when a test fails mid-flow — open trace.zip in
    // `npx playwright show-trace` to see exactly what the user saw.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // Use Pixel 7 (Chromium-based) instead of iPhone 14 Pro
      // (WebKit) — Chromium is what the vast majority of HTMLRadar
      // viewers run, and we need predictable touch-event behavior
      // without WebKit's additional install/cache. The viewport +
      // userAgent + hasTouch flag are still mobile.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      // The golden journeys are their own project below, with their own
      // timeout. Without this, `pnpm test:e2e` would run them twice.
      testIgnore: /journeys\//,
    },
    {
      // The golden journeys (e2e/journeys) — the before-and-after safety net
      // for the design overhaul. See e2e/journeys/README.md.
      //
      // Desktop rather than the mobile profile above: what these journeys
      // guard is the SENDER's screens, which is where the overhaul happens
      // and which almost nobody uses on a phone. The recipient's side is
      // already covered on mobile by smoke.spec.ts.
      //
      // Their own timeout because a journey is a whole afternoon compressed:
      // a sign-in, an upload, three sections read at four seconds each and
      // a flush do not fit in the 60 seconds a smoke check needs.
      name: 'golden',
      // Its own testDir rather than a testMatch. A project-level testMatch
      // did not narrow this project on Playwright 1.56 — the golden run
      // collected auth-setup.spec.ts and smoke.spec.ts as well, so a
      // "golden" parity run was quietly carrying three tests that are not
      // journeys. A testDir cannot be misread that way.
      testDir: './e2e/journeys',
      // J11 lives in this directory and is NOT a parity journey: it runs
      // against a local worker rather than production, so a parity record from
      // it would compare a stub with a stub. testIgnore is what actually
      // narrows a project on this Playwright — the note above is about
      // testMatch, which does not.
      testIgnore: /j11-/,
      timeout: 300_000,
      use: { ...devices['Desktop Chrome'] },
    },
    // Journey 11, in both engines. It is the one journey that never touches
    // production — see e2e/journeys/j11-verified-gate.spec.ts and its harness.
    //
    // TWO ENGINES, AND THAT IS THE POINT. The gate's challenge cookie has to be
    // SameSite=None, because every gate page is sandboxed into an opaque origin
    // and a Lax cookie would never come back. WebKit treats such cookies far
    // more strictly than Chromium does, so a run in one engine proves half of
    // what a reader needs.
    //
    // ignoreHTTPSErrors because `wrangler dev --local-protocol https` serves a
    // self-signed certificate; the journey passes it on every context it opens
    // as well, since browser.newContext() does not inherit this.
    ...(['chromium', 'webkit'] as const).map((engine) => ({
      name: `verified-gate-${engine}`,
      testDir: './e2e/journeys',
      testMatch: /j11-/,
      // Standing up a worker and a stub is about twenty seconds of the first
      // test, and five browser cases follow it.
      timeout: 180_000,
      use: {
        ...devices[engine === 'chromium' ? 'Desktop Chrome' : 'Desktop Safari'],
        ignoreHTTPSErrors: true,
      },
    })),
  ],
});
