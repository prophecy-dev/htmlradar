// Journey 7 — a link on the customer's own hostname.
//
// A share on a custom domain (schema/052) is served by the same worker
// through a different hostname, a different Cloudflare custom-hostname
// certificate and a different renewal clock. Every one of those can lapse on
// its own while htmlradar.page keeps answering perfectly, so no other
// journey in this suite says anything about them.
//
// It SKIPS rather than fails when the journey account has no live domain.
// That is the ordinary state of the feature before an internal account is
// enrolled, and a journey that goes red for being switched off is a journey
// people learn to ignore.

import { test, expect } from '@playwright/test';
import {
  API_KEY,
  BASE,
  JOURNEY_EMAIL,
  cleanupDocuments,
  journeyTitle,
  ownerId,
  readSections,
  record,
  rest,
} from './lib';

const title = journeyTitle('j7');

test.afterAll(async () => {
  await cleanupDocuments([title]);
});

test('J7 custom domain: a link on the account s own hostname serves and records', async ({
  browser,
}) => {
  test.skip(!JOURNEY_EMAIL || !API_KEY, 'journey account or API key not set');

  const owner = await ownerId();
  const domains = await rest<{ id: string; hostname: string }>(
    `/custom_domains?owner_id=eq.${owner}&state=eq.live&select=id,hostname&limit=1`,
  );
  const domain = domains[0];
  test.skip(
    !domain,
    'the journey account has no live custom domain — set one up on it to cover this journey',
  );

  const res = await fetch(`${BASE}/api/v1/shares`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      require_email: false,
      domain_id: domain!.id,
      recipient_label: 'golden j7 custom host',
      html: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>
        <section><h2>On the customer s own address</h2><p>Served by the same worker through a different hostname.</p></section>
        </body></html>`,
    }),
  });
  expect(res.ok, `creating a custom-domain link answered ${res.status}`).toBe(true);
  const share = (await res.json()) as { share_id: string; url: string };

  try {
    // The address is half the assertion. A link created with a domain_id
    // that came back on htmlradar.page is a link the recipient opens
    // somewhere the customer never agreed to, and it would fetch a
    // perfectly healthy 200.
    expect(share.url, `the link is not on ${domain!.hostname}`).toContain(domain!.hostname);

    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(share.url);
    expect(response?.status(), 'the custom hostname did not serve the document').toBe(200);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await readSections(page);
    await context.close();

    const sessions = await rest(`/sessions?share_id=eq.${share.share_id}&select=id`);
    expect(sessions.length, 'a read on the custom hostname was not recorded').toBe(1);

    record('j7', {
      db: { sessions: sessions.length },
      screen: { served: 200, on_custom_host: true },
    });
  } finally {
    await fetch(`${BASE}/api/v1/shares/${share.share_id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
    }).catch(() => undefined);
  }
});
