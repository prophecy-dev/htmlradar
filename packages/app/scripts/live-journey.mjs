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
// Runs daily from .github/workflows/live-journey.yml. Five steps:
//
//   sign-in     — mint a magic-link token with the Supabase admin API and walk
//                 it through /auth/callback and /auth/confirm exactly as a
//                 person opening the e-mail link does, in both steps.
//   api         — create a tracked link, fetch it on the content domain, read
//                 its activity, then revoke it.
//   custom-host — the same journey on the account's own domain, when it has a
//                 live one. Skipped, not failed, when it has none.
//   verify-code — ask a verified-gate link for a code as a reader does, and
//                 prove the mail provider ACCEPTED the message, so a dead
//                 RESEND_API_KEY is noticed within a day.
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
    // The content domain: where a link without a custom domain is served, and
    // the reference copy of the tracker for the skew check below.
    shareBase: trim(source.SHARE_BASE) || 'https://htmlradar.page',
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
  //
  // The confirmation page's policy must be `strict-origin`, NOT `no-referrer`:
  // a browser derives the Origin of a form POST from it, and under no-referrer
  // it posts `Origin: null`, which the login-CSRF check refuses. That took
  // sign-in down on 21 Sep 2026 while this monitor passed, because it set
  // Origin by hand. It no longer does — see the POST below.
  const sealed = (res, what, referrerPolicy) => {
    for (const [header, expected] of [
      ['referrer-policy', referrerPolicy],
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
  sealed(confirm, '/auth/confirm', 'strict-origin');
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

  // Half two: the button, submitted with exactly the headers a browser on
  // that page would send. The Origin is DERIVED from the page's own referrer
  // policy rather than asserted, because asserting it is what let the 21 Sep
  // outage through: under `no-referrer` a browser sends `Origin: null`, and
  // a monitor that hard-codes the real origin proves nothing about browsers.
  // Real-browser coverage of this now lives in the golden journeys.
  const policy = confirm.headers.get('referrer-policy');
  const pageOrigin = new URL(confirmUrl).origin;
  const browserOrigin = policy === 'no-referrer' ? 'null' : pageOrigin;
  const browserReferer =
    policy === 'no-referrer' ? null : policy === 'strict-origin' ? `${pageOrigin}/` : confirmUrl;
  const callback = await fetch(new URL(form.action, confirmUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: browserOrigin,
      ...(browserReferer ? { referer: browserReferer } : {}),
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(form.fields),
    redirect: 'manual',
  });
  const destination = pathOf(callback);
  sealed(callback, 'the POST to /auth/callback', 'no-referrer');

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
    notes.push(await trackerSkew(body, domain.hostname, cfg.shareBase));
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
 * The same tracker address, fetched on the customer's host and on the content
 * domain, compared byte for byte.
 *
 * The failure this catches happened on 21 September 2026. A customer's own
 * domain can sit behind the CUSTOMER's cache, which our deploys cannot purge:
 * htmlradar.page served the new 24,278-byte tracker while decks.draconic.ai
 * kept serving the previous 23,095-byte one for hours, and on that domain a
 * reader who spent 35 seconds was recorded as 0, because the stale script did
 * not read the new page configuration. Nothing noticed. This is what notices.
 *
 * The address is read out of the document itself rather than assumed, so it
 * checks whatever the worker actually pointed this reader at. Two things are
 * asked of it: that the version the worker says it served is the version the
 * document asked for, and that both hosts answer the same address with the
 * same bytes.
 */
export async function trackerSkew(body, hostname, shareBase) {
  const src = /<script src="(\/v1\/tracker[^"]*\.js)"/.exec(body)?.[1];
  if (!src) throw new Error(`${hostname} served the document with no tracker script tag`);
  const read = async (base) => {
    const res = await fetch(`${base}${src}`);
    if (!res.ok) throw new Error(`${base}${src} returned ${res.status}`);
    // The worker hashes what it served and says so here, so this asks the one
    // question that matters — is this the script the page asked for? — of the
    // host the reader actually fetched from.
    return { body: await res.text(), served: res.headers.get('x-htmlradar-tracker-version') };
  };
  const [here, reference] = await Promise.all([read(`https://${hostname}`), read(shareBase)]);
  const referenceHost = new URL(shareBase).host;
  const asked = /\/v1\/tracker\.([a-f0-9]+)\.js$/.exec(src)?.[1];
  if (asked && here.served && here.served !== asked) {
    throw new Error(
      `${hostname}${src} served version ${here.served}, not the ${asked} the document asked for — ` +
        'a cache between us and the reader is serving a stale tracker',
    );
  }
  if (here.body !== reference.body) {
    throw new Error(
      `${hostname}${src} is ${here.body.length} bytes but ${referenceHost}${src} is ` +
        `${reference.body.length} — a cache between us and the reader is serving a stale tracker`,
    );
  }
  return `tracker ${src} identical on ${hostname} and ${referenceHost} (${here.body.length} bytes)`;
}

/**
 * The one reader in this repository that is deliberately NOT on example.com.
 *
 * Every other journey sends its readers to `example.com`, which is reserved by
 * RFC 2606 and reaches nobody — a check must never mail a stranger. This step
 * cannot use it: what it proves is that the mail provider ACCEPTED a message,
 * and nothing is accepted for an address at a domain that does not receive.
 * So it uses the address Resend documents for exactly this, which takes the
 * message and throws it away, with a `+label` so this check has its own
 * address without needing its own account.
 */
const VERIFY_READER = 'delivered+verify-journey@resend.dev';

/** The only domains that reader may live on. Same rule, same reason, as
 *  SINK_DOMAINS in e2e/journeys/lib.ts. */
const SINK_DOMAINS = ['resend.dev'];

/**
 * Refuse to run rather than mail a person.
 *
 * A throw, not a skip: a skip is something a tired person scrolls past, and
 * the cost of getting this wrong is a real code in a real inbox every single
 * day. It guards a constant, so it can only ever fire on somebody editing
 * that constant — which is precisely the edit worth stopping.
 */
export function requireMailSink(address) {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (!SINK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    throw new Error(
      `the verified-gate reader is "${address}", which is not a mail sink. This step makes ` +
        `production send a real code to that address on every run, so it must be one that ` +
        `accepts and discards: ${SINK_DOMAINS.join(', ')} (for example ${VERIFY_READER}).`,
    );
  }
  return address;
}

/**
 * A cookie jar, because the gate's defences are built out of cookies.
 *
 * The verified gate hands the browser a `__Host-hr_vc` challenge on the page
 * that renders the form and signs the form's hidden field over it, so a post
 * without the cookie is refused (see isOwnGatePost and issueGateToken in
 * packages/proxy/src/auth.ts). `__Host-` cookies are HOST-ONLY, which is the
 * other half of why this matters here: the API returns links on the account's
 * default custom domain, so the GET and the POST have to be the same host or
 * the cookie is simply not ours to send.
 */
function readJar(response, jar = new Map()) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    // An expiry with an empty value is a deletion, which a jar honours.
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

const jarHeader = (jar) => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

/**
 * The form on a page, as a browser reads it: where it posts, and every hidden
 * field it carries.
 *
 * Parsed rather than assumed. The previous version of this step posted a
 * hand-written body straight at `/email` with no cookie and no hidden field,
 * which is not what any browser does — and the gate refused it, correctly, with
 * a 401 that read like a product failure. Reading the real form means the step
 * cannot drift away from the page again: if a new hidden field is added
 * tomorrow, this carries it without being told.
 */
export function parseGateForm(html, pageUrl) {
  const form = /<form\b[^>]*\bmethod=["']?post["']?[^>]*>([\s\S]*?)<\/form>/i.exec(html ?? '');
  if (!form) throw new Error('the gate page carried no form to submit');
  const action = /\baction=["']([^"']*)["']/i.exec(form[0])?.[1] ?? '';
  // The gate escapes every value it echoes back, so submitting one verbatim
  // would send something the signature was not made over. Same reason, and the
  // same table, as parseForm above.
  const unescape = (value) =>
    value.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name],
    );
  const fields = {};
  for (const input of form[1].matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    if (!/\btype=["']?hidden["']?/i.test(tag)) continue;
    const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name) fields[name] = unescape(/\bvalue=["']([^"']*)["']/i.exec(tag)?.[1] ?? '');
  }
  return { action: new URL(action, pageUrl).toString(), fields };
}

/**
 * Submit a form the way the sandboxed gate page does.
 *
 * `Origin: null` because every gate page is served inside an opaque-origin
 * sandbox, so a browser posting from one has no origin to name — which
 * isOwnGatePost accepts and which a client sending no Origin at all is refused
 * for. `redirect: manual` because the PLAIN e-mail gate answers 303, and
 * following it would hand back a healthy-looking 200 from the wrong page.
 */
async function submitForm({ action, fields }, jar, extra = {}) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  for (const [name, value] of Object.entries(extra)) body.set(name, value);

  // The two things whose absence made the old step fail against a healthy
  // product. Named here so a future edit that drops either is a JOURNEY BUG
  // with a message that says so, rather than a red step that reads like an
  // outage.
  if (!jar.size) {
    throw new Error(
      'journey bug: posting the gate form with an empty cookie jar. The challenge cookie is ' +
        'set on the page that renders the form and the form is signed over it, so a post ' +
        'without it is refused — carry the cookies from the GET to the POST, on the same host.',
    );
  }
  if (!body.get('t')) {
    throw new Error(
      'journey bug: posting the gate form without its signed "t" field. It is a hidden input ' +
        'in the rendered form and the gate refuses a post without it — parse the form and ' +
        'submit every hidden field it carries.',
    );
  }

  const response = await fetch(action, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'null',
      cookie: jarHeader(jar),
    },
    body,
    redirect: 'manual',
  });
  readJar(response, jar);
  return { status: response.status, html: await response.text() };
}

/**
 * Step 4 — a verification code, all the way to the mail provider.
 *
 * What this catches and nothing else does: a revoked or expired RESEND_API_KEY
 * on the proxy worker. Since the send moved into `ctx.waitUntil`, the reader
 * is answered the same neutral page whether the provider took the message or
 * refused it (sendCodeStep in packages/proxy/src/index.ts). That is
 * deliberate — the old send-failure page was itself an enumeration leak — and
 * it means no screen anywhere can tell you the key is dead. What the provider
 * did is written down in one place only — a `share.code_sent` row when it
 * accepted the message, a `share.code_send_failed` row when it refused — so
 * this step drives a real gate and then reads that table. A pass needs the
 * acceptance row: silence is a failure, because silence is what a hung send
 * and a dropped background execution both look like.
 *
 * Without it, the first person to notice a dead key is a recipient whose code
 * never arrived, and they have no way to tell us.
 *
 * THE KEY IN THE WORKFLOW IS NOT THE KEY UNDER TEST. RESEND_API_KEY in
 * live-journey.yml is this script's own alerting credential; the one being
 * tested is the worker's Cloudflare secret, which nothing in CI can read. That
 * is why this asks production instead of reading an environment variable, and
 * why a missing key is never a reason to skip — it is the failure being
 * looked for.
 */
export async function verifyCodeStep(cfg, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const reader = requireMailSink(VERIFY_READER);

  // The precondition, asked of the database rather than assumed: PostgREST
  // answers 400 for a column it does not know, which is exactly how a
  // deployment older than schema/055 looks. Skipped, not failed, for the
  // reason custom-host skips — a step that goes red because a feature is not
  // there yet is a step the founder learns to ignore. Any OTHER error still
  // fails: an unreachable database is not an absent feature.
  const probe = await rest(cfg, 'GET', '/document_shares?select=verify_email&limit=1').catch(
    (error) => error,
  );
  if (probe instanceof Error) {
    // 400 and only 400: nothing else in that query can be malformed, so a 400
    // is PostgREST saying it has no such column. A 500 or a refused connection
    // is the database being broken, which is a FAIL like any other.
    if (!/returned 400/.test(probe.message)) throw probe;
    return 'SKIP verify-code — document_shares has no verify_email column; schema/055 is not deployed';
  }

  const { title, html } = journeyDocument();
  // THE SECOND PRECONDITION, and it exists because the rollout is deliberately
  // two steps. Everything ships with VERIFY_EMAIL_ENABLED unset, so the app
  // refuses to CREATE a verified link — a 422 saying the installation has no
  // mail credential configured — until the variable is turned on after the
  // worker has been verified on production. Between those two steps this step
  // has nothing to test, which is a skip and not a failure, for the same
  // reason the missing column above is.
  //
  // Narrow on purpose: only that one refusal skips. Any other 422, and every
  // other status, still fails — a link this journey cannot create for any
  // other reason is news.
  let share;
  try {
    share = await api(cfg, 'POST', '/api/v1/shares', {
      html,
      title,
      require_email: true,
      verify_email: true,
      // Exactly one address, and it is the sink. A code is only ever mailed to
      // an address the link permits, so this list is what makes a send happen
      // at all — and it is also what stops one happening to anybody else.
      allowed_emails: [reader],
    });
  } catch (error) {
    if (/not available on this installation/.test(error.message)) {
      return (
        'SKIP verify-code — the app refuses to create a verified link; ' +
        'VERIFY_EMAIL_ENABLED is not turned on yet'
      );
    }
    throw error;
  }
  const slug = new URL(share.url).pathname.split('/').filter(Boolean).pop();
  const notes = [];
  try {
    // EXACTLY WHAT A BROWSER DOES, and the previous version did none of it.
    //
    // It posted a hand-written body straight at `/email` — no GET first, so no
    // challenge cookie, and no `t`, because `t` only exists in the rendered
    // form. The gate refused that, correctly, and the step reported "nobody
    // can be asked for a code on this link", which reads like the product is
    // broken when the product is fine. So: land on the link's own address,
    // keep what it sets, read the form it rendered, and send that back.
    //
    // ON THE LINK'S OWN HOST. `share.url` is whatever host the link was issued
    // on — for this account that is the default custom domain — and the
    // challenge is a `__Host-` cookie, so it belongs to that exact hostname.
    // Fetching the gate on one host and posting to another is the same as
    // having no cookie at all.
    const landing = await fetch(share.url, { redirect: 'manual' });
    const landingHtml = await landing.text();
    const jar = readJar(landing);
    if (landing.status !== 200) {
      throw new Error(`${share.url} answered ${landing.status} instead of the gate`);
    }
    if (!landingHtml.includes('name="email"')) {
      throw new Error(
        `${share.url} answered 200 but not the e-mail gate — the link may not require an address`,
      );
    }

    const emailForm = parseGateForm(landingHtml, share.url);
    const posted = await submitForm(emailForm, jar, { email: reader });
    if (posted.status !== 200 || !posted.html.includes(`/r/${slug}/verify`)) {
      throw new Error(
        `the gate answered ${posted.status} without a code form — ` +
          (posted.status === 303
            ? 'a 303 is the plain e-mail gate letting the reader straight in, so verify_email was ' +
              'not stored or the deployed worker predates the verified gate'
            : posted.status === 401
              ? 'a 401 here is the gate refusing the SUBMISSION rather than the address: the ' +
                'challenge cookie or the signed "t" field did not arrive, which is a journey bug ' +
                'before it is a product one'
              : 'nobody can be asked for a code on this link'),
      );
    }
    // The code form is parsed too, even though nothing is typed into it. It is
    // the cheapest possible proof that the page the reader would type into is
    // a real, submittable form rather than a screen that merely says so.
    const codeForm = parseGateForm(posted.html, share.url);
    if (!codeForm.fields['t'] || !codeForm.fields['email']) {
      throw new Error('the code page carried no signed field, so no code could be submitted');
    }

    notes.push(`${new URL(share.url).host} served the code page`);

    // THE PAGE CANNOT TELL US ANY OF THIS, so the database has to.
    //
    // PROOF, NOT THE ABSENCE OF A COMPLAINT. This used to pass on a code_issued
    // row plus fifteen quiet seconds, which is satisfied by a send that hung,
    // a background execution that was dropped, and a failure whose own log
    // write failed — all of them indistinguishable from a healthy run, and all
    // of them the exact failure this step exists to catch. So the pass
    // condition is now one positive row: `share.code_sent`, written only when
    // the provider ACCEPTED the message (sendCodeStep in
    // packages/proxy/src/index.ts). Its properties carry the share and the
    // recipient's domain, never the address.
    //
    // The send runs after the page is answered, in ctx.waitUntil, so the row
    // lands a moment later. Fifteen seconds in three-second reads is the
    // window — the same order as the five the api step waits for activity, and
    // far inside the job's ten-minute timeout — but acceptance ends the wait
    // early, because there is nothing left to learn once it is there.
    const watchMs = 15000;
    const pollMs = 3000;
    let issued = false;
    let accepted = null;
    for (let read = 0; read <= watchMs / pollMs && !accepted; read += 1) {
      if (read > 0) await sleep(pollMs);
      const rows = await rest(
        cfg,
        'GET',
        `/app_events?properties->>share_id=eq.${share.share_id}` +
          '&event=in.(share.email_submitted,share.code_sent,share.code_send_failed)' +
          '&select=event,properties&order=timestamp.desc&limit=20',
      );
      const refused = rows.find((row) => row.event === 'share.code_send_failed');
      if (refused) {
        throw new Error(
          `the mail provider did not accept the code (${refused.properties?.reason ?? 'no reason recorded'}) — ` +
            'RESEND_API_KEY on the proxy worker is the thing to look at: it is a Cloudflare secret ' +
            'on the worker, NOT the key this workflow carries, and a revoked or expired one looks ' +
            'exactly like this while every page still answers 200',
        );
      }
      const result = rows.find((row) => row.event === 'share.email_submitted')?.properties?.result;
      // A verdict other than code_issued means no code was stored, so no send
      // was ever started and waiting out the window proves nothing.
      if (result && result !== 'code_issued') {
        throw new Error(
          `the gate recorded "${result}" rather than code_issued — no code was stored for ${slug}, ` +
            'so nothing was sent to anybody',
        );
      }
      issued ||= result === 'code_issued';
      accepted = rows.find((row) => row.event === 'share.code_sent') ?? null;
    }
    if (!accepted) {
      throw new Error(
        `no share.code_sent row for share ${share.share_id} in ${watchMs}ms — ` +
          (issued
            ? 'the code was stored but the mail provider never accepted the message, so nothing ' +
              'reached the reader. RESEND_API_KEY on the proxy worker is the thing to look at: it ' +
              'is a Cloudflare secret on the worker, NOT the key this workflow carries, and a ' +
              'revoked, expired or quota-exhausted one looks exactly like this while every page ' +
              'still answers 200'
            : 'the code page was served but nothing was recorded at all, so the worker could not ' +
              'reach the database and a refused send would go unnoticed'),
      );
    }
    notes.push(
      `the provider accepted the code for ${accepted.properties?.email_domain ?? 'an unrecorded domain'}`,
    );
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
 * Step 5 — take yesterday's journey documents away.
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
    'verify-code': verifyCodeStep,
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
