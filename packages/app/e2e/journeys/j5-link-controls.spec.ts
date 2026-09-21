// Journey 5 — the three controls a sender has over a link that is already
// out in the world: a password, an expiry and the off switch.
//
// The recipient's side of each is checked in a real browser, because the
// thing that goes wrong here is a page, not a status code: a revoked link
// that renders the document anyway, or an expired one that shows a blank
// screen instead of a sentence telling the reader what to do.
//
// The setup — three links on one document — goes through the public API
// rather than the interface. The subject of this journey is what the
// RECIPIENT meets; making the links by hand three times would add two
// minutes to every run and prove nothing that journey 1 has not proved.

import { test, expect } from '@playwright/test';
import { API_KEY, BASE, JOURNEY_EMAIL, cleanupDocuments, journeyTitle, record, rest } from './lib';

const title = journeyTitle('j5');
const PASSWORD = 'golden-journey-passphrase';

type Share = { share_id: string; url: string; slug: string };

const links: Record<'password' | 'expired' | 'revoked', Share> = {} as never;
let documentId = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

const html = `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>${title}</h1><section><h2>Behind the gate</h2><p>Only a reader who got past the control sees this.</p></section>
</body></html>`;

test.beforeAll(async () => {
  test.skip(!JOURNEY_EMAIL || !API_KEY, 'journey account or API key not set');

  const first = await api<Share>('POST', '/api/v1/shares', {
    html,
    title,
    require_email: false,
    password: PASSWORD,
    recipient_label: 'golden j5 password',
  });
  links.password = { ...first, slug: new URL(first.url).pathname.split('/').pop()! };
  documentId = (
    await rest<{ document_id: string }>(
      `/document_shares?id=eq.${first.share_id}&select=document_id`,
    )
  )[0]!.document_id;

  for (const kind of ['expired', 'revoked'] as const) {
    const share = await api<Share>('POST', '/api/v1/shares', {
      document_id: documentId,
      require_email: false,
      recipient_label: `golden j5 ${kind}`,
    });
    links[kind] = { ...share, slug: new URL(share.url).pathname.split('/').pop()! };
  }

  // Put the expiry in the past. The API refuses a date that has already
  // gone by — rightly, for a customer — so the row is aged directly. This is
  // setup, not the thing under test.
  await rest(`/document_shares?id=eq.${links.expired.share_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
  });
  await api('POST', `/api/v1/shares/${links.revoked.share_id}/revoke`, {});
});

test.afterAll(async () => {
  await cleanupDocuments([title]);
});

test('J5 link controls: password, expiry and the off switch', async ({ browser }) => {
  const facts: Record<string, unknown> = {};

  // ---- password: wrong is refused, right is let in --------------------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(links.password.url);
    await expect(page.getByRole('heading', { name: /locked/i })).toBeVisible();

    await page.locator('input[name="password"]').fill('not-the-password');
    await page.locator('button[type="submit"]').click();
    await expect(
      page.locator('input[name="password"]'),
      'a wrong password let the reader through',
    ).toBeVisible();
    await expect(page.getByText(title, { exact: false })).toHaveCount(0);
    facts['wrong_password_refused'] = true;

    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(
      page.getByRole('heading', { name: 'Behind the gate' }),
      'the right password did not open the document',
    ).toBeVisible({ timeout: 20_000 });
    facts['right_password_accepted'] = true;
    await context.close();
  }

  // ---- expired --------------------------------------------------------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(links.expired.url);
    expect(response?.status(), 'an expired link did not answer 410').toBe(410);
    await expect(page.getByText(/window has closed/i)).toBeVisible();
    await expect(page.getByText('Behind the gate')).toHaveCount(0);
    facts['expired_status'] = 410;
    await context.close();
  }

  // ---- revoked --------------------------------------------------------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(links.revoked.url);
    expect(response?.status(), 'a revoked link did not answer 403').toBe(403);
    await expect(page.getByText(/turned this link off/i)).toBeVisible();
    await expect(page.getByText('Behind the gate')).toHaveCount(0);
    facts['revoked_status'] = 403;
    await context.close();
  }

  // ---- nothing was recorded for the three refusals ---------------------
  // A refused reader is not a reader. A session row here would put a read in
  // the sender's report that never happened.
  for (const kind of ['expired', 'revoked'] as const) {
    const sessions = await rest(`/sessions?share_id=eq.${links[kind].share_id}&select=id`);
    expect(sessions.length, `a refused (${kind}) open was recorded as a session`).toBe(0);
    facts[`${kind}_sessions`] = sessions.length;
  }

  record('j5', { db: { expired_sessions: 0, revoked_sessions: 0 }, screen: facts });
});
