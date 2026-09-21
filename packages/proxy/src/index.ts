// Worker entry.
//
// HOSTS. Recipient documents are served from their own registrable domain,
// `SHARE_HOST` (htmlradar.page in production). A customer's HTML therefore
// never shares an origin with the application's session cookies, and a
// phishing page pushed through us cannot wear the primary domain's
// certificate or its reputation with the blocklists.
//
// `LEGACY_HOSTS` (htmlradar.com in production) is where every link sent
// before the move points. Those links keep working — see the legacy-host block
// at the top of handleRequest.
//
// Routes (on SHARE_HOST, and on a legacy host for POST only):
//   GET  /r/{slug}            serves the document, gates as needed
//   POST /r/{slug}/auth       password submission
//   POST /r/{slug}/email      email submission for allow-list shares
//   POST /r/{slug}/verify     the six-digit code, on a link that asks for one
//   GET  /r/{slug}/report     the recipient's abuse report form
//   POST /r/{slug}/report     the report itself
//   GET  /r/{slug}/frame      the document, inside the trust wrapper's frame
//   GET  /r/{slug}/print      the document unframed, behind a signed grant
//   GET  /r/{slug}/m/{att_id} downloads a supporting-material attachment
//   GET  /r/_doc/{doc_id}     sender-side raw-doc preview (HMAC-gated)
//   GET  /v1/tracker.js       the tracker, first-party to the document
//   GET  /v1/tracker.{v}.js   the same tracker at its content-derived address
//   GET  /robots.txt          Disallow: / — no host this worker serves is a website
//   GET  /.well-known/htmlradar-domain-check
//                             which claim a hostname belongs to, and the only
//                             thing a claimed-but-not-live hostname answers
//
// CUSTOMERS' OWN DOMAINS (schema/052). A Pro customer can point their own
// subdomain at us, and a share issued on it stores `custom_domain_id`. Such a
// share is served on that exact hostname and on no other — not on the apex,
// which does not redirect to it either. The hostname's claim is read fresh on
// every request; nothing about a customer's domain is cached.
//
// THE TRUST WRAPPER. With TRUST_WRAPPER off — its shipped state — /r/{slug}
// answers exactly as it always has and /frame and /print are not-found. Turned
// on for a slug, /r/{slug} instead returns HTMLRadar's own thin page (see
// wrapper.ts) with the document in a frame above a strip the sender cannot
// remove, cover or intercept. The design is
// docs/workstreams/content-domain/TRUST-LAYER-DESIGN-2026-08-31.md.
//
// WHICH HOST SERVES WHAT. Every share carries a stored hostname, `host_handle`
// (schema/043), and routing follows THAT value rather than the owner's current
// handle, so no link that has already been sent ever moves. See resolveHost
// and enforceStoredHost below for the design's five rules; the check runs on
// every route carrying a share identifier, not only the document route.
//
// Anything else on SHARE_HOST is a 404, and every response carries
// X-Robots-Tag: noindex (see withNoIndex).
//
// The share route also carries the recipient's own switch for read tracking:
//   GET  /r/{slug}?optout=1|0 asks the question and mints a token
//   POST /r/{slug}            with `optout` + `token` writes the cookie
// See handleOptOutSubmit below for why the GET must not write.
//
// Gate order: password → allow-list email → content. Each gate issues an
// HMAC-signed cookie on success (see auth.ts); subsequent requests with the
// cookie skip the gate. The document body is only ever streamed when all
// applicable gates have passed.

import type { Env } from './env.js';
import {
  getShareBySlug,
  getCustomDomainByHostname,
  getDocument,
  reportAbuse,
  getAttachment,
  listAttachmentsForDocument,
  logAttachmentDownload,
  logAppEvent,
  getViewerIdByShareEmail,
  verifySharePassword,
  notifyDisabledAttempt,
  issueVerificationCode,
  checkVerificationCode,
  UpstreamError,
  type Attachment,
  type Share,
} from './supabase.js';
import {
  deriveReaderId,
  hashReporterAddress,
  issueAuthCookie,
  issueEmailCookie,
  issueOptOutToken,
  issuePrintGrant,
  isTrackingOptedOut,
  optOutNeedsMigration,
  newOptOutChallenge,
  newPrintSecret,
  newReaderSecret,
  optOutChallengeCookie,
  printCookie,
  readerCookie,
  readOptOutChallenge,
  readPrintCookie,
  readReaderCookie,
  verifyAuthCookie,
  verifyEmailCookie,
  verifyOptOutToken,
  verifyOwnerDocPreviewToken,
  verifyOwnerPreviewToken,
  verifyPrintGrant,
  hashVerificationCode,
  isOwnGatePost,
  issueGateToken,
  verifyGateToken,
  issueVerifiedCookie,
  newVerificationCode,
  newVerifyChallenge,
  readVerifyChallenge,
  verifyChallengeCookie,
  verifyVerifiedCookie,
  VERIFY_CHALLENGE_CLEAR_COOKIE,
  OPT_OUT_CHALLENGE_CLEAR_COOKIE,
  OPT_OUT_CLEAR_COOKIES,
  OPT_OUT_COOKIE,
  READER_CLEAR_COOKIE,
} from './auth.js';
import { fetchDocumentHtml } from './fetch-html.js';
import { geoFromRequest, injectTracker } from './inject.js';
import { TRACKER_VERSION } from './tracker-version.js';
import { documentCsp, wrapperPage, FRAME_SANDBOX, OWN_PAGE_HEADER } from './wrapper.js';
import {
  emailGateForm,
  expired,
  notFound,
  optOutConfirm,
  passwordForm,
  reportForm,
  reportSent,
  revoked,
  sourceUnreachable,
  verifyCodeForm,
  NOTE_MAX_LENGTH,
  REPORT_REASONS,
} from './responses.js';
import { sendVerificationCode } from './mail.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// THE TIMING FLOOR, and what it is for NOW.
//
// It used to hide the mail provider. The first draft awaited the send inside
// this floor, which bought two problems and the orchestrator rejected both: a
// send slower than the floor made the permitted path measurably slower, and a
// refused send produced a page that existed only on the permitted path. Either
// one answers "is this address on the list?", which is the single question
// this gate must never answer.
//
// THE SEND NO LONGER BLOCKS THE REPLY. It runs in ctx.waitUntil, after the
// response has gone (see sendCodeStep), so the reader is answered at the same
// moment whether a message follows or not, and there is no send-failure page
// left to be a tell. What is left inside the floor is the database call, and
// BOTH paths make that identical call — schema/055's issue function does not
// know the allow-list and is not asked (test N).
//
// So the floor's job is now narrow: it flattens whatever residual asymmetry
// the in-memory allow-list scan and the waitUntil registration could add, and
// it is insurance against a future edit putting real work back on one branch
// only.
//
// MEASURED, NOT GUESSED. Two numbers, taken 21 September 2026:
//
//   * End to end through this handler with the floor removed, against the
//     local harness: 2.3ms median for a permitted address and 1.8ms for a
//     refused one, over 25 pairs. The refused path's own maximum was the
//     higher of the two, so what is left between the branches is noise rather
//     than signal — which is the point of moving the send out.
//   * One real PostgREST round trip to the production database, which is the
//     only thing still under the floor: 65ms median, with one 663ms outlier
//     in fifteen. Taken from a laptop, so it is a pessimistic stand-in for a
//     worker sitting much closer to the database.
//
// 750 sits above even that outlier, so in practice every reader is answered at
// the same moment on the clock rather than at a moment that varies with the
// database. It is worth saying that the floor being exceeded would no longer
// be a leak — both branches make the identical call, so a slow database slows
// them equally — but a constant answer is a stronger property than an equal
// one, and three-quarters of a second, once, is a price a reader will not
// notice.
const GATE_FLOOR_MS = 750;
// The floor a run actually uses. Production leaves the var unset and gets the
// number above; the unit suite and `wrangler dev` set it to 0, because waiting
// is the one behaviour on this path that has no meaning without a network
// between the two ends, and paying for it on every assertion buys nothing.
const gateFloorMs = (env: Env): number => {
  const raw = Number.parseInt(env.GATE_FLOOR_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : GATE_FLOOR_MS;
};
// Checking a code touches no third party, so this floor exists only to flatten
// the difference between "no such code" and "wrong code" — which the database
// function already equalises by doing the same comparison work either way. Kept
// small: it is belt to that brace, not the defence.
const VERIFY_FLOOR_MS = 250;
// How long the provider gets before the send is called a failure. Generous
// enough that a slow but working provider is not written off, short enough
// that a hung connection cannot sit inside waitUntil until the worker is torn
// down with nothing recorded either way.
const SEND_TIMEOUT_MS = 10_000;

/** Waits until `ms` have passed since `started`. Returns at once if they have. */
async function padTo(started: number, ms: number): Promise<void> {
  const left = ms - (Date.now() - started);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}

// Defaults, so `wrangler dev` and the tests behave without configuration.
// Production values are the [vars] block in wrangler.toml.
const SHARE_HOST_DEFAULT = 'htmlradar.page';
const LEGACY_HOSTS_DEFAULT = 'htmlradar.com';

const shareHostOf = (env: Env): string => env.SHARE_HOST ?? SHARE_HOST_DEFAULT;

// Where the injected <script> points, and the paths this worker answers it on.
// Relative, so the tracker is always first-party to the document that loads
// it: same host, no second DNS lookup, and nothing for a third-party script
// blocker to recognise. env.TRACKER_URL is the upstream this worker fetches
// it from (Cloudflare Pages, on the application domain) — one upstream for
// every address below, so the bytes served are always the current ones.
//
// TWO ADDRESSES, AND THE DIFFERENCE IS THE CACHE.
//
// The fixed address is what self-hosters embed by hand and what pages opened
// before a deploy already hold. It keeps working forever, on a five-minute
// lifetime so a stale copy can never live long.
//
// The versioned address is what every document we serve points at. Its
// version segment is the tracker bundle's own hash (see
// scripts/tracker-version.mjs), so it changes exactly when the script's bytes
// change. That is the fix for the 21 September 2026 defect: a customer domain
// behind the CUSTOMER's cache — one we cannot purge — kept handing readers a
// four-hour-old script while the new page configuration expected the new one,
// and a silent reader recorded 0 seconds. A new address is an address no cache
// holds yet, so version skew between page and script cannot happen. Because
// its contents can never change, it is cached for a year, immutably — but
// only once the worker has hashed what it fetched and confirmed those bytes
// really are that version (see the route below).
//
// A version segment we do not recognise — an older deploy's address in a
// document a browser is still holding, or a request in flight across a deploy
// — serves the CURRENT script rather than 404ing, because losing tracking is
// worse than a redundant fetch. Short lifetime, so nothing pins it.
const TRACKER_PATH = '/v1/tracker.js';
const TRACKER_VERSIONED_PATH = `/v1/tracker.${TRACKER_VERSION}.js`;
const TRACKER_PATH_RE = /^\/v1\/tracker(?:\.([a-z0-9]+))?\.js$/;

/**
 * Which address a document served on this hostname points at.
 *
 * The versioned one everywhere this worker owns the whole hostname — the share
 * host, handle hosts and customers' own domains, which is exactly where a
 * cache we cannot purge sits. The ONE exception is the application domain
 * itself: only /r/* is routed to this worker there, so /v1/ is answered by
 * Cloudflare Pages from the fixed address and nothing else resolves. Reading
 * it off TRACKER_URL rather than naming htmlradar.com keeps a self-hoster's
 * single-domain install correct too.
 *
 * Relative either way, so the tracker stays first-party to the document and
 * nothing crosses an origin.
 */
// The version of the bytes actually served, on every tracker response. The
// daily live journey reads it to prove the script a document points at is the
// script it got (packages/app/scripts/live-journey.mjs).
const TRACKER_VERSION_HEADER = 'X-HTMLRadar-Tracker-Version';

/** The version segment, computed the same way scripts/tracker-version.mjs does. */
async function sha256Prefix(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function trackerPathFor(hostname: string, env: Env): string {
  const appHost = new URL(env.TRACKER_URL).hostname.toLowerCase();
  return hostname.toLowerCase() === appHost ? TRACKER_PATH : TRACKER_VERSIONED_PATH;
}

const isLocal = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

// The hostname this worker served before the content domain existed, and the
// one every link sent before the move still points at.
//
// TWO SEPARATE QUESTIONS, and conflating them is what broke the rollback in
// the first draft of this change. `LEGACY_HOSTS` answers "does this host
// REDIRECT to the share host?" — emptying it is the documented rollback of the
// 31 August switch, after which both hosts serve documents and neither one
// redirects. This constant answers the other question, "is this a host we
// serve at all?", and it is not configurable, because the answer for
// htmlradar.com is yes for as long as those links are in circulation.
//
// Without it, removing htmlradar.com from LEGACY_HOSTS would have made every
// link sent before the move a 404 rather than a document, which is an outage
// dressed as a rollback.
//
// It is the apex's equal for routing and for nothing else: a share issued on
// a customer's own domain is still never served here (see enforceStoredHost).
const ORIGIN_HOST = 'htmlradar.com';

function isLegacyHost(hostname: string, env: Env): boolean {
  return (env.LEGACY_HOSTS ?? LEGACY_HOSTS_DEFAULT)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

/**
 * The move off the primary domain, for links that were already sent.
 *
 * A GET or HEAD on a legacy host is answered with a permanent redirect to the
 * same path and query on SHARE_HOST, so a recipient who kept an old email
 * still opens the document — one extra hop, nothing else changes.
 *
 * A POST is served in place instead. Three things post to /r/: the password
 * gate, the email gate, and the opt-out confirmation. A 301 turns a POST into
 * a GET and drops the body, so redirecting them would break the gate for
 * anyone whose tab was already open when the switch happened. Serving them
 * where they were sent keeps those tabs working.
 *
 * WINDOW: this in-place POST handling only matters while pre-switch tabs are
 * still open. Thirty days after the switch — from 30 September 2026 — it can
 * be deleted, and the redirect can cover every method. The redirect itself
 * stays for as long as old links are in circulation, which is indefinitely.
 *
 * A recipient who submits a gate on a legacy host after the switch sets the
 * cookie on that host, is redirected to SHARE_HOST on the following GET, and
 * is asked once more there. One retype, not a dead end.
 */

// Every response this worker produces is a recipient-facing page for somebody
// else's document, and none of it should ever appear in a search result.
// robots.txt asks crawlers not to fetch /r/, but robots.txt only governs
// crawling — a memorable address found somewhere else (a forwarded email, a
// pasted link in a public channel) can still be indexed from that reference
// alone. X-Robots-Tag is the instruction that actually removes it. Applied
// here, once, rather than in responses.ts, so no future response shape can be
// added without it.
function withNoIndex(res: Response, env: Env): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  // Deploy verification reads this back from the live route to prove the
  // commit it just uploaded is the one the edge serves.
  //
  // Not on the domain-check probe. That response is content-free on purpose:
  // it is the one thing a hostname answers before anybody has proved they own
  // it, and it should name the claim being checked and nothing else about us.
  if (!out.headers.has(DOMAIN_CHECK_HEADER)) {
    out.headers.set('X-HTMLRadar-Version', env.GIT_SHA ?? 'dev');
  }

  // Sandbox every proxy response into an opaque origin.
  //
  // Customer-uploaded HTML is served from this worker on the same origin as
  // the application, and inject.ts intentionally does not constrain
  // script-src, because customer documents legitimately carry their own
  // scripts. Omitting allow-same-origin gives those documents an opaque
  // origin, so they cannot reach application storage or make same-origin
  // requests to it. Their own scripts still run.
  //
  // Interim hardening. Recipient documents should move to an origin that
  // holds no application cookies.
  //
  // THE ONE EXEMPTION is the trust wrapper, HTMLRadar's own page, which holds
  // no customer HTML and must keep a real origin: an opaque origin has no
  // registrable domain, and the browser decides a request's "same-site"
  // question from the top-level document's site, so a sandboxed wrapper would
  // make its own frame request cross-site and the gate cookies would not be
  // sent with it. wrapper.ts sets the marker; it never reaches the reader.
  //
  // WHAT THIS SETS is the sandbox ALONE, and only on a response that carries
  // no policy of its own: the gate, opt-out and error pages, attachment
  // downloads, the tracker. Those pages must NOT get form-action 'none' —
  // they are HTMLRadar's own forms and they post back. A response carrying
  // customer HTML has already set the whole merged policy through
  // documentCsp, which contains this same sandbox; appending a second header
  // here is what let the two halves of the document's defence be set in two
  // places and diverge. tests/document-csp.test.ts walks every route and
  // asserts what each one ends up with, which is now the guarantee that no
  // future response shape escapes the sandbox.
  if (out.headers.has(OWN_PAGE_HEADER)) {
    out.headers.delete(OWN_PAGE_HEADER);
  } else if (!out.headers.has('Content-Security-Policy')) {
    out.headers.set('Content-Security-Policy', `sandbox ${FRAME_SANDBOX}`);
  }
  return out;
}

/**
 * Which hostname this request arrived on, in the only shapes that mean
 * anything: the apex, exactly one handle label under it, a customer's own
 * domain, a customer's domain that has been claimed but is not serving yet,
 * or a shape we refuse.
 *
 * Rule 4 of the design's routing: hostnames are accepted only as the apex, one
 * handle label, or a hostname a customer has claimed. Extra levels, malformed
 * labels and hostnames nobody has claimed get the same not-found response as
 * an unknown handle and a mismatched owner, so probing reveals nothing about
 * who exists.
 *
 * THE FALLBACK THAT TREATED AN UNRELATED HOSTNAME AS THE APEX IS GONE. It was
 * safe only while the route covered the apex alone. With the route widened to
 * the whole zone (see wrangler.toml) every hostname Cloudflare for SaaS points
 * at us arrives here, and "unknown host behaves like the apex" would mean any
 * such hostname — including one whose claim we retired minutes ago — serving
 * every apex share. Unknown is now refused. What is still the apex: a legacy
 * host being served in place, ORIGIN_HOST whatever the redirect setting says,
 * and localhost under `wrangler dev`. Nothing else is.
 *
 * Async because the custom shape is a database read. There is no cache: see
 * getCustomDomainByHostname.
 */
type HostKind =
  | { kind: 'apex' }
  | { kind: 'handle'; handle: string }
  // A hostname whose claim is live: it serves that owner's custom shares.
  | { kind: 'custom'; domainId: string; ownerId: string }
  // A hostname whose claim exists but is pending or disconnected. It serves
  // nothing at all except the domain-check probe below, which is what lets a
  // pending claim be activated without a deadlock (Astra's review).
  | { kind: 'claim'; domainId: string }
  | { kind: 'refused' };

const APEX: HostKind = { kind: 'apex' };
const REFUSED: HostKind = { kind: 'refused' };

// The handle format, matching the check constraint in schema/043 exactly:
// three to twenty-four characters, no leading or trailing hyphen, no
// consecutive hyphens, ASCII only. A hostname with an extra level fails it on
// the dot, which is what makes rule 4 fall out of the same test.
const HANDLE_LABEL = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;

// Reserved infrastructure: `customers.{SHARE_HOST}` is the fallback origin
// every customer's CNAME points at. It is a valid handle label, so without
// this it would be served as a handle host. It answers nothing, ever — not a
// share, not robots.txt, not the probe.
const FALLBACK_ORIGIN_LABEL = 'customers';

// The one path a claimed-but-not-live hostname answers, and the one the
// application and the monitor probe to decide a claim is really pointed at us.
// Content-free by design: it says only which claim this hostname belongs to,
// which the prober already knows.
const DOMAIN_CHECK_PATH = '/.well-known/htmlradar-domain-check';
const DOMAIN_CHECK_HEADER = 'x-htmlradar-domain';

async function resolveHost(hostname: string, env: Env): Promise<HostKind> {
  const apex = shareHostOf(env).toLowerCase();
  const host = hostname.toLowerCase();
  if (host === apex) return APEX;
  if (isLegacyHost(host, env) || host === ORIGIN_HOST || isLocal(host)) return APEX;

  if (host.endsWith(`.${apex}`)) {
    const label = host.slice(0, -(apex.length + 1));
    if (label === FALLBACK_ORIGIN_LABEL) return REFUSED;
    if (!HANDLE_LABEL.test(label) || label.includes('--')) return REFUSED;
    return { kind: 'handle', handle: label };
  }

  const domain = await getCustomDomainByHostname(env, host);
  if (!domain) return REFUSED;
  if (domain.state === 'live') {
    return { kind: 'custom', domainId: domain.id, ownerId: domain.owner_id };
  }
  if (domain.state === 'pending' || domain.state === 'disconnected') {
    return { kind: 'claim', domainId: domain.id };
  }
  return REFUSED;
}

// The probe. One line of text, no redirect, no caching: the application's
// `probe()` and the monitor's hourly re-check require this exact body and
// header for this exact claim, so a parked page or a stranger's server on the
// same hostname cannot be mistaken for us.
const domainCheck = (domainId: string): Response =>
  new Response(`htmlradar-domain:${domainId}`, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      [DOMAIN_CHECK_HEADER]: domainId,
      'Cache-Control': 'no-store',
    },
  });

/**
 * The stored-hostname check, run on every route carrying a share identifier —
 * the gates, the report form, the frame, print and attachment downloads — and
 * not only on the document route, which would leave the others as ways to
 * reach a share from the wrong host.
 *
 * Returns a response when the request must be answered here, and null when it
 * may continue. The three rules it enforces:
 *
 *   1. Apex request, share stores no hostname: served in place. These are the
 *      links already sent, and they work forever — no redirect, no repeated
 *      gate. Every share that exists today is one of these.
 *   2. Apex request, share stores a hostname: permanent redirect to it. Those
 *      links were only ever printed in handle form, so no session is
 *      disturbed. A method that carries a body redirects with 308, never 301,
 *      which would turn a gate submission into a GET and drop what was typed.
 *      This rule alone sits behind TRUST_HANDLES — the same single setting
 *      that lets the application print handle links — so a rollback stops the
 *      redirects and the new links together. Off, such a share is simply
 *      served in place on the apex.
 *   3. A handle host that does not match the share's stored hostname: not
 *      found, and identically so. Without this an abuser could have their own
 *      document served on a rival's host, or on microsoft.htmlradar.page, and
 *      poison a name they do not own.
 *   4. A share issued on a customer's own domain is served on that exact
 *      hostname and NOWHERE else — not on the apex, not on a handle host, not
 *      on another customer's domain. No redirect from the apex either: rule 2
 *      moves a handle link because the apex form of it was never printed, but
 *      a redirect from the apex to a customer's domain would let anybody turn
 *      an htmlradar.page address into an address that wears the customer's
 *      name. The apex simply does not have it.
 *   5. A customer's domain serves only the shares that stored it. Everything
 *      else — an apex share, a handle share, another customer's share — is the
 *      same not-found.
 */
function enforceStoredHost(
  host: HostKind,
  share: Share,
  url: URL,
  method: string,
  env: Env,
): Response | null {
  if (host.kind === 'refused' || host.kind === 'claim') return notFound();
  if (host.kind === 'custom') {
    // Three things must agree, and they come from two separate reads: the
    // hostname's own claim row (resolveHost, read this request) and the
    // domain columns joined onto the share (share_lookup, read this request).
    // The state is checked on both sides so a claim that stopped being live
    // between the two reads answers not-found rather than serving.
    const ok =
      !!share.custom_domain_id &&
      share.custom_domain_id === host.domainId &&
      share.custom_domain_owner_id === host.ownerId &&
      share.owner_id === host.ownerId &&
      share.custom_domain_state === 'live';
    return ok ? null : notFound();
  }
  if (host.kind === 'handle') {
    if (share.custom_domain_id) return notFound();
    return share.host_handle === host.handle ? null : notFound();
  }
  // The apex.
  if (share.custom_domain_id) return notFound();
  if (!share.host_handle || !handleLinksEnabled(env)) return null;
  const target = new URL(url.toString());
  target.hostname = `${share.host_handle}.${shareHostOf(env)}`;
  target.protocol = 'https:';
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;
  return new Response(null, { status, headers: { Location: target.toString() } });
}

// Back to the badge. Every refusal on the frame and print routes lands here
// rather than dead-ending, because the wrapper is where a live grant is minted
// and where the strip is. 302, not 301: the frame address is not permanently
// the wrapper, it is only not one right now.
const toWrapper = (slug: string): Response =>
  new Response(null, { status: 302, headers: { Location: `/r/${slug}` } });

/**
 * The trust layer's gate, and the whole of its rollback.
 *
 * Empty or unset is off, and off means the deployed behaviour is what it was
 * before any of this existed: /r/{slug} serves the document, /frame and
 * /print are not-found. A comma-separated list turns it on for those slugs
 * alone, which is how it reaches QA shares first; "*" turns it on for
 * everybody.
 */
/**
 * Gate 2: are handle links switched on?
 *
 * Only rule 2 — the apex-to-handle redirect — asks. Rules 1, 3 and 4 are the
 * safety rules (a share is served only on the hostname it stores, and every
 * mismatch is the identical not-found), and gating those would be gating the
 * thing that stops one customer's document being served on another's host.
 * They stay on in every state.
 *
 * ONE SETTING REACHES BOTH HALVES: the same TRUST_HANDLES line in
 * wrangler.toml is read into the application build as
 * NEXT_PUBLIC_TRUST_HANDLES, where it gates allocating handles and stamping
 * them on new shares. Sol's ninth finding — the redirects and the newly
 * generated links must switch off together.
 */
function handleLinksEnabled(env: Env): boolean {
  return (env.TRUST_HANDLES ?? '').trim() === '*';
}

function wrapperEnabled(slug: string, env: Env): boolean {
  const setting = (env.TRUST_WRAPPER ?? '').trim();
  if (!setting) return false;
  if (setting === '*') return true;
  return setting
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(slug);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withNoIndex(await handleRequest(request, env, ctx), env);
    } catch (err) {
      // A transient Supabase failure must not masquerade as a deleted/missing
      // share ("this link doesn't open anything") — show the recipient the
      // try-again page. Genuine bugs still surface as a 500.
      if (err instanceof UpstreamError) return withNoIndex(sourceUnreachable(), env);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // Two reasons to send the reader somewhere else, answered in one hop.
  //
  // Wrong host: a legacy host only redirects, and only for methods that
  // survive a redirect (see the note above).
  //
  // Wrong scheme: a recipient document must never travel in the clear. The
  // .page top-level domain is HTTPS-only by browser policy anyway, so in
  // production this fires only for a client that asked for http:// itself.
  // `wrangler dev` serves plain HTTP on localhost, which is exempt so local
  // runs behave.
  const wrongHost = isLegacyHost(url.hostname, env) && request.method !== 'POST';
  if (wrongHost) url.hostname = shareHostOf(env);
  const wrongScheme = url.protocol === 'http:' && !isLocal(url.hostname);
  if (wrongScheme) url.protocol = 'https:';
  if (wrongHost || wrongScheme) {
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }

  // Rule 4, before anything else looks at the path: a hostname that is not the
  // apex, not one well-formed handle label under it, and not a hostname some
  // customer has claimed answers the standard not-found, whatever was asked
  // for. Applied here so an extra hostname level, or a hostname nobody owns,
  // cannot reach a single route, share-bearing or not.
  const host = await resolveHost(url.hostname, env);
  if (host.kind === 'refused') return notFound();

  // The activation probe, above everything else a claimed hostname may do.
  //
  // A claim starts pending, and until it is live its hostname serves nothing —
  // which would deadlock activation, because the only way to know the
  // customer's CNAME really reaches us is to fetch something from it. This
  // path is that something, and it is all a pending or disconnected claim
  // answers. It answers on a live claim too: the monitor re-probes a live
  // domain every hour, and a live domain must not fail its own check.
  if (url.pathname === DOMAIN_CHECK_PATH) {
    if (host.kind !== 'custom' && host.kind !== 'claim') return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
    return domainCheck(host.domainId);
  }

  // Every host this worker serves carries documents, not a website, and
  // nothing on any of them should ever be crawled. Answered on customer
  // hostnames too — that is where a crawler is likeliest to find its way in,
  // because a customer's own domain has links pointing at it that ours does
  // not. NOT answered on a hostname we do not serve: a refused host is a
  // blanket 404, which is what keeps every refusal indistinguishable.
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // A claimed hostname that is not live serves nothing else: not the tracker,
  // not a share, not an answer that admits a share exists. sitemap.xml has
  // never been a route on any host and falls through to the same 404.
  if (host.kind === 'claim') return notFound();

  const trackerMatch = TRACKER_PATH_RE.exec(url.pathname);
  if (trackerMatch) {
    const upstream = await fetch(env.TRACKER_URL);
    const body = upstream.ok ? await upstream.arrayBuffer() : null;
    const headers = new Headers(upstream.headers);
    // Buffered above, so the length the upstream declared and any encoding it
    // applied no longer describe what leaves here. The runtime sets both.
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');

    // NEVER PIN BYTES YOU HAVE NOT VERIFIED.
    //
    // A year and `immutable` is a promise that these exact bytes belong at
    // this exact address, and a browser that accepts it will not ask again —
    // neither will a customer's cache, which we cannot purge. So the promise
    // is made about the bytes in hand, not about the address that asked for
    // them: the response is hashed and pinned only when its own hash is the
    // version in the address.
    //
    // The hole this closes is not hypothetical. The worker and the
    // application deploy in separate steps, and our own edge cache is purged
    // in a later one still (deploy.yml, "Purge Cloudflare edge cache"). For
    // the seconds or minutes in between, a request to this deploy's versioned
    // address can be answered by the PREVIOUS script — and pinning that would
    // have made today's defect permanent for that reader, unfixable until the
    // script changed again.
    //
    // Anything unverified still serves, on the five-minute lifetime: a reader
    // who arrives early gets a working script and the right one within
    // minutes, and the correct bytes are pinned the moment they exist.
    const served = body ? await sha256Prefix(body) : null;
    const verified = served !== null && served === trackerMatch[1];
    headers.set(
      'Cache-Control',
      verified ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate',
    );
    // What the bytes really are, for the daily journey and for anyone reading
    // a response by hand. It is the answer to "is this the script the page
    // asked for?", which no other header on this response can be asked.
    if (served) headers.set(TRACKER_VERSION_HEADER, served);
    return new Response(body, { status: upstream.status, headers });
  }

  // Sender's "Preview document" — minted by /docs/[id] in the app when
  // the doc owner clicks the Preview button. Bound to a doc_id (not a
  // slug); no share lookup, no gates, no tracker injection. Lets the
  // sender verify what they uploaded before creating any share.
  //
  // Path: /r/_doc/{doc_id}?owner_doc_preview={token}
  //
  // The leading underscore on `_doc` is the discriminator from a share
  // slug (which is `{adjective}-{noun}-{hex}` and can never start with
  // an underscore). Keeps the route table flat without a separate /p/
  // prefix that would confuse the recipient namespace.
  const docPreviewMatch = /^\/r\/_doc\/([a-f0-9-]{8,})\/?$/i.exec(url.pathname);
  if (docPreviewMatch) {
    // THE APEX ONLY, and every other host is the standard not-found.
    //
    // This route is sender-side. It carries no share, so it has no stored
    // hostname to check against, and it serves the raw upload with no gate and
    // no tracker. A valid token is bound to a document and to nothing else —
    // so on any host but the apex it was a way to put a document on a hostname
    // no share ever chose: another customer's handle host, or a customer's own
    // domain, wearing their name over somebody else's upload.
    //
    // The apex is where the application mints these tokens and where the
    // Preview button sends the sender, so nothing legitimate loses anything.
    if (host.kind !== 'apex') return notFound();
    const docId = docPreviewMatch[1]!;
    const previewToken = url.searchParams.get('owner_doc_preview');
    const tokenValid = previewToken
      ? await verifyOwnerDocPreviewToken(previewToken, docId, env.SESSION_SECRET)
      : false;
    if (!tokenValid) return notFound();

    const doc = await getDocument(env, docId);
    if (!doc || doc.deleted_at) return notFound();
    const htmlResp = await fetchDocumentHtml(doc, env);
    if (!htmlResp) return sourceUnreachable();
    const body = await htmlResp.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // The recipient path sets these via injectTracker; mirror the
        // framing/sniffing protections on the owner-preview response so
        // arbitrary sender HTML can't be framed or content-sniffed. The CSP
        // is the same builder that path uses, so the sender's raw upload is
        // not the one place a hosted document's forms may still submit.
        'Content-Security-Policy': documentCsp(false),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  // Recipient download of a supporting-material attachment.
  //   GET /r/{slug}/m/{attachment_id}
  // Gate sequence (must pass IN ORDER, just like the doc route):
  //   1. share exists, not revoked, not expired
  //   2. password cookie (if require_password)
  //   3. email cookie (if require_email)
  //   4. attachment exists AND attachment.document_id matches the
  //      share's document_id (defends against cross-doc enumeration)
  // Note: attachments are no longer gated by lock_deck (2026-05-19
  // Design decision — if the sender uploaded files, recipients can
  // download them; lock_deck only controls deck save/print).
  // On success: stream the R2 object with Content-Disposition: attachment
  // and a sanitised filename, log the download event, return.
  const downloadMatch = /^\/r\/([a-z0-9-]+)\/m\/([a-f0-9-]{8,})\/?$/i.exec(url.pathname);
  if (downloadMatch) {
    const slug = downloadMatch[1]!.toLowerCase();
    const attachmentId = downloadMatch[2]!;
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return handleAttachmentDownload(request, slug, attachmentId, host, env);
  }

  const match = /^\/r\/([a-z0-9-]+)(?:\/(auth|email|verify|report|frame|print))?\/?$/i.exec(
    url.pathname,
  );
  if (!match) return new Response('Not Found', { status: 404 });
  // Lowercased rather than redirected to the canonical form. Every stored
  // slug is lowercase (the format is enforced by the validate_share_slug
  // trigger, schema/033) while the route regex is case-insensitive and the
  // PostgREST lookup is not, so `/r/Acme-Proposal` retyped off a printed page
  // or an email client that title-cased it would otherwise 404.
  //
  // A redirect would canonicalise the URL, but it costs a round trip and the
  // two POST sub-routes (/auth, /email) would need 307/308 to keep their
  // method — extra machinery for a cosmetic gain. Lowercasing here instead
  // means one value flows through everything downstream: the lookup, the HMAC
  // cookie scope (issued and verified against this same string), and the form
  // targets. Duplicate-URL indexing is not a concern because every response
  // carries X-Robots-Tag: noindex.
  const slug = match[1]!.toLowerCase();
  const subroute = match[2]?.toLowerCase();
  // The two routes the trust wrapper adds. Both serve customer HTML and both
  // are gated exactly as the document route is; `framed` also chooses the
  // quieter answer at each gate, because a frame is not a page a person reads
  // an explanation on.
  const framed = subroute === 'frame' || subroute === 'print';

  // GATE. Off is how this ships, and off means these two routes do not exist:
  // the standard not-found, before any lookup, so nothing about the share
  // leaks and no disabled-open alert fires.
  if (framed && !wrapperEnabled(slug, env)) return notFound();

  const share = await getShareBySlug(env, slug);
  if (!share) return notFound();

  // Which host may serve THIS share, before any gate answers. Covers the
  // document, both gate submissions, the report form, the frame and print;
  // the attachment route runs the same check against its own lookup.
  const wrongStoredHost = enforceStoredHost(host, share, url, request.method, env);
  if (wrongStoredHost) return wrongStoredHost;

  // Read-tracking opt-out.
  //
  // AFTER the share lookup and the stored-host check, like every other route
  // that carries a share identifier (Astra's review, 17 September). It used to
  // run before both, which made it the one way to reach a share's address from
  // a host that share was never created for and be answered rather than
  // refused — and on a customer's own domain that answer would have worn the
  // customer's name.
  //
  // BEFORE the revoked/expired branch below, which is the other half of the
  // rule: the preference is browser-wide, not per-share, so a recipient must
  // still be able to turn tracking off from a link that has since been turned
  // off — and asking the question must not fire the owner's disabled-open
  // alert. The report form sits in the same place for the same reason.
  if (!subroute) {
    if (request.method === 'POST') {
      const written = await handleOptOutSubmit(request, slug, url.hostname, env);
      if (written) return written;
    } else {
      const param = url.searchParams.get('optout');
      if (param === '1' || param === '0') {
        return askOptOut(slug, param, url.hostname, env);
      }
    }
  }

  // The frame route refuses to be a top-level page.
  //
  // If a sender emails the frame address to skip the badge, the browser sends
  // Sec-Fetch-Dest: document — a header browsers write and page scripts cannot
  // forge. Anything other than `iframe`, its absence included, is sent to the
  // wrapper, which is where the badge is.
  //
  // After the stored-hostname check, not before it, so that a request on a
  // host this share was never created for gets the same not-found as every
  // other route rather than a redirect that says the route exists.
  if (subroute === 'frame' && request.headers.get('Sec-Fetch-Dest') !== 'iframe') {
    return toWrapper(slug);
  }

  // The print grant. Missing, expired, wrong-slug, wrong-hostname or
  // wrong-browser all land on the wrapper, where a live one is minted, so a
  // genuine reader whose grant simply aged out is never dead-ended — they are
  // put back in front of the badge, which is the point.
  if (subroute === 'print') {
    const granted = await verifyPrintGrant(
      url.searchParams.get('g'),
      slug,
      url.hostname,
      request.headers.get('cookie'),
      env.SESSION_SECRET,
    );
    if (!granted) return toWrapper(slug);
  }

  // The abuse report, answered before the revoked/expired branch below.
  //
  // A link that was turned off after it was sent is exactly the kind somebody
  // comes back to report, and a reporter who met the "sender turned this link
  // off" page instead of the form would have no way through. Answering here
  // also keeps a report from firing the owner's disabled-open alert — telling
  // a phishing sender that somebody just came back to their dead link is the
  // one thing this path must never do.
  if (subroute === 'report') {
    if (request.method === 'POST') return handleReportSubmit(request, share, env);
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return reportForm(slug);
  }

  // Owner-preview short-circuit. When the doc owner clicks "Preview
  // as you" in /docs/[id], the app mints a 10-minute HMAC token bound
  // to this slug and sends them here with ?owner_preview=<token>.
  // Valid token bypasses revoked/expired/password/email — the owner
  // is checking what the doc itself looks like, not the recipient's
  // gate experience. They've already proved ownership via Supabase
  // auth in the app server action that minted the token.
  const previewToken = url.searchParams.get('owner_preview');
  const isOwnerPreview = previewToken
    ? await verifyOwnerPreviewToken(previewToken, slug, env.SESSION_SECRET)
    : false;

  const isDisabled =
    !!share.revoked_at || !!(share.expires_at && new Date(share.expires_at).getTime() < Date.now());

  // A revoked or expired share is answered on the wrapper's own address, where
  // the reader gets the explanation and the owner gets the one alert. The
  // frame and print routes are reachable only by someone who went round that,
  // so they answer not-found and fire nothing: a second alert per open would
  // be noise, and telling a phishing sender that somebody came back to their
  // dead link is the one thing this path must never do.
  if (framed && isDisabled) return notFound();

  if (!isOwnerPreview) {
    // A disabled open serves an error shell and loads no tracker, so this
    // is the only place we learn the recipient tried. Fire-and-forget an
    // owner alert (throttled per-share in the DB) without blocking the
    // response — ctx.waitUntil keeps the worker alive until it completes.
    if (share.revoked_at) {
      ctx.waitUntil(notifyDisabledAttempt(env, share.id, 'revoked'));
      return revoked();
    }
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      ctx.waitUntil(notifyDisabledAttempt(env, share.id, 'expired'));
      return expired();
    }
  }

  if (subroute === 'auth') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handlePasswordSubmit(request, share, env);
  }
  if (subroute === 'email') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleEmailSubmit(request, share, url, env, ctx);
  }
  // The second step of the verified gate. It exists only on a link that asks
  // for one: on any other, it is the standard not-found, so the route says
  // nothing about a share's settings to somebody probing for it.
  if (subroute === 'verify') {
    if (!share.require_email || !share.verify_email) return notFound();
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleVerifySubmit(request, share, url, env);
  }

  // Gate sequence: password (if required) → email (if allow-listed) → content.
  //
  // The frame and print routes repeat every check the document route makes,
  // and answer not-found rather than a gate form: a gate rendered inside the
  // frame would ask for a password under a badge that says the document is
  // already open, and print is not a page anybody types into. Both are reached
  // only through the wrapper, which shows the gate at its own address.
  if (share.require_password && !isOwnerPreview) {
    const cookie = await verifyAuthCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return framed ? notFound() : passwordForm(slug);
  }

  // Hard-gate the document on a verified email whenever require_email
  // is true — regardless of whether an allow-list is set.
  //
  // Why this is at the proxy and not (only) the tracker:
  //   The tracker's Shadow DOM gate identifies viewers per-browser via
  //   a localStorage viewer_id that PERSISTS across all shares from the
  //   same browser. That means if a recipient enters their email on
  //   one share they're treated as "already authenticated" on every
  //   subsequent share from the same machine — even when each share is
  //   meant for a different recipient. Founders sending decks to
  //   different investors NEED the gate to fire per-share.
  //
  //   The proxy-issued email cookie is HMAC-scoped to a single slug
  //   (see verifyEmailCookie + tests/auth.test.ts "rejects an email
  //   cookie for a different slug"), so a fresh share asks for the
  //   email again, every time.
  //
  //   When the proxy gate fires, the tracker's in-doc gate stays off
  //   because injectTracker sees `email` already set in the config
  //   (gate.enabled = require_email && !email = false).
  //
  // AND WHEN THE LINK ASKS FOR A VERIFIED ADDRESS (schema/055), THE COOKIE IT
  // LOOKS AT IS A DIFFERENT ONE. `__Host-hr_v_{slug}` is issued only by the
  // code step, so an ordinary e-mail cookie — however the reader came by it,
  // including by having passed this gate yesterday before the owner turned the
  // option on — cannot satisfy this branch. That is decision 6: turning the
  // option on makes readers who are already past the gate verify at their next
  // open, with no migration step and no action by the owner.
  //
  // ONE BRANCH, SO EVERY PATH BEHIND THE GATE INHERITS IT. The document, the
  // frame, print and — in handleAttachmentDownload, which repeats this same
  // pair — the attachment route all decide here. There is no second place a
  // future route could be added and miss it (item H).
  let verifiedEmail: string | undefined;
  if (share.require_email && !isOwnerPreview) {
    const cookie = share.verify_email
      ? await verifyVerifiedCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET)
      : await verifyEmailCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) {
      if (framed) return notFound();
      return share.verify_email ? verifiedEmailGate(request, slug, env) : emailGateForm(slug);
    }
    // Re-check the cookie's email against
    // the share's CURRENT allowlist on every request — not just at
    // gate-submission time. If the sender tightened the allowlist
    // after the cookie was issued, the recipient's stale cookie
    // must NOT bypass the new rule.
    //
    // isEmailAllowed returns true for shares with no allowlist
    // (so vanilla require_email shares keep working), and for the
    // owner-preview path which already short-circuits above.
    if (!isEmailAllowed(share, cookie.email)) {
      if (framed) return notFound();
      const stale = 'This document is no longer shared with your address.';
      return share.verify_email
        ? verifiedEmailGate(request, slug, env, stale)
        : emailGateForm(slug, stale);
    }
    verifiedEmail = cookie.email;
  }

  // Every gate has passed, so the wrapper may be served. It is HTMLRadar's own
  // page and needs nothing from the document: the frame route below fetches
  // that, one extra request on the same connection to the same worker.
  //
  // The owner's own preview is deliberately NOT wrapped. The badge is a
  // recipient-facing control, the preview token already bypasses every other
  // recipient gate, and a sender checking their own rendering should see their
  // own document.
  //
  // ponytail: no document check here, so a share whose document was deleted
  // shows the wrapper with a not-found inside the frame rather than a clean
  // not-found page. Buying the tidier answer costs a second database call on
  // every open, which is the call this design just removed.
  if (!subroute && !isOwnerPreview && wrapperEnabled(slug, env)) {
    // Printing is already blocked on a locked deck, so its strip carries no
    // Print link and no print cookie is minted for it.
    const existingSecret = readPrintCookie(request.headers.get('cookie'));
    const printSecret = share.lock_deck ? null : (existingSecret ?? newPrintSecret());
    const grant = printSecret
      ? await issuePrintGrant(slug, url.hostname, printSecret, env.SESSION_SECRET)
      : null;
    return wrapperPage({
      slug,
      printHref: grant ? `/r/${slug}/print?g=${grant}` : null,
      // Only when it is new. Re-minting on every load would kill the grant a
      // second tab on the same share is holding.
      setCookie: printSecret && printSecret !== existingSecret ? printCookie(printSecret) : null,
    });
  }

  const doc = await getDocument(env, share.document_id);
  if (!doc || doc.deleted_at) return notFound();

  const html = await fetchDocumentHtml(doc, env);
  if (!html) return sourceUnreachable();

  // Came back with the share, from share_lookup. A missing profile row leaves
  // it null, which reads as free — the safe direction for the badge decision
  // to fail, since the other way silently gives the paid feature away.
  const tier = share.owner_tier ?? 'free';
  const geo = geoFromRequest(request);

  // Attachments are ALWAYS surfaced to the recipient when they exist
  // (design decision). The pill + drawer UI lives in the
  // corner; clicking expands the file list. Owner-preview still
  // skips the DB call — the sender is checking deck-render, not
  // attachments which they themselves uploaded.
  let attachments: Attachment[] = [];
  if (!isOwnerPreview) {
    attachments = await listAttachmentsForDocument(env, doc.id);
  }

  // An opted-out recipient gets the document itself, the free-tier badge and
  // the same sandbox CSP — just no tracker, and therefore no session.
  const optedOut = isTrackingOptedOut(request.headers.get('cookie'));

  // Print is a second view of a document the reader already opened, so it does
  // not start a session of its own; the owner's own preview is not a read; and
  // an opted-out reader gets no tracker at all.
  const trackingEnabled = subroute !== 'print' && !isOwnerPreview && !optedOut;

  // The returning reader. `hr_rid` carries a random value on the host that
  // served the document; what the tracker is handed is that value bound to
  // this document (see deriveReaderId), so the tracker needs no browser
  // storage — which is what the sandbox took away on 31 August.
  //
  // Nothing is set and nothing is used when tracking is off, which is what the
  // opt-out means: the cookie is not minted, no identifier is derived, and no
  // identifier reaches the page.
  let readerId: string | undefined;
  const setCookies: string[] = [];
  if (trackingEnabled) {
    const existing = readReaderCookie(request.headers.get('cookie'));
    const secret = existing ?? newReaderSecret();
    if (!existing) setCookies.push(readerCookie(secret));
    readerId = await deriveReaderId(secret, share.document_id, env.SESSION_SECRET);
  } else if (optOutNeedsMigration(request.headers.get('cookie'))) {
    // A reader who opted out before the preference moved under `__Host-`. Write
    // the new name alongside the old one on their next open, after which their
    // choice sits under a name no parent domain can write. The read already
    // honours either, so this is a hardening step and not a correctness one.
    setCookies.push(OPT_OUT_COOKIE);
  }

  return injectTracker(html, {
    share,
    tier,
    // frame-ancestors 'self' and no X-Frame-Options, on that route alone.
    framed: subroute === 'frame',
    // Today's Cmd+P on the unwrapped page does not start a session either, and
    // a print address that carried a viewer's identity would be a worse thing
    // to leave in a browser's history.
    trackingEnabled,
    trackerUrl: trackerPathFor(url.hostname, env),
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    ...(verifiedEmail ? { email: verifiedEmail } : {}),
    ...(readerId ? { readerId } : {}),
    ...(setCookies.length > 0 ? { setCookies } : {}),
    ...(geo && Object.keys(geo).length > 0 ? { geo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

/**
 * The address step on a link that asks for a verified address.
 *
 * Minting the challenge HERE, on the page that shows the form, is what makes
 * the signed token possible: the token is signed over the challenge this
 * browser is about to hold, so a post arriving without both is refused. The
 * plain e-mail gate is untouched — it has no token and no challenge, because
 * it is not a step an attacker gains anything by forging.
 *
 * The challenge is reused when the browser already holds one, so two tabs on
 * the same link do not invalidate each other's pending code.
 */
async function verifiedEmailGate(
  request: Request,
  slug: string,
  env: Env,
  error?: string,
): Promise<Response> {
  const existing = readVerifyChallenge(request.headers.get('cookie'));
  const challenge = existing ?? newVerifyChallenge();
  const token = await issueGateToken('email', slug, challenge, '', env.SESSION_SECRET);
  const res = emailGateForm(slug, error, token);
  res.headers.append('Set-Cookie', verifyChallengeCookie(challenge));
  return res;
}

/**
 * Asking the question, which is the only thing that mints a challenge.
 *
 * The page and the cookie are made together and are useless apart: the token
 * in the form is signed over the challenge in the cookie, so a token lifted
 * off this page and replayed from anywhere else meets a browser that does not
 * hold the matching challenge. Every path that shows this page comes through
 * here, so there is no way to render the form without its cookie.
 */
async function askOptOut(
  slug: string,
  optout: '1' | '0',
  hostname: string,
  env: Env,
  status = 200,
): Promise<Response> {
  const challenge = newOptOutChallenge();
  const token = await issueOptOutToken(optout, slug, hostname, challenge, env.SESSION_SECRET);
  const res = optOutConfirm(slug, optout, token, status);
  res.headers.append('Set-Cookie', optOutChallengeCookie(challenge));
  return res;
}

/**
 * The opt-out write. Returns null when this POST is not one, so anything else
 * posted to /r/{slug} keeps whatever behaviour it had.
 *
 * This is the whole reason the GET stopped writing. `hr_optout` has
 * `Path=/r/`, so it governs every share on the host, and the old `?optout=`
 * query parameter set it on a plain navigation. A shared document may
 * navigate its own browsing context even from the opaque sandbox origin it
 * runs in, so a sender's script could have switched tracking off for every
 * other sender's links — or, worse, switched it back ON after the recipient
 * had opted out. A mailed link did the same thing to anyone who clicked it.
 *
 * Routing is by the presence of both fields rather than by a sub-path so the
 * form can post back to the document's own address, which is the only address
 * the recipient has.
 */
async function handleOptOutSubmit(
  request: Request,
  slug: string,
  hostname: string,
  env: Env,
): Promise<Response | null> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  const optout = form.get('optout');
  const token = form.get('token');
  if ((optout !== '1' && optout !== '0') || typeof token !== 'string') return null;

  // The challenge this browser was given when it was asked the question. A
  // forged submission from somebody else's page carries a token signed over a
  // DIFFERENT challenge — the attacker's own — so it fails here and writes
  // nothing at all. See the note above issueOptOutToken.
  const challenge = readOptOutChallenge(request.headers.get('cookie'));
  if (!(await verifyOptOutToken(token, optout, slug, hostname, challenge, env.SESSION_SECRET))) {
    // Ask again with a fresh challenge and token rather than dead-ending: the
    // common causes are a confirmation page left open for more than ten
    // minutes and a browser that discarded the challenge cookie.
    return askOptOut(slug, optout, hostname, env, 400);
  }

  // Opting out also wipes the returning-reader identifier, which is what the
  // tracker's own optOut() does to the localStorage copy on a self-hosted
  // page. Opting back IN wipes it too: the reader gets a new identifier on
  // their next open rather than being rejoined to the one they turned off
  // under.
  const headers = new Headers({ Location: `/r/${slug}` });
  // Turning it back on expires BOTH names — the `__Host-` one this writes and
  // the legacy one a reader may still hold — or an honest opt-back-in would
  // leave the old copy behind and the reader would stay opted out for ever.
  if (optout === '1') headers.append('Set-Cookie', OPT_OUT_COOKIE);
  else for (const c of OPT_OUT_CLEAR_COOKIES) headers.append('Set-Cookie', c);
  headers.append('Set-Cookie', READER_CLEAR_COOKIE);
  // Spend the challenge. The token is signed over it, so expiring it here is
  // what makes a confirmation single-use rather than replayable for ten
  // minutes by anyone who captured the form.
  headers.append('Set-Cookie', OPT_OUT_CHALLENGE_CLEAR_COOKIE);
  return new Response(null, { status: 303, headers });
}

async function handlePasswordSubmit(request: Request, share: Share, env: Env): Promise<Response> {
  const slug = share.slug;
  const form = await request.formData();
  const password = form.get('password');
  if (typeof password !== 'string' || password.length === 0) {
    return passwordForm(slug, 'Password is required.');
  }
  const verdict = await verifySharePassword(env, slug, password);
  // Awaited (not waitUntil — no ctx here): the gate outcome is the one
  // signal that separates "recipient bounced at the door" from "never
  // visited", and the insert is a single fast REST call.
  await logAppEvent(env, share.owner_id, 'share.password_submitted', {
    result: verdict,
    share_id: share.id,
    document_id: share.document_id,
  });
  if (verdict === 'rate_limited') {
    return passwordForm(slug, 'Too many attempts. Wait a minute, then try again.');
  }
  if (verdict !== 'ok') {
    return passwordForm(slug, 'Incorrect password.');
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/r/${slug}`,
      'Set-Cookie': await issueAuthCookie(slug, env.SESSION_SECRET),
    },
  });
}

/**
 * The report write.
 *
 * The reason is checked here as well as in the RPC so a mistyped menu value
 * comes back as a sentence on the form rather than as a silent nothing, and
 * the note is cut to the length the form advertises rather than refused —
 * somebody who typed six hundred characters about a fake login page should
 * not lose them to a validation message.
 *
 * The connecting address is hashed before it goes anywhere. It is the
 * rate-limit identity and nothing else; the raw address never leaves this
 * worker, and no part of the report identifies the reporter.
 *
 * NO CONFIRMATION TOKEN, unlike the opt-out POST a few functions down. That
 * one needs a token because the thing it writes is the recipient's own
 * setting across every sender's links, so a forged submission changes
 * something the recipient owns. A forged report changes nothing anybody
 * owns: it writes a row we read by hand, five an hour per address, and the
 * worst it can do is make us look at a document. A token would buy a page of
 * machinery for that.
 */
async function handleReportSubmit(request: Request, share: Share, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reportForm(share.slug, 'Something went wrong sending that. Please try again.');
  }

  const reason = form.get('reason');
  if (typeof reason !== 'string' || !REPORT_REASONS.some(([value]) => value === reason)) {
    return reportForm(share.slug, 'Please choose a reason.');
  }

  const rawNote = form.get('note');
  const note =
    typeof rawNote === 'string' ? rawNote.trim().slice(0, NOTE_MAX_LENGTH) || null : null;

  const ipHash = await hashReporterAddress(
    request.headers.get('CF-Connecting-IP') ?? '',
    env.SESSION_SECRET,
  );

  const verdict = await reportAbuse(env, { slug: share.slug, reason, note, ipHash });
  if (verdict === 'rate_limited') {
    return reportForm(
      share.slug,
      'That is several reports from here in the last hour. Try again a little later.',
    );
  }
  if (verdict !== 'ok') {
    return reportForm(share.slug, "That didn't send. Try again in a moment.");
  }
  return reportSent();
}

async function handleEmailSubmit(
  request: Request,
  share: Share,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const form = await request.formData();
  const gateEvent = (result: string, domain: string | null) =>
    logAppEvent(env, share.owner_id, 'share.email_submitted', {
      result,
      // Domain only, never the full address — a rejected visitor's email
      // is a third party's PII the owner has no relationship with yet.
      email_domain: domain,
      share_id: share.id,
      document_id: share.document_id,
      verified_gate: share.verify_email,
    });
  const raw = form.get('email');
  if (typeof raw !== 'string') return emailGateForm(share.slug, 'Email is required.');
  const email = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    await gateEvent('invalid_format', null);
    return emailGateForm(share.slug, 'Please enter a valid email address.');
  }
  const domain = email.split('@')[1] ?? null;

  // THE ORIGIN CHECK IS ON THE VERIFICATION POSTS AND ON THOSE ALONE (item E).
  //
  // It belongs here rather than at the top of this handler because the plain
  // e-mail gate is not one of the two gate posts the brief names, and putting
  // it there changed a posture nobody asked to change: a forged submission to
  // the plain gate sets a cookie carrying an address of the attacker's
  // choosing in a victim's browser, which is the behaviour that has shipped
  // since the gate existed and is not this lane's to alter. Tightening it also
  // broke three existing tests, which is the shape of an unrequested change.
  //
  // On THIS path a forged submission would spend a victim's rate-limit budget
  // and put a code in their inbox, so it is refused. The check is only the
  // first of two: see isOwnGatePost for why the challenge cookie is the half
  // that does the work.
  if (share.verify_email) {
    if (!isOwnGatePost(request, url)) {
      return verifiedEmailGate(request, share.slug, env, "That didn't come from this page.");
    }
    // THE SIGNED FIELD, AND IT IS CHECKED BEFORE ANYTHING IS SPENT. A forged
    // post carries the victim's challenge cookie — SameSite=None sends it —
    // but can only carry a token the attacker signed over THEIR challenge, so
    // the two disagree and nothing happens: no code is stored, no message is
    // sent, no budget is consumed. Returning here rather than after the
    // database call is what makes that true (Astra, finding 2).
    const ok = await verifyGateToken(
      typeof form.get('t') === 'string' ? (form.get('t') as string) : null,
      'email',
      share.slug,
      readVerifyChallenge(request.headers.get('cookie')),
      '',
      env.SESSION_SECRET,
    );
    if (!ok) {
      await gateEvent('forged_or_stale_form', domain);
      // A fresh pair rather than a dead end: the common cause is a form left
      // open past the token's ten minutes, not an attack.
      return verifiedEmailGate(request, share.slug, env, 'That form expired. Try again.');
    }
    return sendCodeStep(request, share, email, domain, gateEvent, env, ctx);
  }

  // Allowlist check happens here (post-format-validation) because we
  // need the full address to test both lists. Union semantics: if any
  // list is set, the address must match SOMETHING in at least one.
  if (!isEmailAllowed(share, email)) {
    await gateEvent('not_allowed', domain);
    return emailGateForm(share.slug, "This document isn't shared with your address.");
  }
  await gateEvent('ok', domain);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/r/${share.slug}`,
      'Set-Cookie': await issueEmailCookie(share.slug, email, env.SESSION_SECRET),
    },
  });
}

/**
 * Step one of the verified gate: mint a code, record it, and — only for an
 * address the link permits — mail it.
 *
 * READ THE ORDER, because the order is the anti-enumeration property.
 *
 * The database call happens for EVERY address, permitted or not. It is the
 * expensive half of this handler, it counts the same limits either way, and
 * running it unconditionally is what keeps a refused address from being the
 * fast one. The allow-list decision is made here, in memory, off a share we
 * already hold, and its only consequence is whether a message is sent —
 * which is a fact in a mailbox and not a fact on this screen (decision 2).
 *
 * THE LIMITS SPEND EITHER WAY, deliberately. An attacker walking a list of
 * addresses to see which ones are on the allow-list exhausts the per-network
 * ceiling on addresses that receive nothing, which is the behaviour we want.
 *
 * THE CHALLENGE IS REUSED WHEN THE BROWSER ALREADY HAS ONE. A fresh one on
 * every request would strand the code the reader is holding: the database
 * binds a code to the challenge, and a new challenge means the old code can
 * no longer be looked up. Reusing it is also what lets the database retire
 * the previous code when a second one is asked for, so one browser has one
 * live code and five guesses, not three codes and fifteen.
 */
async function sendCodeStep(
  request: Request,
  share: Share,
  email: string,
  domain: string | null,
  gateEvent: (result: string, domain: string | null) => Promise<void>,
  env: Env,
  // Threaded from the fetch handler rather than left absent. The send outlives
  // the response and something has to keep the worker alive for it; this is
  // the same mechanism the disabled-link alert already uses.
  ctx: ExecutionContext,
): Promise<Response> {
  const started = Date.now();
  const existing = readVerifyChallenge(request.headers.get('cookie'));
  const challenge = existing ?? newVerifyChallenge();
  const code = newVerificationCode();
  const codeHash = await hashVerificationCode(share.id, email, code, env.SESSION_SECRET);
  // The same hashed identity an abuse report is rate-limited by: the raw
  // address never leaves this worker, and the database stores an opaque string
  // it cannot walk back without a key it does not hold.
  const ipHash = await hashReporterAddress(
    request.headers.get('CF-Connecting-IP') ?? '',
    env.SESSION_SECRET,
  );

  // WHETHER THE LINK PERMITS THIS ADDRESS is decided here, in memory, off a
  // share already in hand — and it is passed to the database rather than kept
  // to ourselves. It changes nothing about the work done or the answer given;
  // it only stops a request for an address the link does not permit spending
  // that address's own budget (Astra, finding 5).
  const permitted = isEmailAllowed(share, email);
  const verdict = await issueVerificationCode(env, {
    shareId: share.id,
    email,
    codeHash,
    challenge,
    ipHash,
    permitted,
  });

  // THE SEND HAPPENS AFTER THE ANSWER. ctx.waitUntil keeps the worker alive
  // until it finishes, so nothing is dropped, but the reader is not waiting on
  // it and therefore cannot be told anything by how long they waited.
  //
  // THIS IS STILL FAILING CLOSED. Failing closed means the document does not
  // open, and it does not: the only thing that opens it is a correct code, and
  // a code that was never delivered is a code nobody can type. What changed is
  // that we no longer ANNOUNCE the failure to whoever is standing at the gate,
  // because the announcement was itself the leak. The failure is recorded
  // instead, with its reason, where the people who can fix it will see it —
  // and the daily live journey fails within a day if the provider is refusing
  // us (packages/app/scripts/live-journey.mjs).
  if (verdict === 'ok' && permitted) {
    ctx.waitUntil(
      (async () => {
        // TIMED OUT, because a hung send is indistinguishable from a slow one
        // and the daily journey must not be able to pass on either. Whichever
        // settles first decides; a timeout is recorded as a failure like any
        // other refusal.
        const ok = await Promise.race([
          sendVerificationCode(env, {
            to: email,
            code,
            documentTitle: share.document_title ?? 'a document',
            // The owner as the product already shows them, and their address
            // only if there is no name — the same fallback the first-open
            // e-mail uses.
            sender: share.owner_display_name ?? share.owner_email ?? 'Someone',
            // The host the reader is actually on, so a custom domain and a
            // handle host each name themselves (item G).
            host: request.headers.get('host') ?? shareHostOf(env),
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SEND_TIMEOUT_MS)),
        ]);
        if (ok) {
          // THE POSITIVE EVENT, and the reason it exists (Astra, finding 8).
          // The daily journey used to pass on "a code was issued and no
          // failure was logged within fifteen seconds", which a hung send, a
          // dropped background task or a failed failure-write all satisfy.
          // Only this row means the provider actually took the message, so
          // the journey can require it rather than infer it from silence.
          // Domain only, never the address: the same hygiene rule the gate
          // events follow.
          await logAppEvent(env, share.owner_id, 'share.code_sent', {
            email_domain: domain,
            share_id: share.id,
            document_id: share.document_id,
          });
        } else {
          await logAppEvent(env, share.owner_id, 'share.code_send_failed', {
            // sendVerificationCode collapses every failure to false on
            // purpose — the reader is told the same thing for all of them —
            // so what is recordable here is that the provider did not accept
            // it, plus whether we even had a credential to try with. That
            // second fact is the one worth separating: "not configured" is a
            // deploy mistake and "refused" is an account problem, and they
            // are fixed by different people.
            reason: env.RESEND_API_KEY ? 'provider_refused' : 'no_credential',
            email_domain: domain,
            share_id: share.id,
            document_id: share.document_id,
          });
        }
      })(),
    );
  }

  // `code_issued` means a code was stored and, for a permitted address, a send
  // was started. Whether it arrived is the event above, not this one.
  await gateEvent(verdict === 'ok' ? 'code_issued' : `code_${verdict}`, domain);

  // Both paths leave here at the same moment on the clock. See GATE_FLOOR_MS.
  await padTo(started, gateFloorMs(env));

  // ONE PAGE FOR EVERY OUTCOME, INCLUDING OVER THE LIMIT (decision 5d), and
  // this last part was a leak of its own until Astra's finding 5 was fixed.
  // The over-limit reply used to carry an extra line. Once a NON-permitted
  // address stopped consuming its own budget — which is what stops five
  // requests from anybody locking a named reader out — only a permitted
  // address could ever see that line, so the line itself answered the question
  // this gate exists not to answer. It is gone. The page's own sentence, "it
  // can take a minute to arrive; if nothing comes, ask for another code", is
  // true for somebody over their limit as well, and it is the same words
  // everybody else reads.
  const res = verifyCodeForm(
    share.slug,
    email,
    await issueGateToken('code', share.slug, challenge, email, env.SESSION_SECRET),
  );
  // SET IT WHENEVER A CODE WAS STORED, new challenge or not (Astra, finding
  // 9). The cookie and the code used to age independently: a reader who asked
  // for a second code at minute nine reused a challenge expiring at minute ten
  // and was handed a code good until minute nineteen, so the code they had
  // just been sent became unusable a minute later. Re-sending the same value
  // restarts its ten minutes alongside the code it is bound to.
  //
  // Still NEVER on a refused request: overwriting or extending a live challenge
  // when nothing was stored would throw away the working code the reader is
  // already holding.
  if (verdict === 'ok') {
    res.headers.append('Set-Cookie', verifyChallengeCookie(challenge));
  }
  return res;
}

/**
 * Step two: the code comes back.
 *
 * EVERY WAY OF BEING WRONG IS ONE SENTENCE. A used code, an expired one, one
 * burnt by five wrong guesses, a code for another link, for another address or
 * from another browser, a missing challenge cookie, a code that is not six
 * digits, and a database we could not reach are all "that code is not right"
 * (item B). The branch that could tell them apart does not exist here, and the
 * database function it calls does not return the distinction in the first
 * place.
 *
 * TWO COOKIES ON SUCCESS. The verified one is what this link now looks at; the
 * ordinary e-mail one rides along so that an owner who later turns the option
 * off does not silently sign every admitted reader out. Turning it back ON
 * still forces verification, because the branch that decides looks only at the
 * verified name.
 */
async function handleVerifySubmit(
  request: Request,
  share: Share,
  url: URL,
  env: Env,
): Promise<Response> {
  if (!isOwnGatePost(request, url)) {
    return verifiedEmailGate(request, share.slug, env, "That didn't come from this page.");
  }
  const form = await request.formData();
  const rawEmail = form.get('email');
  const rawCode = form.get('code');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!EMAIL_REGEX.test(email)) {
    return emailGateForm(share.slug, 'Please enter a valid email address.');
  }

  const challenge = readVerifyChallenge(request.headers.get('cookie'));
  // BEFORE AN ATTEMPT IS SPENT. Five forged wrong guesses used to burn the
  // code a victim was waiting on; they cannot now, because a forged post never
  // reaches the database at all. The token is bound to the address as well as
  // the browser, so one obtained for one address cannot spend another's
  // attempts either.
  const tokenOk = await verifyGateToken(
    typeof form.get('t') === 'string' ? (form.get('t') as string) : null,
    'code',
    share.slug,
    challenge,
    email,
    env.SESSION_SECRET,
  );
  if (!tokenOk) {
    await logAppEvent(env, share.owner_id, 'share.code_submitted', {
      result: 'forged_or_stale_form',
      email_domain: email.split('@')[1] ?? null,
      share_id: share.id,
      document_id: share.document_id,
    });
    return verifiedEmailGate(request, share.slug, env, 'That form expired. Try again.');
  }

  const started = Date.now();
  const verdict =
    challenge && /^[0-9]{6}$/.test(code)
      ? await checkVerificationCode(env, {
          shareId: share.id,
          email,
          codeHash: await hashVerificationCode(share.id, email, code, env.SESSION_SECRET),
          challenge,
        })
      : 'bad';

  await logAppEvent(env, share.owner_id, 'share.code_submitted', {
    result: verdict,
    email_domain: email.split('@')[1] ?? null,
    share_id: share.id,
    document_id: share.document_id,
  });
  await padTo(started, Math.min(VERIFY_FLOOR_MS, gateFloorMs(env)));

  if (verdict !== 'ok') {
    return verifyCodeForm(
      share.slug,
      email,
      await issueGateToken('code', share.slug, challenge!, email, env.SESSION_SECRET),
      'That code is not right. Check the email and try again.',
      401,
    );
  }

  const headers = new Headers({ Location: `/r/${share.slug}` });
  headers.append('Set-Cookie', await issueVerifiedCookie(share.slug, email, env.SESSION_SECRET));
  headers.append('Set-Cookie', await issueEmailCookie(share.slug, email, env.SESSION_SECRET));
  // Spend the challenge. The code it was bound to is already marked used; the
  // next code this browser asks for gets a challenge of its own.
  headers.append('Set-Cookie', VERIFY_CHALLENGE_CLEAR_COOKIE);
  return new Response(null, { status: 303, headers });
}

// Combined allowlist check. Returns true when:
//   - no lists are set (open), OR
//   - the email appears in allowed_emails, OR
//   - the email's domain appears in allowed_email_domains.
// Email and domains are normalised to lowercase at the call site (the
// proxy lowercases on input; the DB writes whatever the client sent —
// the create/update UI also lowercases, see actions.ts).
function isEmailAllowed(share: Share, email: string): boolean {
  const hasEmailList = Array.isArray(share.allowed_emails) && share.allowed_emails.length > 0;
  const hasDomainList =
    Array.isArray(share.allowed_email_domains) && share.allowed_email_domains.length > 0;
  if (!hasEmailList && !hasDomainList) return true;
  if (hasEmailList && share.allowed_emails!.includes(email)) return true;
  if (hasDomainList) {
    const domain = email.split('@')[1] ?? '';
    if (share.allowed_email_domains!.includes(domain)) return true;
  }
  return false;
}

// Attachment download handler. The gate order MIRRORS the doc-serve path
// so a recipient with a valid email cookie for share X can download
// materials on share X (and ONLY share X — the attachment's
// document_id must match the share's document_id).
//
// On any permission failure we return 404, NOT 403. Sender chose not to
// share downloads; we don't even confirm to the recipient that a file
// exists at that ID.
async function handleAttachmentDownload(
  request: Request,
  slug: string,
  attachmentId: string,
  host: HostKind,
  env: Env,
): Promise<Response> {
  const share = await getShareBySlug(env, slug);
  if (!share) return notFound();
  // The same stored-hostname check the document route makes. Without it this
  // route would be a way to reach a share from a host it was never created
  // for — which is exactly the gap the design says leaving the check on the
  // document route alone would leave.
  const wrongStoredHost = enforceStoredHost(host, share, new URL(request.url), request.method, env);
  if (wrongStoredHost) return wrongStoredHost;
  if (share.revoked_at) return notFound();
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
    return notFound();
  }
  // Attachments are NO LONGER gated by lock_deck (2026-05-19). They're
  // a separate access surface — if the sender uploaded them, recipients
  // can download. Sender's only way to "hide" an attachment is to not
  // attach it. Lock_deck remains for deck save/print posture only.

  // Re-apply the same gate cookies the doc-serve path enforces. Without
  // this, a recipient could craft a download URL even before they pass
  // the email gate on the underlying share.
  if (share.require_password) {
    const cookie = await verifyAuthCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return notFound();
  }
  let recipientEmail: string | null = null;
  if (share.require_email) {
    // The same pair the document route decides on: a link that requires a
    // verified address accepts the verified cookie and nothing else here
    // either. Without this line the attachments would be the way round the
    // whole gate (item H).
    const cookie = share.verify_email
      ? await verifyVerifiedCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET)
      : await verifyEmailCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return notFound();
    // Same fresh-allowlist check as the doc-serve path. A
    // stale email cookie must NOT bypass a tightened allowlist on the
    // attachment route either. 404 here (not "your email's not on the
    // list") because attachments are quieter than the gate page — we
    // don't want to confirm what attachments exist behind a closed
    // gate.
    if (!isEmailAllowed(share, cookie.email)) return notFound();
    recipientEmail = cookie.email;
  }

  const attachment = await getAttachment(env, attachmentId);
  if (!attachment) return notFound();
  // Cross-doc enumeration defence: attachment must live on the same doc
  // as the share. Otherwise a recipient on share X could enumerate
  // attachment IDs from share Y on another doc.
  if (attachment.document_id !== share.document_id) return notFound();

  const obj = await env.DOCS_BUCKET.get(attachment.r2_key);
  if (!obj) return notFound();

  // Fire-and-forget download log with per-viewer attribution. We never
  // block the response on this; if Supabase is slow or down the
  // recipient still gets their file.
  //
  // Viewer lookup: when we have a verified email, we resolve the
  // existing viewers row by (share_id, email). When we don't (anonymous
  // share), viewer_id stays null and the row attributes via session_id
  // (set client-side by the tracker; we don't see it here without a
  // separate lookup, so for v1 we leave it null too — the recipient_email
  // + ip_hint + timestamp are usually enough).
  const geo = geoFromRequest(request);
  void (async () => {
    const viewerId = recipientEmail
      ? await getViewerIdByShareEmail(env, share.id, recipientEmail)
      : null;
    await logAttachmentDownload(env, {
      attachment_id: attachment.id,
      share_id: share.id,
      recipient_email: recipientEmail,
      country_code: geo?.country ?? null,
      device_type: null,
      user_agent: request.headers.get('User-Agent'),
      viewer_id: viewerId,
      session_id: null,
      filename: attachment.filename,
      size_bytes: attachment.size_bytes,
    });
    // Mirror into app_events so downloads reach the analytics funnel —
    // attachment_downloads is the product table, this is the telemetry.
    await logAppEvent(env, share.owner_id, 'attachment.downloaded', {
      share_id: share.id,
      document_id: share.document_id,
      filename: attachment.filename,
      size_bytes: attachment.size_bytes,
    });
  })();

  // Force download: Content-Disposition: attachment with the sanitised
  // filename. The filename was already sanitised at upload time
  // (ASCII-printable only — see lib/attachments.ts sanitizeFilename), so
  // no header-injection risk here. Double-quote escape the inner quote
  // just in case the upload-time sanitiser ever changes.
  const safeName = attachment.filename.replace(/"/g, '');
  const headers = new Headers();
  headers.set('Content-Type', attachment.mime_type);
  headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
  headers.set('Content-Length', String(attachment.size_bytes));
  headers.set('X-Content-Type-Options', 'nosniff');
  // No caching by intermediaries — every download must hit our gate.
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  return new Response(obj.body, { status: 200, headers });
}
