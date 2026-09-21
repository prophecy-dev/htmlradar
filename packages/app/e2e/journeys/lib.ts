// Shared machinery for the golden journeys.
//
// Three jobs, and nothing else belongs here:
//
//   1. Environment. Every address and every secret arrives through an
//      environment variable, so the same suite runs against a local dev
//      server, a Cloudflare preview deployment and production without a
//      line of it changing. Nothing here is ever printed.
//   2. Signing in the way a person does — the e-mail link, the confirm
//      page, the button. Journey 1 asserts each step of it; the other
//      journeys just need to be signed in, and call the same helper so
//      there is one sign-in path in the suite rather than two.
//   3. The parity record. Each journey calls `record()` with the facts it
//      produced; `scripts/golden-journeys.mjs` merges those files into one
//      record and compares two of them.
//
// SAFE AGAINST PRODUCTION. Everything this suite creates is owned by the
// journey account and titled `golden-journey …`, and `cleanupDocuments()`
// deletes on exactly those two conditions. The only address that ever
// receives an e-mail is the journey account's own and the reader address
// this file builds, which is on `example.com` and reaches nobody.

import { expect, type BrowserContext, type Page } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same convention as e2e/smoke.spec.ts: the repository's .env.local when it
// is there, and the ambient environment (CI) when it is not.
loadEnv({ path: path.resolve(__dirname, '../../../../.env.local') });

/** Every document this suite creates is titled with this prefix. Cleanup
 *  matches on it, so nothing outside it can be deleted by accident. */
export const TITLE_PREFIX = 'golden-journey ';

/** Where `record()` drops one file per journey, for the runner to merge. */
export const PARITY_DIR = path.resolve(__dirname, '.parity');

export const FIXTURES = path.resolve(__dirname, '../fixtures');

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`golden journeys: missing env ${name}`);
  return value;
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

/** The application under test. Local dev, a preview deployment or prod. */
export const BASE = trimSlash(process.env['PLAYWRIGHT_BASE_URL'] ?? 'https://htmlradar.com');
/** The content domain. Always the real one: the proxy has no local mode, so
 *  a recipient link is served from production even when the app is local. */
export const SHARE_BASE = trimSlash(process.env['PLAYWRIGHT_SHARE_BASE'] ?? 'https://htmlradar.page');

export const SUPABASE_URL = trimSlash(
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '',
);
export const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
export const API_KEY = process.env['HTMLRADAR_API_KEY'] ?? '';

// ────────────────────────────────────────────────────────────────────
// The owner accounts, and the rule that keeps them harmless
// ────────────────────────────────────────────────────────────────────

/**
 * The only domains a journey's OWNER account may live on.
 *
 * Why this constant exists. A journey does not simulate a read — it performs
 * one, and the product then does what it does for a real read: it e-mails
 * the owner "somebody opened your document", and on a revoked or expired
 * link it e-mails them that too. On 21 September 2026 the owner account was
 * the founder's own address, and a day of runs put thirty-one of those in
 * his personal inbox.
 *
 * The product must keep sending for real — that is half of what J3 proves —
 * so the answer is not to suppress the e-mail but to own an address that
 * accepts it and throws it away. Resend documents exactly that:
 * `delivered@resend.dev` accepts and discards, and every test address
 * supports a label after a `+`, so one sink serves both accounts
 * (`delivered+golden-pro@resend.dev`, `delivered+golden-free@resend.dev`).
 * Verified against Resend's "Send test emails" documentation, 21 September
 * 2026.
 *
 * Readers are a separate matter and already safe: they are on example.com,
 * reserved by RFC 2606, which reaches nobody.
 */
export const SINK_DOMAINS = ['resend.dev'] as const;

/**
 * Refuse to run rather than mail a person.
 *
 * Deliberately a throw at import time, not a skip: a skip is something a
 * tired person scrolls past, and the whole point is that nobody can point
 * this suite at a real inbox again — not the founder's, not
 * hello@htmlradar.com, not a customer's.
 */
function requireMailSink(variable: string, address: string): string {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  const sink = SINK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (!sink) {
    throw new Error(
      `${variable} is set to an address on "${domain}", which is not a mail sink.\n` +
        `The golden journeys make the product send real owner notifications, so the owner ` +
        `account must be one that accepts and discards them.\n` +
        `Allowed domains: ${SINK_DOMAINS.join(', ')} (for example ` +
        `delivered+golden-pro@resend.dev).\n` +
        `See "Accounts, and why they are mail sinks" in e2e/journeys/README.md for how to ` +
        `create the two accounts.`,
    );
  }
  return address;
}

/**
 * The Pro or comped account the journeys act as. A free account runs out of
 * tracked links on the third run (schema/027), so the suite would start
 * failing for a reason that says nothing about the product.
 *
 * There is deliberately NO fallback to the live-journey script's
 * JOURNEY_EMAIL: that variable names a real account with a real mailbox, and
 * inheriting it is precisely the mistake that filled an inbox.
 */
export const JOURNEY_EMAIL = process.env['GOLDEN_JOURNEY_EMAIL']
  ? requireMailSink('GOLDEN_JOURNEY_EMAIL', process.env['GOLDEN_JOURNEY_EMAIL'])
  : '';

/** A separate account that is already at its two-link cap, for journey 8.
 *  The cap counts links for the lifetime of the account, so once such an
 *  account exists it stays at the cap and the journey is repeatable. */
export const FREE_EMAIL = process.env['GOLDEN_FREE_EMAIL']
  ? requireMailSink('GOLDEN_FREE_EMAIL', process.env['GOLDEN_FREE_EMAIL'])
  : '';

/** A run identifier, so two runs never read each other's rows. */
export const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The recipient address. example.com is reserved by RFC 2606 and delivers
 *  to nobody, which is the point: the journey must not mail a stranger. */
export const readerEmail = (suffix = 'r1') => `golden-${RUN_ID}-${suffix}@example.com`;

// ────────────────────────────────────────────────────────────────────
// Supabase, as the service role
// ────────────────────────────────────────────────────────────────────

/** PostgREST with the service-role key. `path` starts with a slash. */
export async function rest<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<T[]> {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('golden journeys: Supabase env missing');
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  // The key is never in the message — only the path and the status.
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as T[]) : [];
}

let ownerIdCache: string | null = null;
/** The journey account's own id, which no API returns. */
export async function ownerId(): Promise<string> {
  if (ownerIdCache) return ownerIdCache;
  const rows = await rest<{ id: string }>(
    `/profiles?email=eq.${encodeURIComponent(JOURNEY_EMAIL)}&select=id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no profiles row for the journey account`);
  ownerIdCache = id;
  return id;
}

// ────────────────────────────────────────────────────────────────────
// Signing in, the way the e-mail link does it
// ────────────────────────────────────────────────────────────────────

/**
 * Mint a one-shot sign-in token through the Supabase admin API. This does
 * NOT send an e-mail — it hands back the same token the e-mail would carry,
 * which is what lets the suite walk the real door without a mailbox.
 */
export async function mintSignInToken(email: string, next = '/docs'): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'magiclink',
      email,
      options: { redirect_to: `${BASE}/auth/callback?next=${encodeURIComponent(next)}` },
    }),
  });
  if (!res.ok) throw new Error(`generate_link → ${res.status}`);
  const token = ((await res.json()) as { hashed_token?: string }).hashed_token;
  if (!token) throw new Error('generate_link returned no hashed_token');
  return token;
}

/**
 * Open a minted link in a real browser and finish the sign-in.
 *
 * Since 21 September 2026 this is two steps by design: the GET lands on
 * /auth/confirm and spends nothing (a corporate mail scanner fetches every
 * link on delivery and would otherwise burn the token), and only the POST
 * the button makes signs the person in.
 *
 * Returns the page it left open on `next`, so journey 1 can assert on the
 * way through and the others can just carry on.
 */
export async function signIn(
  context: BrowserContext,
  email = JOURNEY_EMAIL,
  next = '/docs',
  // Where to wait for. Normally `next`, but a page that immediately sends
  // the person onward — the converter's hand-off does — would be raced by a
  // wait on the address it only passes through.
  expectUrl?: RegExp,
): Promise<Page> {
  const token = await mintSignInToken(email, next);
  const page = await context.newPage();
  await page.goto(
    `${BASE}/auth/callback?next=${encodeURIComponent(next)}&token_hash=${encodeURIComponent(token)}&type=email`,
  );
  // The redirect target, not the destination: nothing has been spent yet.
  await expect(page, 'the e-mail link must land on the confirm page').toHaveURL(/\/auth\/confirm/);
  const button = page.locator('form[action="/auth/callback"] button[type="submit"]');
  await expect(button, 'the confirm page must render the one button').toBeVisible();
  await button.click();
  await page.waitForURL(expectUrl ?? new RegExp(escapeForRegExp(next)), { timeout: 60_000 });
  return page;
}

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ────────────────────────────────────────────────────────────────────
// Reading a document the way a recipient does
// ────────────────────────────────────────────────────────────────────

/**
 * Scroll through every heading with a real pause on each, then push the
 * tracker's buffer to the server.
 *
 * `dwellMs` is above the tracker's 3000 ms minimum (packages/tracker/src/
 * config.ts) — below it a section is dropped at flush time and the run
 * records an empty sections array with no explanation.
 */
export async function readSections(page: Page, dwellMs = 4000): Promise<number> {
  const headings = page.locator('h2');
  const count = await headings.count();
  for (let i = 0; i < count; i++) {
    await headings.nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(dwellMs);
  }
  await flush(page);
  return count;
}

/** Force the tracker to send what it has, rather than racing its heartbeat. */
export async function flush(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tracker = (window as unknown as { HTMLRadar?: { flush?: () => Promise<void> } }).HTMLRadar;
    if (tracker?.flush) await tracker.flush();
  });
  // The flush returns before the row is durable in Postgres.
  await page.waitForTimeout(2000);
}

/** Pass the e-mail gate on a recipient link. */
export async function passEmailGate(page: Page, email: string): Promise<void> {
  const field = page.locator('input[name="email"]');
  await expect(field, 'the e-mail gate did not appear').toBeVisible({ timeout: 15_000 });
  await field.fill(email);
  await page.locator('button[type="submit"]').click();
  await page.waitForLoadState('networkidle');
}

// ────────────────────────────────────────────────────────────────────
// What the screen says
// ────────────────────────────────────────────────────────────────────

/**
 * One headline number from the read report, by the label printed above it.
 *
 * The label is the only stable handle the page offers — there is no test
 * attribute on these tiles. A milestone that renames a label therefore fails
 * this journey, which is the honest outcome: a renamed headline stat IS a
 * change to what the sender reads, and a person should confirm it rather
 * than a suite absorbing it in silence. See README.md, "the one hook we want".
 */
export async function statValue(page: Page, label: string): Promise<string> {
  const tile = page.locator('div', { hasText: new RegExp(`^${escapeForRegExp(label)}$`) }).last();
  const value = tile.locator('xpath=following-sibling::div[1]');
  await expect(value, `no value tile under the "${label}" stat`).toBeVisible({ timeout: 15_000 });
  return (await value.innerText()).trim();
}

/** "2m 14s", "45s" and "1h 3m" all become seconds, so a run can be compared
 *  with what the database holds. */
export function durationToSeconds(text: string): number {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)\s*([hms])/g)) {
    total += Number(amount) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  }
  return total;
}

// ────────────────────────────────────────────────────────────────────
// The parity record
// ────────────────────────────────────────────────────────────────────

/**
 * Write one journey's facts. The runner merges every file in .parity into a
 * single record; `compare` then reads two records and reports the
 * differences that fall outside the declared tolerances.
 *
 * Put only facts in here that a change to the product SHOULD NOT move:
 * counts, event names in order, the rounded numbers the sender reads. Never
 * an id, a slug or a timestamp — those differ between two honest runs and
 * would drown the comparison in noise.
 */
export function record(journey: string, facts: Record<string, unknown>): void {
  mkdirSync(PARITY_DIR, { recursive: true });
  writeFileSync(path.join(PARITY_DIR, `${journey}.json`), JSON.stringify(facts, null, 2));
}

// ────────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────────

/**
 * Take this run's documents away.
 *
 * Scoped two ways — the journey account's owner_id AND the title prefix —
 * because a service-role key pointed at `documents` with a loose filter is
 * how a customer loses their work. Deleting the document row is enough:
 * document_shares, viewers, sessions and section_events all cascade
 * (schema/001, /003). The HTML in R2 stays; no route deletes an object and
 * these are a few hundred bytes each.
 *
 * Never throws. A housekeeping failure is not the product being broken, and
 * a journey that goes red for it is a journey people learn to ignore.
 */
export async function cleanupDocuments(titles?: string[]): Promise<number> {
  try {
    const owner = await ownerId();
    const filter = titles?.length
      ? `&title=in.(${titles.map((t) => `"${t.replace(/"/g, '')}"`).join(',')})`
      : `&title=like.${encodeURIComponent(TITLE_PREFIX)}*`;
    const removed = await rest(
      `/documents?owner_id=eq.${owner}${filter}`,
      { method: 'DELETE' },
    );
    return removed.length;
  } catch {
    return -1;
  }
}

/**
 * Take specific documents away, by id.
 *
 * For the converter journey, whose document is titled from the file name the
 * product derives rather than from a title the journey chose, so the prefix
 * rule cannot reach it. Still scoped to the journey account's owner_id: an id
 * from somewhere else deletes nothing. Never throws, for the same reason
 * cleanupDocuments() does not.
 */
export async function cleanupDocumentIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const owner = await ownerId();
    const removed = await rest(`/documents?owner_id=eq.${owner}&id=in.(${ids.join(',')})`, {
      method: 'DELETE',
    });
    return removed.length;
  } catch {
    return -1;
  }
}

/** The title every journey gives the document it creates. */
export const journeyTitle = (journey: string) => `${TITLE_PREFIX}${journey} ${RUN_ID}`;

/** The app_events this account emitted since `since`, oldest first. Names
 *  only: the properties carry ids and addresses that differ every run. */
export async function eventNamesSince(since: string): Promise<string[]> {
  const owner = await ownerId();
  const rows = await rest<{ event: string }>(
    `/app_events?distinct_id=eq.${owner}&timestamp=gte.${encodeURIComponent(since)}&select=event,timestamp&order=timestamp.asc`,
  );
  return rows.map((r) => r.event);
}
