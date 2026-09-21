// Stateless HMAC-signed cookies for the password and email gates.
//
// Password cookie: `{slug}.{expiry}.{hmac}`        HMAC over `{slug}:{expiry}`
// Email cookie:    `{slug}.{b64email}.{expiry}.{hmac}`  HMAC over `{slug}:{email}:{expiry}`
//
// Stateless — we never store gate sessions; the cookie itself is the proof
// of having passed the gate.

const PWD_PREFIX = 'htmlradar_auth_';
const EMAIL_PREFIX = 'htmlradar_email_';
const TTL_SECONDS = 24 * 60 * 60;
// Owner preview tokens are short-lived because they're meant to be
// generated and consumed in a single navigation. 10 minutes covers
// "click the button, the page loads, owner pokes around for a few
// minutes." Doesn't need to be reusable.
const OWNER_PREVIEW_TTL_SECONDS = 10 * 60;

export interface VerifiedAuth {
  slug: string;
  expiresAt: number;
}

export interface VerifiedEmail {
  slug: string;
  email: string;
  expiresAt: number;
}

export async function issueAuthCookie(slug: string, secret: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const mac = await hmac(`${slug}:${expiresAt}`, secret);
  return cookieAttrs(`${PWD_PREFIX}${slug}`, `${slug}.${expiresAt}.${mac}`);
}

export async function verifyAuthCookie(
  cookieHeader: string | null,
  slug: string,
  secret: string,
): Promise<VerifiedAuth | null> {
  if (!cookieHeader) return null;
  const raw = parseCookies(cookieHeader)[`${PWD_PREFIX}${slug}`];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [cookieSlug, expiryStr, mac] = parts as [string, string, string];
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (cookieSlug !== slug || !Number.isFinite(expiresAt)) return null;
  if (expiresAt < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(`${slug}:${expiresAt}`, secret);
  return constantTimeEqual(mac, expected) ? { slug, expiresAt } : null;
}

export async function issueEmailCookie(
  slug: string,
  email: string,
  secret: string,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const b64 = base64urlEncode(new TextEncoder().encode(email));
  const mac = await hmac(`${slug}:${email}:${expiresAt}`, secret);
  return cookieAttrs(`${EMAIL_PREFIX}${slug}`, `${slug}.${b64}.${expiresAt}.${mac}`);
}

export async function verifyEmailCookie(
  cookieHeader: string | null,
  slug: string,
  secret: string,
): Promise<VerifiedEmail | null> {
  if (!cookieHeader) return null;
  const raw = parseCookies(cookieHeader)[`${EMAIL_PREFIX}${slug}`];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [cookieSlug, b64email, expiryStr, mac] = parts as [string, string, string, string];
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (cookieSlug !== slug || !Number.isFinite(expiresAt)) return null;
  if (expiresAt < Math.floor(Date.now() / 1000)) return null;

  let email: string;
  try {
    email = new TextDecoder().decode(base64urlDecode(b64email));
  } catch {
    return null;
  }
  const expected = await hmac(`${slug}:${email}:${expiresAt}`, secret);
  return constantTimeEqual(mac, expected) ? { slug, email, expiresAt } : null;
}

// Owner-preview token. Mints a short-lived HMAC over
// `owner-preview:{slug}:{exp}` so the doc-owner can preview their own
// share without entering the email gate (which they wouldn't satisfy —
// it's gated by the proxy on a slug-scoped cookie). The token is bound
// to a single slug and expires fast; replay outside the slug or after
// TTL fails.
//
// Format: `{slug}.{exp}.{hmac}` — same shape as the auth cookie but
// the HMAC message has a different prefix so a captured auth cookie
// can't be replayed as a preview token (or vice versa).
export async function issueOwnerPreviewToken(slug: string, secret: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + OWNER_PREVIEW_TTL_SECONDS;
  const mac = await hmac(`owner-preview:${slug}:${expiresAt}`, secret);
  return `${slug}.${expiresAt}.${mac}`;
}

export async function verifyOwnerPreviewToken(
  token: string | null,
  slug: string,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenSlug, expiryStr, mac] = parts as [string, string, string];
  if (tokenSlug !== slug) return false;
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(`owner-preview:${slug}:${expiresAt}`, secret);
  return constantTimeEqual(mac, expected);
}

// Owner-DOCUMENT-preview token. Distinct from the share-bound owner
// preview above: this one is bound to a document_id, not a share slug,
// and lets the doc owner view the raw uploaded HTML *before* creating
// any share. The message prefix is different (`owner-doc-preview:`) so
// a captured share-preview token can't be replayed as a doc-preview
// token (or vice versa).
export async function verifyOwnerDocPreviewToken(
  token: string | null,
  docId: string,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenDocId, expiryStr, mac] = parts as [string, string, string];
  if (tokenDocId !== docId) return false;
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(`owner-doc-preview:${docId}:${expiresAt}`, secret);
  return constantTimeEqual(mac, expected);
}

function cookieAttrs(name: string, value: string): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

// Recipient opt-out from read tracking. Server-side by necessity: every
// proxy response carries a `sandbox` CSP without allow-same-origin, so the
// document runs in an opaque origin where localStorage and document.cookie
// both throw. A cookie set by the proxy is the only store the recipient's
// choice can survive in.
// THE PREFERENCE IS WRITTEN UNDER `__Host-`, AND READ UNDER BOTH NAMES.
//
// The old name could be overridden by the one party with a motive. A cookie's
// host scope is not decided by the host that set it: any parent domain can
// write a cookie its subdomains receive. A customer who points decks.acme.com
// at us also controls acme.com, so they could plant
// `hr_optout=0; Domain=acme.com; Path=/r/` from any page on acme.com. Browsers
// send cookies of equal path specificity oldest-first, so the planted copy
// arrives after the genuine one, a last-wins parse takes it, `'0' !== '1'`,
// and a recipient who had turned tracking off was silently tracked again on
// that customer's domain.
//
// Two changes close it. The preference is now written as `__Host-hr_optout`,
// which a browser refuses to set with a Domain attribute at all, so no parent
// domain can write that name. And the READ below scans EVERY cookie on the
// request rather than building a last-wins map: any copy of either name equal
// to '1' means opted out. Planting can therefore only ever turn an opt-out ON,
// which costs the planter their own tracking and harms nobody.
const OPT_OUT_NAME = '__Host-hr_optout';
const LEGACY_OPT_OUT_NAME = 'hr_optout';

export const OPT_OUT_COOKIE = `${OPT_OUT_NAME}=1; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;

// Clearing has to expire BOTH names, each on the path it was written with, or
// an honest opt-back-in would leave the legacy copy behind and the reader
// would stay opted out for ever.
export const OPT_OUT_CLEAR_COOKIES = [
  `${OPT_OUT_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  `${LEGACY_OPT_OUT_NAME}=; Path=/r/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
];

// The stored cookie is the only thing that decides. A query parameter used to
// decide it too, which meant a GET changed the preference — and a GET is
// reachable by a mailed link and by the shared document's own script, which
// may navigate its browsing context even from an opaque origin. Both could
// therefore switch tracking off across every sender's shares, or switch it
// back on after the recipient had turned it off. See issueOptOutToken.
//
// Deliberately NOT parseCookies: that is last-wins, which is the bug above.
export function isTrackingOptedOut(cookieHeader: string | null): boolean {
  return optOutCopies(cookieHeader).some((c) => c.value === '1');
}

// True when the reader's opt-out is recorded ONLY under the old name, which is
// the signal to write the new one alongside it. Every reader who opted out
// before this change migrates on their next open, after which the preference
// sits under a name nobody else can write.
export function optOutNeedsMigration(cookieHeader: string | null): boolean {
  const copies = optOutCopies(cookieHeader);
  return (
    copies.some((c) => c.name === LEGACY_OPT_OUT_NAME && c.value === '1') &&
    !copies.some((c) => c.name === OPT_OUT_NAME && c.value === '1')
  );
}

function optOutCopies(cookieHeader: string | null): Array<{ name: string; value: string }> {
  if (!cookieHeader) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const part of cookieHeader.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx);
    if (name !== OPT_OUT_NAME && name !== LEGACY_OPT_OUT_NAME) continue;
    out.push({ name, value: part.slice(idx + 1) });
  }
  return out;
}

// Confirmation token for the opt-out POST.
//
// `GET /r/{slug}?optout=1|0` only asks the question and mints one of these;
// the POST that carries it back is the only thing that writes the cookie. An
// attacker can reach the GET but cannot produce the signature, so the write
// stays behind a deliberate click.
//
// Message is `optout|slug|hostname|expiry`, so a token minted to turn tracking
// off cannot be replayed to turn it back on, nor moved to another share, nor
// moved to another hostname.
//
// The hostname is in the signature because a customer's own domain is now one
// of the hosts these pages are served on (schema/052). `hr_optout` has no
// Domain attribute, so it belongs to the exact host that set it and a token
// carried across hosts could only ever write a cookie the recipient did not
// ask for on that host. Bound here for the same reason the print grant binds
// its hostname: a signed thing minted on one host should not spend on another.
//
// THE BROWSER IS IN THE SIGNATURE TOO, and without it the token was forgeable.
// Everything above binds the token to a question, a share and a host — all
// facts an attacker knows. Nothing bound it to the browser being asked, so an
// attacker could fetch `?optout=0` themselves, take the token, and auto-submit
// it from a page of their own as a top-level form post. That turned a victim's
// tracking back on over their choice, and once the reader identifier was
// cleared on the same response it reset their identity as well.
//
// So the confirmation page now also sets a random challenge cookie, and the
// token signs that challenge. An attacker can still mint a token, but only one
// signed over THEIR challenge, and they can neither read nor set the victim's.
// The victim's browser rejects the submission because its cookie does not
// match what the token was signed over.
//
// WHY SameSite=None, AND WHY THAT IS NOT A HOLE. The confirmation page carries
// the same opaque-origin sandbox every other proxy response does, and a
// document in an opaque origin has no registrable domain, so the browser
// treats even a post back to the page's own host as cross-site — the same
// reason wrapper.ts may not be sandboxed. A Lax cookie is not sent on a
// cross-site POST, so a Lax challenge would never arrive and every genuine
// confirmation would fail. None is what makes the genuine post work.
//
// It costs nothing, because the site check was never the defence here. The
// defence is that the challenge is 128 unguessable bits the attacker cannot
// read (HttpOnly, and a different origin to theirs) and cannot set (no Domain,
// and they do not control this host). A forged post does carry the victim's
// challenge cookie, and is refused anyway, because the attacker's token is
// signed over a different value.
// `__Host-` HERE TOO, and without it the challenge was itself plantable —
// which handed back the whole forgery the challenge exists to stop. A customer
// owning acme.com could load their own confirmation page on decks.acme.com to
// get a matching pair, plant `hr_optout_c=<their challenge>; Domain=acme.com`
// in a reader's browser from any page on acme.com, and auto-submit their token
// with optout=0. The reader normally holds no challenge of their own, so the
// duplicate rule never fires, cookie and token agree, and the sender forcibly
// resumes tracking somebody who had opted out.
//
// The prefix forbids Domain and requires Secure and Path=/, so only this exact
// host can write the name. It permits SameSite=None, which this cookie needs
// for the reason below.
const OPT_OUT_CHALLENGE_COOKIE = '__Host-hr_optout_c';
const OPT_OUT_TOKEN_TTL_SECONDS = 10 * 60;

export function newOptOutChallenge(): string {
  return newPrintSecret();
}

// Its life is the token's life: a stale challenge and a stale token expire
// together, and the page re-asks with a fresh pair.
export function optOutChallengeCookie(challenge: string): string {
  return `${OPT_OUT_CHALLENGE_COOKIE}=${challenge}; Path=/; Max-Age=${OPT_OUT_TOKEN_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`;
}

export const OPT_OUT_CHALLENGE_CLEAR_COOKIE = `${OPT_OUT_CHALLENGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;

export function readOptOutChallenge(cookieHeader: string | null): string | null {
  return readSingleHexCookie(cookieHeader, OPT_OUT_CHALLENGE_COOKIE);
}

export async function issueOptOutToken(
  optout: string,
  slug: string,
  hostname: string,
  challenge: string,
  secret: string,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + OPT_OUT_TOKEN_TTL_SECONDS;
  return `${expiresAt}.${await hmacHex(optOutMessage(optout, slug, hostname, challenge, expiresAt), secret)}`;
}

export async function verifyOptOutToken(
  token: string,
  optout: string,
  slug: string,
  hostname: string,
  challenge: string | null,
  secret: string,
): Promise<boolean> {
  // No challenge cookie, nothing to verify against. A submission that arrives
  // without one never saw the confirmation page in this browser.
  if (!challenge) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, mac] = parts as [string, string];
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(
    optOutMessage(optout, slug, hostname, challenge, expiresAt),
    secret,
  );
  return constantTimeEqual(mac, expected);
}

const optOutMessage = (
  optout: string,
  slug: string,
  hostname: string,
  challenge: string,
  expiresAt: number,
): string => `${optout}|${slug}|${hostname}|${challenge}|${expiresAt}`;

// The print grant, and why printing needs one.
//
// A browser printing a page that contains a frame prints only the part on
// screen, so Cmd+P breaks inside the wrapper and the strip has to offer Print
// itself. The first draft answered with a public /r/{slug}?print=1 address,
// and that was a way ROUND the badge: a sender could email it directly or hide
// it behind a fake strip, and the only HTMLRadar mark on it is the free-tier
// footer injected into the sender's own document, which the sender's own code
// can remove.
//
// So the print address is not public. Serving the wrapper sets a random,
// script-inaccessible cookie — HttpOnly, so the framed document cannot read
// it, and no Domain attribute, so it belongs to that exact hostname — and the
// strip's Print link carries a grant signed over the slug, that hostname and
// the cookie's value, with ten minutes' life.
//
// Four properties follow, and they are what print-grant.test.ts pins:
//   - copied into another browser, the grant has no matching cookie: dead.
//   - copied to another share, the slug does not match: dead.
//   - copied to another hostname, the hostname does not match: dead.
//   - kept for a quarter of an hour: expired.
// Every one of those redirects to the wrapper, where a live grant is minted,
// so a genuine reader is never dead-ended — they are put back in front of the
// badge, which is the whole point.
//
// Format `{expiry}.{hex hmac}`, hex so the value needs no encoding thought in
// an href. Message is prefixed `print:`, so no other token in this file can be
// replayed as one of these, or one of these as another.
// `__Host-` for the same reason as the others, and this one is not academic.
// The grant is signed over the cookie's value, so a sender who could plant
// that value in a reader's browser could also mint a grant that matches it and
// mail the reader a working /print address — which is precisely the way ROUND
// the trust badge this cookie was introduced to close. The prefix means only
// this host can write the name.
const PRINT_COOKIE_NAME = '__Host-hr_print';
const PRINT_GRANT_TTL_SECONDS = 10 * 60;
// A day, so a reader who leaves the tab open overnight and prints in the
// morning re-uses the same binding rather than losing it. The GRANT is the
// short-lived half; this is only the thing it is bound to.
const PRINT_COOKIE_MAX_AGE = 24 * 60 * 60;

// Path=/ because the `__Host-` prefix requires it. Every host this worker
// serves carries documents and nothing else, so the wider path costs nothing.
export function printCookie(secret: string): string {
  return `${PRINT_COOKIE_NAME}=${secret}; Path=/; Max-Age=${PRINT_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

// Single-copy read, like the other two: a second copy of the name is a
// shadowing attempt, and trusting neither is what makes it worthless.
export function readPrintCookie(cookieHeader: string | null): string | null {
  return readSingleHexCookie(cookieHeader, PRINT_COOKIE_NAME);
}

export function newPrintSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issuePrintGrant(
  slug: string,
  hostname: string,
  cookieSecret: string,
  secret: string,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + PRINT_GRANT_TTL_SECONDS;
  const mac = await hmacHex(printMessage(slug, hostname, cookieSecret, expiresAt), secret);
  return `${expiresAt}.${mac}`;
}

export async function verifyPrintGrant(
  grant: string | null,
  slug: string,
  hostname: string,
  cookieHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!grant) return false;
  const cookieSecret = readPrintCookie(cookieHeader);
  if (!cookieSecret) return false;
  const parts = grant.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, mac] = parts as [string, string];
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(printMessage(slug, hostname, cookieSecret, expiresAt), secret);
  return constantTimeEqual(mac, expected);
}

const printMessage = (
  slug: string,
  hostname: string,
  cookieSecret: string,
  expiresAt: number,
): string => `print:${slug}|${hostname.toLowerCase()}|${cookieSecret}|${expiresAt}`;

// The returning reader, and why the identifier moved into a cookie.
//
// Until 31 August the tracker kept a random UUID in the document's
// localStorage, and that value is how a reader who opened the same document
// twice was recognised as one person rather than two. The opaque-origin
// sandbox that landed that day makes every storage call inside a proxy-served
// document throw, so the tracker minted a fresh identifier on every load: each
// open looked like a brand-new person, the sender got another "someone opened
// your document" email every time, and the unique-reader count inflated. A
// cookie this worker sets is the only store the value can survive in, for the
// same reason `hr_optout` is one.
//
// HttpOnly, so the sender's own HTML can neither read this value from
// document.cookie nor write one.
//
// THE `__Host-` PREFIX IS THE CONTROL, and a plain name was not enough. A
// cookie's host scope is not a property of the host that set it: any parent
// domain can write a cookie that descendants receive. A customer who points
// decks.acme.com at us also controls acme.com, so with a plain `hr_rid` they
// could set `hr_rid=<value of their choosing>; Domain=acme.com; Path=/r/`
// before a recipient ever visited, then request both documents themselves
// carrying the same value, learn the identifiers it derives to, and recognise
// or fabricate that reader. Browsers refuse to set a `__Host-` cookie that
// carries a Domain attribute at all, so the name can only ever have been
// written by this exact host.
//
// The prefix comes with two conditions and both are met below: Secure, and
// `Path=/`. The path is wider than the `/r/` these cookies used to take. That
// costs nothing — every host this worker serves carries documents and nothing
// else — and the narrower scope was never available anyway, since the
// first-open dedup in the database recognises a return by matching prior
// sessions across every share of the SAME document, so a per-share cookie
// would break recognition rather than tighten it.
const READER_COOKIE_NAME = '__Host-hr_rid';
// Ninety days is long enough to cover re-reading a document somebody sent you
// and comfortably shorter than the unbounded life the localStorage value had
// on Chrome and Firefox.
const READER_COOKIE_MAX_AGE = 90 * 24 * 60 * 60;

export function readerCookie(secret: string): string {
  return `${READER_COOKIE_NAME}=${secret}; Path=/; Max-Age=${READER_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

// Opting out wipes the identifier as well as recording the choice, which is
// what the tracker's own optOut() does to the localStorage copy.
export const READER_CLEAR_COOKIE = `${READER_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function readReaderCookie(cookieHeader: string | null): string | null {
  return readSingleHexCookie(cookieHeader, READER_COOKIE_NAME);
}

// One value for the name, or none at all.
//
// A Cookie header may carry the same name more than once — that is exactly
// what a shadowing attempt looks like, a planted cookie sitting beside the
// genuine one — and the browser does not say which is which. Taking the last
// one, as an ordinary name-to-value parse does, hands the choice to whoever
// managed to write the second. Refusing the whole name instead means the
// worker mints a fresh identifier, so a shadowing attempt costs the attacker
// their own planted value and tells them nothing about the reader.
//
// The 32-hex shape is checked here too: anything else was not minted by
// newReaderSecret or newOptOutChallenge and is not treated as though it were.
function readSingleHexCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0 || part.slice(0, idx) !== name) continue;
    if (found !== null) return null; // more than one: trust none of them
    found = part.slice(idx + 1);
  }
  return found && /^[0-9a-f]{32}$/.test(found) ? found : null;
}

// The same 128 bits of randomness the print cookie carries.
export const newReaderSecret = newPrintSecret;

// What the tracker is handed is NOT the cookie's value. It is an HMAC of that
// value and the document being read, so the identifier that exists in the page
// is specific to one document: two shares of the same document agree, which is
// what the database's dedup needs, and two different documents do not.
//
// This matters because the sender's own HTML shares a scripting context with
// the tracker and can read anything given to it in the page (it could read the
// localStorage value before 31 August too, since the document was not
// sandboxed then). Binding the in-page value to the document means the worst a
// sender's script can learn is an opaque string that is useless anywhere but
// on their own document, and the cookie's raw value never reaches the page at
// all.
export async function deriveReaderId(
  cookieSecret: string,
  documentId: string,
  secret: string,
): Promise<string> {
  return hmacHex(`reader:${cookieSecret}|${documentId}`, secret);
}

// The rate-limit identity for an abuse report, and the only thing about the
// reporter that leaves this worker.
//
// The report itself is anonymous — no sign-in, no address field — but "five an
// hour" has to count something. This is that something: an HMAC of the
// connecting address under SESSION_SECRET, so the database stores an opaque
// string and never the address, and a reader of that table cannot walk the
// hash back by trying every address in the world, because the key is not in
// the database.
//
// An empty address (no CF-Connecting-IP, which is every local run and no
// production request) hashes to one stable value, so those reporters share a
// single budget. That fails toward more limiting, which is the right way for
// a limit to fail.
export async function hashReporterAddress(address: string, secret: string): Promise<string> {
  return hmacHex(`abuse-reporter:${address}`, secret);
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

async function hmacBytes(message: string, secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

async function hmac(message: string, secret: string): Promise<string> {
  return base64url(await hmacBytes(message, secret));
}

async function hmacHex(message: string, secret: string): Promise<string> {
  return [...(await hmacBytes(message, secret))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64url(bytes: Uint8Array): string {
  return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
