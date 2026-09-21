#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console */
// Daily live-journey check: walk a real user's path through production and
// fail loudly when it breaks.
//
// Why this exists: from 4 to 16 September 2026, every e-mail sign-in link
// landed the person on the page SIGNED OUT, and nothing noticed for twelve
// days. The five-minute monitor only asks whether pages return HTTP 200, and
// a sign-in that silently drops the session returns a perfectly healthy 200.
// The only check that would have caught it is one that actually signs in and
// actually opens a shared document, which is what this script does.
//
//   node packages/app/scripts/live-journey.mjs
//
// Runs daily from .github/workflows/live-journey.yml. Four steps:
//
//   sign-in     — mint a magic-link token with the Supabase admin API and walk
//                 it through /auth/callback and /auth/confirm exactly as a
//                 person opening the e-mail link does, in both steps.
//   api         — create a tracked link, fetch it on the content domain, read
//                 its activity, then revoke it.
//   custom-host — the same journey on the account's own domain, when it has a
//                 live one. Skipped, not failed, when it has none.
//   cleanup     — delete yesterday's journey documents, so a daily check does
//                 not leave a year of clutter on a real account.
//
// JOURNEY_EMAIL is required and must be a PRO or COMPED account. A free
// account is capped at two tracked links for its lifetime by the
// enforce_share_cap trigger (schema/027_free_tier_share_cap.sql), revoked
// links included, so a free account would start failing on the third day
// with a 402 and the failure would say nothing about production.
//
// The e-mail TEMPLATE contract (`{{ .RedirectTo }}&token_hash={{ .TokenHash
// }}&type=email`) is verified separately, in the Supabase dashboard — an API
// cannot read the template back. This script verifies the other half: that
// the door the template points at still opens.

import { pathToFileURL } from 'node:url';

const REDIRECT_PATH = '/auth/callback?next=%2Fdocs';

/** Everything the run needs, read from the environment. */
export function config(source = process.env) {
  const trim = (value) => (value ?? '').replace(/\/+$/, '');
  return {
    baseUrl: trim(source.BASE_URL) || 'https://htmlradar.com',
    supabaseUrl: trim(source.SUPABASE_URL),
    serviceKey: source.SUPABASE_SERVICE_ROLE_KEY ?? '',
    apiKey: source.HTMLRADAR_API_KEY ?? '',
    resendKey: source.RESEND_API_KEY ?? '',
    alertTo: source.ALERT_TO || 'hello@htmlradar.com',
    journeyEmail: source.JOURNEY_EMAIL ?? '',
  };
}

/**
 * Step 1 — the sign-in contract, both halves of it.
 *
 * Mints a magic-link token through the Supabase admin API (which does NOT
 * send an e-mail) and walks it the way a person opening the e-mail does.
 *
 * Since 21 September 2026 that is two requests, and this step checks both,
 * because each guards a different outage:
 *
 *   the GET must NOT sign anyone in. A corporate mail scanner fetches every
 *   link in a message on delivery, and while /auth/callback spent the token
 *   on a GET it handed the session to the scanner and left the human six
 *   "expired" clicks (drscholls.com, 17-18 September 2026). So a session
 *   cookie on the GET is a FAILURE here, not a pass.
 *
 *   the POST must sign the person in. That is the old contract, and the one
 *   the 4-16 September outage broke: it redirected to /docs with no cookie at
 *   all, or bounced to /sign-in.
 */
export async function signInStep(cfg) {
  const link = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'magiclink',
      email: cfg.journeyEmail,
      options: { redirect_to: `${cfg.baseUrl}${REDIRECT_PATH}` },
    }),
  });
  if (!link.ok) throw new Error(`generate_link returned ${link.status}: ${await link.text()}`);
  const token = (await link.json())?.hashed_token;
  if (!token) throw new Error('generate_link returned no hashed_token');

  // Keep the query — the token lives in it, and a /auth/confirm fetched
  // without one redirects straight back to /sign-in.
  const locationOf = (res) => {
    const location = res.headers.get('location') ?? '';
    return location.startsWith('http') ? location : `${cfg.baseUrl}${location}`;
  };
  const pathOf = (res) => new URL(locationOf(res)).pathname;
  // getSetCookie keeps the cookies separate; the fallback is for stubbed
  // Headers in tests and any runtime that predates it.
  const setCookiesOf = (res) =>
    (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).filter(Boolean);
  // An `sb-` cookie being PRESENT proves nothing — a sign-out sets `sb-...=`
  // with an empty value and Max-Age=0, which any substring check reads as a
  // session. Only a non-empty value is a candidate.
  const sessionCookies = (res) =>
    setCookiesOf(res)
      .map((line) => line.split(';')[0].trim())
      .filter((pair) => pair.startsWith('sb-') && pair.slice(pair.indexOf('=') + 1).length > 0);

  // Half one: exactly what a mail scanner does — open the link with a GET.
  const scan = await fetch(
    `${cfg.baseUrl}${REDIRECT_PATH}&token_hash=${encodeURIComponent(token)}&type=email`,
    { redirect: 'manual' },
  );
  if (sessionCookies(scan).length) {
    throw new Error(
      'a GET on the e-mail link set an sb- session cookie — the link is spent before the person clicks, and a mail scanner will take it',
    );
  }
  if (!pathOf(scan).startsWith('/auth/confirm')) {
    throw new Error(
      `the e-mail link went to ${pathOf(scan)}, not /auth/confirm — the token_hash door is broken`,
    );
  }

  // Both of these URLs carry a single-use token, so both responses have to
  // deny referrers and deny caching. This is checked in production every day
  // because it cannot be checked anywhere else: the headers were declared in
  // next.config for a week and were silently absent on Cloudflare Pages, as
  // next-on-pages does not run Next's routing layer in front of a Pages
  // function. `next dev` said they were fine the whole time.
  const sealed = (res, what) => {
    for (const [header, expected] of [
      ['referrer-policy', 'no-referrer'],
      ['cache-control', 'no-store'],
    ]) {
      const actual = res.headers.get(header);
      if (actual !== expected) {
        throw new Error(
          `${what} answered ${header}: ${actual ?? '(absent)'}, not ${expected} — the sign-in token in that URL can leak through a referrer or a cache`,
        );
      }
    }
  };

  const confirmUrl = locationOf(scan);
  const confirm = await fetch(confirmUrl, { redirect: 'manual' });
  sealed(confirm, '/auth/confirm');
  if (sessionCookies(confirm).length) {
    throw new Error(
      'a GET on /auth/confirm set an sb- session cookie — rendering the page is signing people in, which is the whole bug',
    );
  }
  const page = confirm.ok ? await confirm.text() : '';
  // Submit what the page actually renders, not what we minted. A form that
  // carries the wrong token, or no token, has to fail here rather than pass
  // because the script quietly supplied the right one from its own memory.
  const form = parseForm(page);
  if (!form) {
    throw new Error(
      `/auth/confirm returned ${confirm.status} without a POST form to /auth/callback — nobody can finish signing in`,
    );
  }
  if (!form.fields.token_hash) {
    throw new Error('the confirmation form carries no token_hash field — the button cannot work');
  }

  // Half two: the button, submitted the way the browser on that page would —
  // same-origin, with the Origin header the login-CSRF check requires.
  const callback = await fetch(new URL(form.action, confirmUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(confirmUrl).origin,
      referer: confirmUrl,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(form.fields),
    redirect: 'manual',
  });
  const destination = pathOf(callback);
  sealed(callback, 'the POST to /auth/callback');

  // 303 specifically: a 307 would make the browser re-POST to the
  // destination, and a refresh would offer to submit the token again.
  if (callback.status !== 303) {
    throw new Error(`callback returned ${callback.status}, not the 303 the browser needs`);
  }
  if (!destination.startsWith('/docs')) {
    throw new Error(
      `callback redirected to ${destination || '(nowhere)'}, not /docs — the token_hash door is broken`,
    );
  }
  const session = sessionCookies(callback);
  if (!session.length) {
    throw new Error('callback redirected to /docs but set no sb- session cookie — signed OUT');
  }

  // The cookie existing is not the cookie working. Spend it on a page the
  // middleware guards: a signed-out request to /docs is bounced to /sign-in,
  // so a 200 here is the only proof that the session is real.
  const guarded = await fetch(`${cfg.baseUrl}/docs`, {
    headers: { cookie: session.join('; ') },
    redirect: 'manual',
  });
  if (guarded.status !== 200) {
    throw new Error(
      `the session cookie did not authenticate: /docs answered ${guarded.status} to ${pathOf(guarded) || '(no redirect)'} — the cookie is set but signed OUT`,
    );
  }
  return `GET spent nothing, POST 303 to ${destination}, session authenticated /docs`;
}

/**
 * The confirmation form as rendered: its action and its hidden fields.
 *
 * Deliberately blunt — the page is ours and is one small form, so a regex is
 * enough and pulls in no parser. Returns null when there is no form posting
 * to /auth/callback, which is itself a failure worth reporting.
 */
export function parseForm(html) {
  const form = /<form\b[^>]*\bmethod=["']?post["']?[^>]*>([\s\S]*?)<\/form>/i.exec(html ?? '');
  if (!form) return null;
  const action = /\baction=["']([^"']+)["']/i.exec(form[0])?.[1];
  if (!action || !action.includes('/auth/callback')) return null;
  // React escapes attribute values, so a `next` like `/docs?a=1&b=2` arrives
  // as `&amp;`. Submitting that verbatim would send the wrong destination.
  const unescape = (value) =>
    value.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name],
    );
  const fields = {};
  for (const input of form[1].matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname=["']([^"']+)["']/i.exec(input[0])?.[1];
    if (name) fields[name] = unescape(/\bvalue=["']([^"']*)["']/i.exec(input[0])?.[1] ?? '');
  }
  return { action, fields };
}

/**
 * Step 2 — the document journey, over the public HTTP API.
 *
 * Creates a tracked link, opens it on the content domain the way a recipient
 * does, reads the activity report, then revokes the link. There is no
 * document-delete route in the v1 API, so the tiny document stays on the
 * account; only the link is switched off.
 */
export async function apiStep(cfg, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const { title, html } = journeyDocument();

  // require_email: false — the gate would serve a form instead of the
  // document, and what this step is checking is that the document is served.
  const share = await api(cfg, 'POST', '/api/v1/shares', { html, title, require_email: false });
  const notes = [];
  try {
    const page = await fetch(share.url);
    const body = await page.text();
    if (page.status !== 200) throw new Error(`${share.url} returned ${page.status}`);
    if (!body.includes(title)) {
      throw new Error(`${share.url} returned 200 but not the document — title missing from body`);
    }
    notes.push(`${new URL(share.url).host} served the document`);

    await sleep(5000);
    const activity = await api(cfg, 'GET', `/api/v1/shares/${share.share_id}/activity`);
    notes.push(
      activity.opened
        ? 'open recorded in activity'
        : 'open NOT recorded, as expected: opens are counted by the browser tracker, which a plain fetch never runs — the 200 carrying the document body is the pass here',
    );
  } finally {
    try {
      await api(cfg, 'POST', `/api/v1/shares/${share.share_id}/revoke`, {});
      notes.push('link revoked (no document-delete route in v1, so the document stays)');
    } catch (error) {
      notes.push(`CLEANUP FAILED: ${error.message}`);
    }
  }
  return notes.join('; ');
}

/** The tiny document every step of the journey creates. */
function journeyDocument() {
  const title = `live-journey ${new Date().toISOString()}`;
  return {
    title,
    html:
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
      `<h1>${title}</h1>` +
      `<section><h2>Why this document exists</h2><p>Automated daily check of the live journey.</p></section>` +
      `<section><h2>What it proves</h2><p>A link was created, served and revoked.</p></section>` +
      `</body></html>`,
  };
}

/** The journey account's own id, which the API never returns. */
async function journeyOwnerId(cfg) {
  const owners = await rest(
    cfg,
    'GET',
    `/profiles?email=eq.${encodeURIComponent(cfg.journeyEmail)}&select=id`,
  );
  const ownerId = owners[0]?.id;
  if (!ownerId) throw new Error(`no profiles row for ${cfg.journeyEmail}`);
  return ownerId;
}

/**
 * Step 3 — the same journey, on the customer's own hostname.
 *
 * A link on a customer domain (schema/052) is served by the same worker
 * through a different hostname, a different Cloudflare custom-hostname
 * certificate and a different SSL renewal clock. Every one of those can lapse
 * on its own while htmlradar.page keeps answering perfectly, so the api step
 * above proves nothing about them.
 *
 * It SKIPS rather than fails when the journey account has no live domain,
 * because that is the ordinary state of the feature before an internal
 * account is enrolled, and a step that goes red for being switched off is a
 * step the founder learns to ignore.
 */
export async function customHostStep(cfg) {
  const ownerId = await journeyOwnerId(cfg);
  const domains = await rest(
    cfg,
    'GET',
    `/custom_domains?owner_id=eq.${ownerId}&state=eq.live&select=id,hostname&limit=1`,
  );
  const domain = domains[0];
  if (!domain) return 'SKIP custom-host — no live domain on the journey account';

  const { title, html } = journeyDocument();
  const share = await api(cfg, 'POST', '/api/v1/shares', {
    html,
    title,
    require_email: false,
    domain_id: domain.id,
  });
  const notes = [];
  try {
    // The address is the assertion: a link created with a domain_id that came
    // back on htmlradar.page would be a link the recipient opens somewhere
    // the customer never agreed to, and it would fetch a healthy 200.
    const expected = `https://${domain.hostname}/`;
    if (!share.url.startsWith(expected)) {
      throw new Error(`share url is ${share.url}, not on ${domain.hostname}`);
    }
    const page = await fetch(share.url);
    const body = await page.text();
    if (page.status !== 200) throw new Error(`${share.url} returned ${page.status}`);
    if (!body.includes(title)) {
      throw new Error(`${share.url} returned 200 but not the document — title missing from body`);
    }
    notes.push(`${domain.hostname} served the document`);
  } finally {
    try {
      await api(cfg, 'POST', `/api/v1/shares/${share.share_id}/revoke`, {});
      notes.push('link revoked');
    } catch (error) {
      notes.push(`CLEANUP FAILED: ${error.message}`);
    }
  }
  return notes.join('; ');
}

/**
 * Step 4 — take yesterday's journey documents away.
 *
 * The v1 API has no delete route, so this goes at the database directly. It
 * is scoped three ways — the journey account's owner_id, a title that starts
 * with `live-journey `, and older than a day — because a service role key
 * pointed at `documents` with a loose filter is how you lose a customer's
 * work. Yesterday rather than now, so a run can never race its own document.
 *
 * Deleting the row is enough: every foreign key onto documents and its
 * children cascades — document_shares (schema/001), document_versions
 * (schema/018), attachments (schema/009), and through the shares to viewers,
 * sessions and section_events (schema/001, /003). The one thing it does NOT
 * remove is the HTML in R2, which the document row pointed at; these are a
 * few hundred bytes each and no API route deletes an object.
 *
 * Cleanup never fails the journey (see warnOnly below): a housekeeping error
 * is not production being broken, and waking the founder for it would teach
 * him to ignore the alert.
 */
export async function cleanupStep(cfg) {
  const ownerId = await journeyOwnerId(cfg);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const removed = await rest(
    cfg,
    'DELETE',
    `/documents?owner_id=eq.${ownerId}&title=like.live-journey%20*&created_at=lt.${cutoff}`,
  );
  return `removed ${removed.length} older journey documents`;
}

// Read by runJourney: a thrown error here is a WARN line, not a FAIL, and
// leaves the exit code alone.
cleanupStep.warnOnly = true;

// PostgREST, with the service role key. `return=representation` is what makes
// a DELETE answer with the rows it removed, which is the only way to count
// them.
async function rest(cfg, method, path) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      Prefer: 'return=representation',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function api(cfg, method, path, body) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Runs every step, times each one, and returns the report. */
export async function runJourney(
  cfg,
  steps = {
    'sign-in': signInStep,
    api: apiStep,
    'custom-host': customHostStep,
    cleanup: cleanupStep,
  },
) {
  const lines = [];
  let firstFailure = null;
  for (const [name, step] of Object.entries(steps)) {
    const started = Date.now();
    try {
      const detail = await step(cfg);
      // A step that had nothing to check says so itself and says why. No
      // timing, because nothing was timed.
      lines.push(
        String(detail).startsWith('SKIP ')
          ? detail
          : `PASS ${name} ${Date.now() - started}ms — ${detail}`,
      );
    } catch (error) {
      const level = step.warnOnly === true ? 'WARN' : 'FAIL';
      lines.push(`${level} ${name} ${Date.now() - started}ms — ${error.message}`);
      if (level === 'FAIL') firstFailure ??= name;
    }
  }
  return { report: lines.join('\n'), firstFailure };
}

async function alert(cfg, firstFailure, report) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.resendKey}`,
      'content-type': 'application/json',
      // Resend's WAF rejects default script user agents.
      'User-Agent': 'htmlradar-live-journey/1.0',
    },
    body: JSON.stringify({
      from: 'HTMLRadar <hello@htmlradar.com>',
      to: [cfg.alertTo],
      subject: `[HTMLRadar] live journey failed: ${firstFailure}`,
      text: report,
    }),
  });
  if (!res.ok) console.error(`alert e-mail failed: ${res.status} ${await res.text()}`);
}

// Only when run as a script, so the test can import the steps above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = config();
  if (!cfg.journeyEmail) {
    console.error(
      'JOURNEY_EMAIL is not set. Set it to the address of a Pro or comped account — a free ' +
        'account runs out of tracked links on the third day (schema/027_free_tier_share_cap.sql).',
    );
    process.exit(1);
  }
  // One retry of the whole journey: a single network blip at 03:17 UTC should
  // not put a red e-mail in the founder's inbox. A second failure is real.
  let { report, firstFailure } = await runJourney(cfg);
  if (firstFailure) ({ report, firstFailure } = await runJourney(cfg));
  console.log(report);
  if (firstFailure) {
    if (cfg.resendKey) await alert(cfg, firstFailure, report);
    process.exit(1);
  }
}
