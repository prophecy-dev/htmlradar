// Stateless HMAC-signed cookies for the password and email gates.
//
// Password cookie: `{slug}.{expiry}.{hmac}`        HMAC over `{slug}:{expiry}`
// Email cookie:    `{slug}.{b64email}.{expiry}.{hmac}`  HMAC over `{slug}:{email}:{expiry}`
//
// Stateless — we never store gate sessions; the cookie itself is the proof
// of having passed the gate.
//
// ---------------------------------------------------------------------------
// MESSAGE AMBIGUITY: THE AUDIT, 21 September 2026.
//
// Astra found that two of these messages could be made identical by putting a
// delimiter inside a field, and forged a verified cookie out of an ordinary
// one. Everything signed here was then examined for the same class. New
// purposes go through signPurpose (see the note above it), which cannot have
// this problem. The formats below are UNCHANGED, because rewriting them would
// invalidate every cookie a reader is holding and sign people out mid-visit.
// Each is kept only because it was shown not to be reachable, and the
// character rule each argument leans on is pinned in
// tests/message-ambiguity.test.ts so a future widening cannot quietly undo it.
//
// The fields and what may appear in them:
//   slug      `[a-z0-9-]+`, enforced by the route regex AND by
//             validate_share_slug (schema/033). No colon, no pipe, no '@'.
//   email     EMAIL_REGEX in index.ts is `[^\s@]+@[^\s@]+\.[^\s@]+` — it
//             ALLOWS a colon and a pipe, and it ALWAYS contains an '@'.
//   expiry    decimal digits only; parsed with parseInt and re-rendered from a
//             number, so a non-numeric segment can never round-trip.
//   hostname  a URL hostname: letters, digits, dots, hyphens. No '@'.
//   secrets   32 lowercase hex characters (print cookie, challenges, reader).
//   docId     `[a-f0-9-]{8,}`. No '@'.
//
// Pair by pair:
//
//   verified vs e-mail cookie — EXPLOITABLE, and this was the finding.
//     `verified:{slug}:{email}:{exp}` against `{slug}:{email}:{exp}`. `verified`
//     is a legal slug and the address may contain a colon, so an e-mail cookie
//     for the link `verified` with the address `target:real@x.y` produces the
//     verified message for `target`. FIXED: the verified cookie is the one
//     format here that has been migrated to signPurpose, because it is new and
//     nobody holds one yet.
//
//   password vs e-mail cookie — safe, and by two independent facts.
//     `{slug}:{exp}` against `{slug}:{email}:{exp}`. To read an e-mail message
//     as a password one the trailing segment would have to be the expiry, but
//     it would be `{email}:{exp}`, which parseInt cannot produce from a
//     re-rendered number. In the other direction a password message holds one
//     colon and an e-mail message at least two, since the slug cannot supply
//     one.
//
//   owner-preview and owner-doc-preview vs e-mail cookie — safe.
//     `owner-preview:{slug}:{exp}` against an e-mail message whose slug is
//     `owner-preview`, which is `owner-preview:{email}:{exp}`. They match only
//     if the address equals a slug or a document id, and both of those forbid
//     the '@' an address must contain.
//
//   the pipe family — print grant, opt-out token, reader id, abuse reporter —
//     vs the colon family: safe, on one fact that covers all of them. An
//     e-mail cookie's message ALWAYS contains an '@'. None of the fields in
//     any pipe-delimited message can contain one: slugs, hostnames, hex
//     secrets, document ids and connecting addresses all exclude it. So no
//     colon-family message carrying an address can equal a pipe-family message,
//     and the password message (which carries no address) cannot either,
//     because every pipe-family message begins with a literal prefix that is
//     not a legal expiry.
//
//   inside the pipe family: each message begins with a distinct literal
//     (`print:`, `reader:`, `abuse-reporter:`) or, for the opt-out token, with
//     `1|` or `0|`, which no other member can begin with.
//
//   the verification code hash vs the e-mail cookie — safe TODAY, by a
//     coincidence of length, which is exactly why it was migrated anyway.
//     The old `verify:{shareId}|{email}|{code}` could be read as an e-mail
//     message for the slug `verify` with the address `{shareId}|{email}` —
//     which does satisfy EMAIL_REGEX — and the code as the expiry. It fails
//     only because a code is six digits and an expiry is ten. That is too thin
//     a reason to rely on, so the code hash now goes through signPurpose too.

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
function readSingleCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0 || part.slice(0, idx) !== name) continue;
    if (found !== null) return null; // more than one: trust none of them
    found = part.slice(idx + 1);
  }
  return found;
}

// The 32-hex shape on top of that: anything else was not minted by
// newReaderSecret, newOptOutChallenge or newVerifyChallenge and is not
// treated as though it were.
function readSingleHexCookie(cookieHeader: string | null, name: string): string | null {
  const found = readSingleCookie(cookieHeader, name);
  return found && /^[0-9a-f]{32}$/.test(found) ? found : null;
}

// ---------------------------------------------------------------------------
// THE VERIFIED E-MAIL GATE (schema/055).
//
// Two cookies and one hash. The design and the failure list they answer are
// docs/workstreams/security/VERIFIED-EMAIL-GATE-BRIEF-2026-09-21.md.
//
// 1. THE CHALLENGE, `__Host-hr_vc`. Minted when a code is asked for, and the
//    code in the database is bound to it, so a code read over somebody's
//    shoulder, forwarded, or lifted out of a mailbox by a scanner cannot be
//    spent in any browser but the one that asked. It is also the whole CSRF
//    defence for both gate posts, for the reason the opt-out challenge above
//    is: 128 unguessable bits an attacker can neither read (HttpOnly, and a
//    different origin to theirs) nor set (`__Host-`, so no Domain attribute is
//    accepted and only this exact host can write the name).
//
//    SameSite=None, for exactly the reason OPT_OUT_CHALLENGE_COOKIE is. Every
//    gate page carries the opaque-origin sandbox, and a document in an opaque
//    origin has no registrable domain, so the browser treats even a post back
//    to the page's own host as cross-site. A Lax cookie would never arrive and
//    every genuine verification would fail.
//
// 2. THE VERIFIED COOKIE, `__Host-hr_v_{slug}`. What the reader holds once the
//    code has come back. Its shape is the e-mail cookie's, with a different
//    message prefix so neither can be replayed as the other — and THAT is what
//    makes decision 6 true: an ordinary e-mail cookie, however it was obtained,
//    can never satisfy a link that requires verification, because a link that
//    requires verification looks at this name and nothing else.
//
//    The name carries the slug because `__Host-` forces `Path=/`, so one name
//    would be one cookie for the whole host and verifying on a second link
//    would silently sign the reader out of the first.
//
// 3. THE CODE HASH. What the worker sends the database in place of the code.
//    HMAC-SHA256 under SESSION_SECRET over the share, the address and the code
//    together, so a stored hash is bound to all three: the row cannot be made
//    to match on another link or for another address, and the database — which
//    does not hold the key — cannot turn the hash back into the six digits.
const VERIFY_CHALLENGE_COOKIE = '__Host-hr_vc';
const VERIFY_CHALLENGE_TTL_SECONDS = 10 * 60;
const VERIFIED_PREFIX = '__Host-hr_v_';

export const newVerifyChallenge = newPrintSecret;

export function verifyChallengeCookie(challenge: string): string {
  return `${VERIFY_CHALLENGE_COOKIE}=${challenge}; Path=/; Max-Age=${VERIFY_CHALLENGE_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`;
}

export const VERIFY_CHALLENGE_CLEAR_COOKIE = `${VERIFY_CHALLENGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;

export function readVerifyChallenge(cookieHeader: string | null): string | null {
  return readSingleHexCookie(cookieHeader, VERIFY_CHALLENGE_COOKIE);
}

/** Six digits from the platform's cryptographic source, uniformly. */
export function newVerificationCode(): string {
  // Rejection sampling rather than `% 1000000`, which would make the first
  // 696 codes very slightly likelier than the rest. The loop ends on the first
  // draw better than 998 times in a thousand.
  const bytes = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(bytes);
    n = bytes[0]!;
  } while (n >= 4_294_000_000);
  return String(n % 1_000_000).padStart(6, '0');
}

export async function hashVerificationCode(
  shareId: string,
  email: string,
  code: string,
  secret: string,
): Promise<string> {
  return signPurposeHex('verify-code-hash', [shareId, email.toLowerCase(), code], secret);
}

export async function issueVerifiedCookie(
  slug: string,
  email: string,
  secret: string,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const b64 = base64urlEncode(new TextEncoder().encode(email));
  const mac = await signPurpose('verified-email-cookie', [slug, email, String(expiresAt)], secret);
  return [
    `${VERIFIED_PREFIX}${slug}=${slug}.${b64}.${expiresAt}.${mac}`,
    'Path=/',
    `Max-Age=${TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export async function verifyVerifiedCookie(
  cookieHeader: string | null,
  slug: string,
  secret: string,
): Promise<VerifiedEmail | null> {
  // Single-copy, like every other `__Host-` read in this file: a second copy
  // of the name is a shadowing attempt, and trusting neither is what makes it
  // worthless.
  const raw = readSingleCookie(cookieHeader, `${VERIFIED_PREFIX}${slug}`);
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
  const expected = await signPurpose(
    'verified-email-cookie',
    [slug, email, String(expiresAt)],
    secret,
  );
  return constantTimeEqual(mac, expected) ? { slug, email, expiresAt } : null;
}

// ---------------------------------------------------------------------------
// THE COMMENT PROOF, AND WHY A COMMENT CANNOT TRUST ITS SESSION'S ADDRESS.
//
// A session's address comes from the /t/start_session body, which anybody can
// write. Checking only that the address had verified on the link (review,
// 23 September 2026, high) let whoever held a forwarded link start a session
// as the boss who verified yesterday and comment in the boss's name — and the
// difference between a stored comment and a refusal told them who had.
//
// So the right to comment is minted where the verified cookie is actually
// read: when the proxy serves the deck to a reader holding one, it signs the
// link and that cookie's address into the page, and /t/comment is refused
// unless the proof matches the link and the address of the session it is
// posted on. The session supplies both; the request supplies neither.
//
// It never outlives the cookie it stands for, and is capped below that, so a
// proof copied out of a page stops working the same day.
const COMMENT_PROOF_TTL_SECONDS = 12 * 60 * 60;

export async function issueCommentProof(
  slug: string,
  email: string,
  cookieExpiresAt: number,
  secret: string,
): Promise<string> {
  const expiresAt = Math.min(
    cookieExpiresAt,
    Math.floor(Date.now() / 1000) + COMMENT_PROOF_TTL_SECONDS,
  );
  const mac = await signPurposeHex(
    'comment-proof',
    [slug, email.toLowerCase(), String(expiresAt)],
    secret,
  );
  return `${expiresAt}.${mac}`;
}

export async function verifyCommentProof(
  proof: string | null,
  slug: string,
  email: string,
  secret: string,
): Promise<boolean> {
  if (!proof) return false;
  const parts = proof.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, mac] = parts as [string, string];
  // Digits only, so the expiry that is signed is exactly the one that was sent:
  // parseInt would read "123abc" as 123 and check a MAC over a string nobody
  // signed — harmless, but there is no reason to accept it.
  if (!/^\d{1,12}$/.test(expiryStr)) return false;
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await signPurposeHex(
    'comment-proof',
    [slug, email.toLowerCase(), String(expiresAt)],
    secret,
  );
  return constantTimeEqual(mac, expected);
}

// ---------------------------------------------------------------------------
// THE SIGNED FORM TOKEN, AND WHY THE CHALLENGE COOKIE ALONE WAS NOT ENOUGH
// (Astra, finding 2).
//
// The challenge is `SameSite=None`, because every gate page is sandboxed into
// an opaque origin and a Lax cookie would never come back. That also means the
// victim's browser attaches it to a form an ATTACKER auto-submits from their
// own sandboxed frame, which sends `Origin: null` too. So possession of the
// cookie proved nothing: two forged posts could ask for a code to an address
// the attacker controls and then spend it in the victim's browser, after which
// every read carried the attacker's identity; and five forged wrong guesses
// could burn the code the victim was waiting on.
//
// This is the defence the opt-out confirmation has had all along, brought
// here: the page that renders a form also mints a token signed over the
// challenge in that browser's cookie, and the post is refused unless the two
// agree. An attacker can mint a token — but only over THEIR challenge, which
// is not the one the victim's browser will send, and they can neither read nor
// write the victim's.
//
// The share is in the signature so a token cannot be moved between links, and
// the code form's token also carries the address, so a token obtained for one
// address cannot be replayed to request or spend a code for another.
const GATE_TOKEN_TTL_SECONDS = 10 * 60;

export async function issueGateToken(
  step: 'email' | 'code',
  slug: string,
  challenge: string,
  email: string,
  secret: string,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + GATE_TOKEN_TTL_SECONDS;
  const mac = await signPurposeHex(
    'verify-form-token',
    [step, slug, challenge, email, String(expiresAt)],
    secret,
  );
  return `${expiresAt}.${mac}`;
}

export async function verifyGateToken(
  token: string | null,
  step: 'email' | 'code',
  slug: string,
  challenge: string | null,
  email: string,
  secret: string,
): Promise<boolean> {
  // No challenge cookie means this browser never saw the form that mints the
  // token, so there is nothing the token could honestly be bound to.
  if (!token || !challenge) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, mac] = parts as [string, string];
  const expiresAt = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await signPurposeHex(
    'verify-form-token',
    [step, slug, challenge, email, String(expiresAt)],
    secret,
  );
  return constantTimeEqual(mac, expected);
}

/**
 * Both gate posts have to have come from a page of ours in this browser.
 *
 * ITEM E OF THE BRIEF ASKS FOR THE SIGN-IN FIX'S EXACT RULE — mandatory
 * Origin, `null` accepted only with `Sec-Fetch-Site: same-origin` — AND THAT
 * RULE CANNOT BE APPLIED HERE. Every gate page carries the opaque-origin
 * sandbox (see withNoIndex in index.ts), and a page in an opaque origin posts
 * with `Origin: null` AND `Sec-Fetch-Site: cross-site`, because the browser
 * derives "same-site" from the initiator's site and an opaque origin has none.
 * Requiring `same-origin` would therefore refuse every genuine submission from
 * our own page — which is the 21 September outage repeated, not avoided.
 *
 * SO THE RULE IS THE ONE THE OPT-OUT ALREADY USES, and it is stronger here
 * than an Origin check would be:
 *
 *   * Origin is mandatory and must be `null` (our own sandboxed page) or this
 *     host. A page at evil.com posting here sends `Origin: https://evil.com`
 *     and is refused on that alone; a non-browser client sends none and is
 *     refused too.
 *   * The challenge cookie is the defence that does the work, because an
 *     attacker CAN produce `Origin: null` by sandboxing a frame of their own.
 *     They cannot produce the victim's challenge: it is 128 bits they cannot
 *     read and cannot write, and the code they would be spending is bound to
 *     it in the database.
 *
 * The gate pages are also served `Referrer-Policy: strict-origin` rather than
 * `no-referrer`, which item E asks for and which costs nothing — the sandbox
 * decides the Origin either way, and `no-referrer` is the header that took
 * sign-in down.
 */
export function isOwnGatePost(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === 'null') return true;
  return origin.toLowerCase() === url.origin.toLowerCase();
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

// ---------------------------------------------------------------------------
// ONE SIGNING HELPER, AND WHY THIS FILE NOW HAS ONE.
//
// THE BUG IT EXISTS TO MAKE IMPOSSIBLE (Astra, 21 September 2026, critical).
// Every signed thing here used to build its message by joining fields with a
// delimiter — `${slug}:${email}:${expiry}` for the e-mail cookie,
// `verified:${slug}:${email}:${expiry}` for the verified one. Those two are the
// same string when a field is allowed to contain the delimiter. The e-mail
// regex permits a colon, and `verified` is a perfectly legal custom link
// ending, so an ordinary unrestricted link called `verified`, entered with the
// address `acme-proposal:buyer@acme.test`, produces a signature over
// `verified:acme-proposal:buyer@acme.test:<expiry>` — byte for byte the
// message the VERIFIED cookie for `acme-proposal` is checked against.
// Repackaged under the verified cookie's name, the real verifier accepted it,
// and the document and its attachments opened with no code. I reproduced it
// with these functions before fixing it.
//
// THE FIX IS THE CLASS, NOT THE INSTANCE. A message is now the JSON encoding
// of an array whose first element is the purpose. JSON escapes the quotes and
// the separators inside every element, so no field's CONTENT can move a
// boundary: `["verified","acme-proposal","buyer@acme.test","123"]` cannot be
// produced by any other purpose or any other field values, because the
// brackets and quotes are structure the fields cannot forge. Purposes are
// distinct labels, so two purposes can never share a message even with
// identical fields.
//
// Anything signed in this file should go through here. Where an OLD format is
// still in use it is because changing it would sign every reader out mid-visit,
// and each one carries a comment saying why its own ambiguity is not reachable,
// with a test in tests/message-ambiguity.test.ts pinning the character rule it
// leans on.
type Purpose = 'verified-email-cookie' | 'verify-form-token' | 'verify-code-hash' | 'comment-proof';

function purposeMessage(purpose: Purpose, fields: string[]): string {
  return JSON.stringify([purpose, ...fields]);
}

async function signPurpose(purpose: Purpose, fields: string[], secret: string): Promise<string> {
  return hmac(purposeMessage(purpose, fields), secret);
}

async function signPurposeHex(purpose: Purpose, fields: string[], secret: string): Promise<string> {
  return hmacHex(purposeMessage(purpose, fields), secret);
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
