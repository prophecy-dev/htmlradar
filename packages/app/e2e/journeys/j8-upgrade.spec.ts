// Journey 8 — the path a free account takes when it runs out.
//
// Two paying customers converted here, and both converted on SEEING the
// limit rather than on being blocked by it, so what this journey guards is
// the sentence and the button, not an error code.
//
// It needs its own account: GOLDEN_FREE_EMAIL, a free account that has
// already used both of its tracked links. The cap counts links for the
// lifetime of the account (schema/027), revoked ones included, so once such
// an account exists it stays at the cap and this journey is repeatable
// forever. Without the variable the refusal half skips and the upgrade page
// is not checked at all, because a Pro account is shown a different page.
//
// IT DOES NOT START A CHECKOUT. The button's destination is read, never
// followed.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { BASE, FIXTURES, FREE_EMAIL, RUN_ID, TITLE_PREFIX, record, rest, signIn } from './lib';

const title = `${TITLE_PREFIX}j8 ${RUN_ID}`;
let documentId = '';

test.afterAll(async () => {
  if (!documentId || !FREE_EMAIL) return;
  // Scoped to the free account and to this document, so nothing else on it
  // can be reached by this line.
  const owner = (
    await rest<{ id: string }>(`/profiles?email=eq.${encodeURIComponent(FREE_EMAIL)}&select=id`)
  )[0];
  if (owner) {
    await rest(`/documents?owner_id=eq.${owner.id}&id=eq.${documentId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
});

test('J8 upgrade path: a third link is refused, and the upgrade page can be paid on', async ({
  browser,
}) => {
  test.skip(
    !FREE_EMAIL,
    'GOLDEN_FREE_EMAIL is not set — needs a free account that has already used its two links',
  );

  const context = await browser.newContext();
  const page = await signIn(context, FREE_EMAIL);

  // Uploading is not capped — only links are — so this account can still put
  // a document in, which is what makes the refusal visible.
  await page.goto(`${BASE}/new`);
  await page.locator('input#title').fill(title);
  await page.locator('input#file').setInputFiles(path.join(FIXTURES, 'golden-deck.html'));
  await page.getByRole('button', { name: /create document/i }).click();
  await page.waitForURL(/\/docs\/[0-9a-f-]{36}/, { timeout: 60_000 });
  documentId = page.url().match(/\/docs\/([0-9a-f-]{36})/)?.[1] ?? '';

  // The refusal. Not an error after the fact: the control that would make a
  // third link is replaced by the prompt.
  await expect(
    page.getByText(/used both free tracked links/i),
    'a capped account was not told it is capped',
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: /create a new share link/i }),
    'a capped account was still offered a third link',
  ).toHaveCount(0);

  await page.getByRole('link', { name: /upgrade to pro/i }).first().click();
  await page.waitForURL(/\/upgrade\?reason=share_quota/, { timeout: 30_000 });
  await expect(
    page.getByText(/free tier cap reached/i),
    'the upgrade page does not say why the person is here',
  ).toBeVisible();

  // The button that takes the money. Its destination is asserted and NOT
  // followed: a real checkout would put a real order in Polar.
  const checkout = page.locator('[data-cta="upgrade.checkout"]').first();
  await expect(checkout, 'the upgrade page offers no way to pay').toBeVisible();
  const href = await checkout.getAttribute('href');
  expect(href, 'the pay button does not point at the payment provider').toMatch(
    /^https:\/\/([a-z0-9-]+\.)*polar\.sh\//,
  );

  record('j8', {
    db: {},
    screen: { cap_prompt_shown: true, create_control_hidden: true, checkout_host: 'polar.sh' },
  });

  await context.close();
});
