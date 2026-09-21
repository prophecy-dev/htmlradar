// Journey 11 — the verified e-mail gate, in a real browser.
//
// THE FIVE THINGS THIS PROVES, and why each one needs a browser rather than a
// unit test. The gate's promise is not a status code; it is that a stranger
// holding the link learns nothing, that a code belongs to one person in one
// browser, and that an owner who turns the option on is obeyed by readers who
// are already inside. Every one of those is a fact about cookies and forms,
// which is a fact about a browser.
//
//   1. A permitted address receives a code and gets in.
//   2. Five wrong codes burn the code: the right one no longer works.
//   3. A non-permitted address sees the identical screen and is sent nothing.
//   4. A second browser cannot spend the first browser's code.
//   5. Turning the option on locks out a reader who was already admitted.
//
// WHY THIS ONE JOURNEY DOES NOT TOUCH PRODUCTION. J1 to J10 run against the
// real application, the real proxy and the real Supabase, deliberately. J11
// cannot: schema/055_verified_email_gate.sql has not been applied and the
// worker that reads it has not been deployed, so there is no production in
// which this feature exists. It runs instead against the real worker bundle
// under `wrangler dev`, with the database and the mail provider replaced by one
// stub — see verified-gate-harness.mjs, which also explains why no message can
// leave this process.
//
// It runs in BOTH Chromium and WebKit (two projects in playwright.config.ts),
// because the gate's challenge cookie is `SameSite=None` out of necessity —
// every gate page is sandboxed into an opaque origin, so the browser treats a
// post back to the page's own host as cross-site and a Lax cookie would never
// arrive — and WebKit is far stricter about such cookies than Chromium. A gate
// that works in one and not the other is a gate that does not work.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  DOC_HEADING,
  PERMITTED,
  STRANGER,
  startHarness,
  stopHarness,
} from './verified-gate-harness.mjs';

// One worker, one stub and one link serve all five; each case resets the state
// it cares about first. Serial because they share that one link.
test.describe.configure({ mode: 'serial' });

type Harness = Awaited<ReturnType<typeof startHarness>>;
let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness();
});

test.afterAll(async () => {
  await stopHarness();
});

/** A browser that has never seen this link. Its own cookie jar, and therefore
 *  its own challenge — which is the whole point of the fourth case. */
const freshReader = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`${harness.baseUrl}/r/${harness.slug}`);
  return page;
};

const submitEmail = async (page: Page, email: string): Promise<void> => {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('button[type="submit"]').click();
};

const submitCode = async (page: Page, code: string): Promise<void> => {
  await page.locator('#code').fill(code);
  await page.locator('button[type="submit"]').click();
};

// Five six-digit codes that are not the real one. Six candidates, so filtering
// the real one out still leaves five.
const wrongCodes = (real: string): string[] =>
  ['100001', '200002', '300003', '400004', '500005', '600006']
    .filter((c) => c !== real)
    .slice(0, 5);

test('J11 a permitted address is mailed a code and gets in', async ({ browser }) => {
  harness.reset();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await freshReader(context);

  await expect(page.getByRole('heading', { name: 'View this document.' })).toBeVisible();
  await submitEmail(page, PERMITTED);

  // The sentence is conditional on purpose — it promises nothing about an
  // address we will not discuss. See verifyCodeForm in the proxy's responses.
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();

  const mail = harness.mail();
  expect(mail.length, 'a permitted address was not sent a code').toBe(1);
  expect(mail[0]!.to, 'the code went to the wrong address').toEqual([PERMITTED]);
  // The message carries the code and nothing to click: a link in it would be
  // spent by corporate mail security before the reader ever saw it.
  expect(mail[0]!.text, 'the code e-mail contains a link').not.toMatch(/https?:\/\//);

  const code = harness.lastCode()!;
  expect(code, 'no six-digit code in the message').toMatch(/^\d{6}$/);

  await submitCode(page, code);
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'the right code did not open the document',
  ).toBeVisible();

  await context.close();
});

test('J11 five wrong codes burn the code', async ({ browser }) => {
  harness.reset();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await freshReader(context);
  await submitEmail(page, PERMITTED);
  const code = harness.lastCode()!;

  // Five is the attempt budget in schema/055. The fifth wrong guess leaves the
  // counter at five and the sixth request matches no live row at all, so the
  // code is dead although it has neither expired nor been used.
  for (const wrong of wrongCodes(code)) {
    await submitCode(page, wrong);
    await expect(
      page.getByText('That code is not right. Check the email and try again.'),
    ).toBeVisible();
  }

  await submitCode(page, code);
  await expect(
    page.getByText('That code is not right. Check the email and try again.'),
    'the right code still worked after five wrong ones',
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'a burnt code opened the document',
  ).toHaveCount(0);

  await context.close();
});

test('J11 a non-permitted address sees the identical screen and is sent nothing', async ({
  browser,
}) => {
  harness.reset();

  const render = async (email: string): Promise<{ status: number; html: string }> => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await freshReader(context);
    await page.locator('input[name="email"]').fill(email);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/email')),
      page.locator('button[type="submit"]').click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
    // Two things are allowed to differ, and only two: the address, which is
    // echoed into a hidden field, and the signed form token, which is a fresh
    // signature over a fresh challenge on every render (see issueGateToken in
    // packages/proxy/src/auth.ts). Blanking exactly those is what lets
    // everything else be compared byte for byte.
    const html = (await page.content())
      .split(email)
      .join('{address}')
      .replace(/name="t" value="[^"]*"/g, 'name="t" value="{token}"');
    await context.close();
    return { status: response.status(), html };
  };

  const permitted = await render(PERMITTED);
  const stranger = await render(STRANGER);

  expect(stranger.status, 'the two screens answered with different status codes').toBe(
    permitted.status,
  );
  expect(
    stranger.html,
    'the screen for a non-permitted address differs from the screen for a permitted one — ' +
      'somebody holding the link could use the gate to discover who is on the allow-list',
  ).toBe(permitted.html);

  // The only difference in the world is in a mailbox we are not showing.
  const mail = harness.mail();
  expect(mail.map((m) => m.to).flat(), 'a non-permitted address was sent a code').toEqual([
    PERMITTED,
  ]);

  // And the database was asked either way: the work, and therefore the time,
  // is the same for both, which is what keeps a refused address from being the
  // fast one.
  expect(harness.codeCount(), 'the two addresses did not cost the same database work').toBe(2);
});

test('J11 a second browser cannot use the first browser’s code', async ({ browser }) => {
  harness.reset();

  const first = await browser.newContext({ ignoreHTTPSErrors: true });
  const firstPage = await freshReader(first);
  await submitEmail(firstPage, PERMITTED);
  const firstCode = harness.lastCode()!;

  // A second context is a second cookie jar, so this reader gets a challenge of
  // their own — which is what makes a code read over somebody's shoulder
  // useless. They ask for their own code so that they are standing in front of
  // the same form, then type the other browser's.
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  const secondPage = await freshReader(second);
  await submitEmail(secondPage, PERMITTED);
  const secondCode = harness.lastCode()!;
  expect(secondCode, 'the second browser was handed the first browser’s code').not.toBe(firstCode);

  await submitCode(secondPage, firstCode);
  await expect(
    secondPage.getByText('That code is not right. Check the email and try again.'),
    'a code issued to another browser was accepted',
  ).toBeVisible();
  await expect(
    secondPage.getByRole('heading', { name: DOC_HEADING }),
    'another browser’s code opened the document',
  ).toHaveCount(0);

  // The first browser's code is untouched by all of that: retiring a live code
  // is scoped to the browser that asked for it.
  await submitCode(firstPage, firstCode);
  await expect(
    firstPage.getByRole('heading', { name: DOC_HEADING }),
    'the first browser’s own code stopped working',
  ).toBeVisible();

  await first.close();
  await second.close();
});

test('J11 turning the option on locks out an already-admitted reader', async ({ browser }) => {
  // The link starts as an ordinary e-mail-gated link: the reader types an
  // address and is in, with no code involved.
  harness.reset({ verify_email: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await freshReader(context);
  await submitEmail(page, PERMITTED);
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'the plain e-mail gate did not admit a permitted address',
  ).toBeVisible();
  expect(harness.mail().length, 'the plain gate sent a code').toBe(0);

  // The owner turns verification on. Decision 6: readers who are already past
  // the gate verify at their next open, with no migration step and no action by
  // the owner. The cookie they hold is an ordinary e-mail cookie, and a link
  // that requires verification looks at a different cookie entirely.
  harness.setShare({ verify_email: true });

  await page.goto(`${harness.baseUrl}/r/${harness.slug}`);
  await expect(
    page.getByRole('heading', { name: 'View this document.' }),
    'a reader admitted before the option was turned on was not asked to verify',
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'an unverified reader still had the document',
  ).toHaveCount(0);

  await context.close();
});

// ---------------------------------------------------------------------------
// The two adversarial cases, added after Astra's review. Both reproduce a real
// bypass that the unit suite now also covers; they are here because only a
// browser can show that the defence survives contact with real cookie
// handling, a real form and a real cross-context post.
// ---------------------------------------------------------------------------

test('J11 an ordinary e-mail cookie cannot be repackaged as a verified one', async ({
  browser,
}) => {
  // Astra's critical finding, in a browser. An ordinary link whose custom
  // ending is the legal slug `verified`, entered with an address that carried
  // the target slug across the old delimiter, produced a signature that the
  // verified cookie's own verifier accepted for a DIFFERENT link.
  harness.reset({
    verify_email: false,
    require_email: true,
    allowed_emails: null,
    slug: 'verified',
  });

  const attacker = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await attacker.newPage();
  await page.goto(`${harness.baseUrl}/r/verified`);
  await page.locator('input[name="email"]').fill('j11-verified-gate:buyer@example.com');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/email')),
    page.locator('button[type="submit"]').click(),
  ]);

  // Lift the signature out of the cookie the ordinary gate just issued and
  // repackage it under the verified cookie's name and shape for the real link.
  const jar = await attacker.cookies();
  const ordinary = jar.find((c) => c.name.startsWith('htmlradar_email_'));
  expect(
    ordinary,
    'the ordinary gate issued no cookie, so the forgery cannot be attempted',
  ).toBeTruthy();
  const [, , expiry, mac] = ordinary!.value.split('.');
  const target = Buffer.from('buyer@example.com').toString('base64url');

  harness.reset();
  await attacker.addCookies([
    {
      name: `__Host-hr_v_${harness.slug}`,
      value: `${harness.slug}.${target}.${expiry}.${mac}`,
      url: harness.baseUrl,
      httpOnly: true,
      secure: true,
    },
  ]);

  await page.goto(`${harness.baseUrl}/r/${harness.slug}`);
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'a forged verified cookie opened the document',
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'View this document.' }),
    'the forged cookie was not simply ignored',
  ).toBeVisible();

  await attacker.close();
});

test('J11 a forged post cannot request a code or burn one', async ({ browser }) => {
  // Astra's second finding. The challenge is SameSite=None, so a victim's
  // browser attaches it to a post an attacker auto-submits. What the attacker
  // cannot produce is the hidden field signed over THAT challenge.
  harness.reset();

  const victim = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await freshReader(victim);
  await submitEmail(page, PERMITTED);
  const realCode = harness.lastCode()!;
  const before = harness.codeCount();

  // A post carrying the victim's cookies but a token the attacker made up.
  const forgedRequest = await page.request.post(`${harness.baseUrl}/r/${harness.slug}/email`, {
    form: { email: PERMITTED, t: `${Math.floor(Date.now() / 1000) + 600}.${'a'.repeat(64)}` },
    headers: { origin: 'null' },
  });
  // 401 with the address form again: the refusal is about the stale or forged
  // FORM, not about the address, so it says nothing about who is on the list.
  expect(forgedRequest.status(), 'a forged request-code post was not refused').toBe(401);
  expect(await forgedRequest.text()).toContain('That form expired');
  expect(harness.codeCount(), 'a forged post minted a code').toBe(before);
  expect(harness.mail().length, 'a forged post sent a message').toBe(1);

  // And six forged wrong guesses must not burn the code the victim is holding.
  for (let i = 0; i < 6; i += 1) {
    await page.request.post(`${harness.baseUrl}/r/${harness.slug}/verify`, {
      form: {
        email: PERMITTED,
        code: realCode === '000000' ? '111111' : '000000',
        t: `${Math.floor(Date.now() / 1000) + 600}.${'b'.repeat(64)}`,
      },
      headers: { origin: 'null' },
    });
  }

  await submitCode(page, realCode);
  await expect(
    page.getByRole('heading', { name: DOC_HEADING }),
    'forged guesses burned the code the real reader was waiting on',
  ).toBeVisible();

  await victim.close();
});
