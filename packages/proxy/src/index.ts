// Worker entry: the recipient side of the internal deck tracker.
//
// Routes:
//   GET  /r/{slug}             serves the document, gates as needed
//   POST /r/{slug}/auth        password submission
//   POST /r/{slug}/email       email submission (plain gate, or step one of the verified gate)
//   POST /r/{slug}/verify      the six-digit code, on a link that asks for one
//   GET  /r/{slug}/m/{att_id}  downloads a supporting-material attachment
//   GET  /r/{slug}/og-image    the link's unfurl image, from R2
//   GET  /r/_doc/{doc_id}      sender-side raw-doc preview (HMAC-gated)
//   POST /t/start_session      the tracker's session start (CORS, text/plain JSON)
//   POST /t/update_session     the tracker's heartbeat; fires the first-read alert
//   POST /t/comment            a verified reader's note to the sender
//   GET  /v1/tracker.js        the tracker, bundled into this worker
//   GET  /v1/tracker.{v}.js    the same tracker at its content-derived address
//   GET  /privacy              what a link records, for recipients
//   GET  /robots.txt           Disallow: / — nothing here is a website
//
// Anything else is a 404, and every response carries X-Robots-Tag: noindex.
//
// The share route also carries the recipient's own switch for read tracking:
//   GET  /r/{slug}?optout=1|0  asks the question and mints a token
//   POST /r/{slug}             with `optout` + `token` writes the cookie
//
// Gate order: password → email (plain or verified) → content. Each gate issues
// an HMAC-signed cookie on success (see auth.ts). The document body is only
// ever streamed when every applicable gate has passed.
//
// Unfurl bots (og.ts) get the share's card and nothing else — no gate, no
// document, no tracker — so a link preview is never counted as a read.

import type { Env } from './env.js';
import {
  getShareBySlug,
  getDocument,
  getAttachment,
  listAttachmentsForDocument,
  logAttachmentDownload,
  getViewerIdByShareEmail,
  verifySharePassword,
  issueVerificationCode,
  checkVerificationCode,
  startSession,
  updateSession,
  addComment,
  RpcFailure,
  UpstreamError,
  type Attachment,
  type Share,
} from './store.js';
import {
  deriveReaderId,
  hashReporterAddress,
  issueAuthCookie,
  issueEmailCookie,
  issueOptOutToken,
  isTrackingOptedOut,
  optOutNeedsMigration,
  newOptOutChallenge,
  newReaderSecret,
  optOutChallengeCookie,
  readerCookie,
  readOptOutChallenge,
  readReaderCookie,
  verifyAuthCookie,
  verifyEmailCookie,
  verifyOptOutToken,
  verifyOwnerDocPreviewToken,
  verifyOwnerPreviewToken,
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
import { TRACKER_JS, TRACKER_VERSION } from './tracker-bundle.js';
import { documentCsp, FRAME_SANDBOX } from './csp.js';
import { cardFor, isUnfurlBot, ogOnlyPage, type OgCard } from './og.js';
import {
  emailGateForm,
  expired,
  notFound,
  optOutConfirm,
  passwordForm,
  privacyPage,
  revoked,
  sourceUnreachable,
  verifyCodeForm,
  withCard,
} from './responses.js';
import { brandOf, sendCommentAlert, sendFirstReadAlert, sendVerificationCode } from './mail.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// THE TIMING FLOOR on the verified gate's first step. Both the permitted and
// the refused address make the identical database call and the send runs after
// the reply (ctx.waitUntil), so nothing on the clock says whether an address
// is on the allow-list; the floor is insurance that it stays that way.
const GATE_FLOOR_MS = 750;
const gateFloorMs = (env: Env): number => {
  const raw = Number.parseInt(env.GATE_FLOOR_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : GATE_FLOOR_MS;
};
// Checking a code touches no third party; this only flattens "no such code"
// against "wrong code", which the database already equalises.
const VERIFY_FLOOR_MS = 250;
// How long the mail binding gets before a send is called a failure.
const SEND_TIMEOUT_MS = 10_000;
// Tracker request bodies are small; anything bigger is not the tracker.
const MAX_T_BODY = 64 * 1024;

/** Waits until `ms` have passed since `started`. Returns at once if they have. */
async function padTo(started: number, ms: number): Promise<void> {
  const left = ms - (Date.now() - started);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}

// Where the injected <script> points. Relative by default, so the tracker is
// first-party to the document that loads it, at its content-derived address.
const TRACKER_PATH_RE = /^\/v1\/tracker(?:\.([a-z0-9]+))?\.js$/;
const TRACKER_VERSION_HEADER = 'X-Tracker-Version';
const trackerSrc = (env: Env): string => env.TRACKER_URL || `/v1/tracker.${TRACKER_VERSION}.js`;

const isLocal = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

// Every response here is a recipient-facing page for somebody's document, and
// none of it should ever appear in a search result. Also: every response that
// sets no policy of its own is sandboxed into an opaque origin. Responses
// carrying customer HTML already set the whole policy through documentCsp.
function withNoIndex(res: Response, env: Env): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('X-HTMLRadar-Version', env.GIT_SHA ?? 'dev');
  if (!out.headers.has('Content-Security-Policy')) {
    out.headers.set('Content-Security-Policy', `sandbox ${FRAME_SANDBOX}`);
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return withNoIndex(await handleRequest(request, env, ctx), env);
    } catch (err) {
      // A transient database failure must not masquerade as a deleted share —
      // show the try-again page. Genuine bugs still surface as a 500.
      if (err instanceof UpstreamError) {
        console.error('upstream', err.message);
        return withNoIndex(sourceUnreachable(), env);
      }
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // A recipient document must never travel in the clear. `wrangler dev`
  // serves plain HTTP on localhost, which is exempt.
  if (url.protocol === 'http:' && !isLocal(url.hostname)) {
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }

  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
    return privacyPage({ brand: brandOf(env), contact: env.PRIVACY_CONTACT || null });
  }

  // The tracker's calls.
  const tMatch = /^\/t\/(start_session|update_session|comment)$/.exec(url.pathname);
  if (tMatch) return handleTrackerCall(tMatch[1] as TrackerCall, request, env, ctx);

  const trackerMatch = TRACKER_PATH_RE.exec(url.pathname);
  if (trackerMatch) {
    // The current version at its own address is immutable forever. Any other
    // segment — an older deploy's address a browser still holds — gets the
    // current script on a short lifetime: losing tracking is worse than a
    // redundant fetch.
    const pinned = trackerMatch[1] === TRACKER_VERSION;
    return new Response(TRACKER_JS, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': pinned
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300, must-revalidate',
        // A sandboxed document is an opaque origin; the script is fetched
        // cross-origin whenever the browser treats it as a CORS request.
        'Access-Control-Allow-Origin': '*',
        [TRACKER_VERSION_HEADER]: TRACKER_VERSION,
      },
    });
  }

  // Sender's "Preview document", minted by the dashboard: bound to a doc_id,
  // no share, no gates, no tracker.
  //   /r/_doc/{doc_id}?owner_doc_preview={token}
  const docPreviewMatch = /^\/r\/_doc\/([a-f0-9-]{8,})\/?$/i.exec(url.pathname);
  if (docPreviewMatch) {
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
    return new Response(await htmlResp.text(), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': documentCsp(),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  //   GET /r/{slug}/m/{attachment_id}
  const downloadMatch = /^\/r\/([a-z0-9-]+)\/m\/([a-f0-9-]{8,})\/?$/i.exec(url.pathname);
  if (downloadMatch) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return handleAttachmentDownload(
      request,
      downloadMatch[1]!.toLowerCase(),
      downloadMatch[2]!,
      env,
      ctx,
    );
  }

  const match = /^\/r\/([a-z0-9-]+)(?:\/(auth|email|verify|og-image))?\/?$/i.exec(url.pathname);
  if (!match) return notFound();
  // Lowercased rather than redirected: every stored slug is lowercase, and a
  // memorable address retyped or title-cased by a mail client must resolve.
  const slug = match[1]!.toLowerCase();
  const subroute = match[2]?.toLowerCase();

  const share = await getShareBySlug(env, slug);
  if (!share) return notFound();

  const isDisabled =
    !!share.revoked_at || !!(share.expires_at && new Date(share.expires_at).getTime() < Date.now());

  if (subroute === 'og-image') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    return handleOgImage(share, isDisabled, env);
  }

  // The unfurl card, not the document. Before every gate: the card is what
  // the sender chose to show on a pasted link, gated or not, and a crawler
  // never gets further than this. A revoked or expired link unfurls as such.
  const card = cardFor(share, url.origin, brandOf(env));
  if (!subroute && request.method === 'GET' && isUnfurlBot(request.headers.get('user-agent'))) {
    if (share.revoked_at) return revoked();
    if (isDisabled) return expired();
    return ogOnlyPage(card);
  }

  // Read-tracking opt-out. Before the revoked/expired branch: the preference
  // is browser-wide, so a recipient can turn tracking off from a dead link too.
  if (!subroute) {
    if (request.method === 'POST') {
      const written = await handleOptOutSubmit(request, slug, url.hostname, env);
      if (written) return written;
    } else {
      const param = url.searchParams.get('optout');
      if (param === '1' || param === '0') return askOptOut(slug, param, url.hostname, env);
    }
  }

  // Owner preview: the dashboard mints a 10-minute HMAC token bound to this
  // slug. It bypasses revoked/expired/password/email and starts no session —
  // the owner is checking what the document looks like, not reading it.
  const previewToken = url.searchParams.get('owner_preview');
  const isOwnerPreview = previewToken
    ? await verifyOwnerPreviewToken(previewToken, slug, env.SESSION_SECRET)
    : false;

  if (!isOwnerPreview) {
    if (share.revoked_at) return revoked();
    if (isDisabled) return expired();
  }

  if (subroute === 'auth') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handlePasswordSubmit(request, share, env, card);
  }
  if (subroute === 'email') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleEmailSubmit(request, share, url, env, ctx, card);
  }
  // Exists only on a link that asks for a code; elsewhere the standard
  // not-found, so the route says nothing about a share's settings.
  if (subroute === 'verify') {
    if (!share.require_email || !share.verify_email) return notFound();
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleVerifySubmit(request, share, url, env, card);
  }

  if (share.require_password && !isOwnerPreview) {
    const cookie = await verifyAuthCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return withCard(passwordForm(slug), card);
  }

  // The email gate, per share: the cookie is HMAC-scoped to this slug, so a
  // fresh link asks again. A link that asks for a VERIFIED address looks only
  // at the verified cookie, which only the code step issues — turning the
  // option on makes readers already past the gate verify at their next open.
  // One branch, so the attachment route (which repeats this pair) and the
  // document cannot disagree.
  let verifiedEmail: string | undefined;
  if (share.require_email && !isOwnerPreview) {
    const cookie = share.verify_email
      ? await verifyVerifiedCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET)
      : await verifyEmailCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) {
      return withCard(
        share.verify_email ? await verifiedEmailGate(request, slug, env) : emailGateForm(slug),
        card,
      );
    }
    // Re-checked against the CURRENT allow-list on every request, so a stale
    // cookie cannot bypass a list the sender tightened later.
    if (!isEmailAllowed(share, cookie.email)) {
      const stale = 'This document is no longer shared with your address.';
      return withCard(
        share.verify_email
          ? await verifiedEmailGate(request, slug, env, stale)
          : emailGateForm(slug, stale),
        card,
      );
    }
    verifiedEmail = cookie.email;
  }

  const doc = await getDocument(env, share.document_id);
  if (!doc || doc.deleted_at) return notFound();

  const html = await fetchDocumentHtml(doc, env);
  if (!html) return sourceUnreachable();

  const geo = geoFromRequest(request);

  // Attachments are always surfaced when they exist. The owner's own preview
  // skips the lookup — they uploaded them.
  let attachments: Attachment[] = [];
  if (!isOwnerPreview) attachments = await listAttachmentsForDocument(env, doc.id);

  // An opted-out recipient gets the document and the same sandbox — just no
  // tracker, and therefore no session. The owner's preview is not a read.
  const optedOut = isTrackingOptedOut(request.headers.get('cookie'));
  const trackingEnabled = !isOwnerPreview && !optedOut;

  // The comment box exists only where a comment can be signed: a link that
  // asks for a verified address, read by somebody who proved theirs on this
  // very load. Every other reader — an ordinary e-mail gate, no gate at all,
  // the owner's own preview — is served a document with no box in it, because
  // an unsigned note is worth less to the sender than no note.
  //
  // Tracking off means no session, and a comment is written against a session,
  // so an opted-out reader has no box either. That is the honest order: a
  // reader who asked not to be recorded is not offered a way to be recorded.
  const commentsEnabled = trackingEnabled && share.verify_email && !!verifiedEmail;

  // The returning reader: `hr_rid` carries a random value on this host; the
  // tracker is handed that value bound to this document (deriveReaderId), so
  // it needs no browser storage — which the sandbox takes away.
  let readerId: string | undefined;
  const setCookies: string[] = [];
  if (trackingEnabled) {
    const existing = readReaderCookie(request.headers.get('cookie'));
    const secret = existing ?? newReaderSecret();
    if (!existing) setCookies.push(readerCookie(secret));
    readerId = await deriveReaderId(secret, share.document_id, env.SESSION_SECRET);
  } else if (optOutNeedsMigration(request.headers.get('cookie'))) {
    setCookies.push(OPT_OUT_COOKIE);
  }

  return injectTracker(html, {
    share,
    trackingEnabled,
    trackerUrl: trackerSrc(env),
    endpoint: url.origin,
    og: card,
    ...(commentsEnabled ? { comments: true } : {}),
    ...(verifiedEmail ? { email: verifiedEmail } : {}),
    ...(readerId ? { readerId } : {}),
    ...(setCookies.length > 0 ? { setCookies } : {}),
    ...(geo && Object.keys(geo).length > 0 ? { geo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

// ---------------------------------------------------------------- tracker calls

type TrackerCall = 'start_session' | 'update_session' | 'comment';

// The served document runs in an opaque origin, so every tracker call is
// cross-origin. The tracker sends text/plain without credentials (a simple
// request, no preflight); OPTIONS is answered anyway for any client that
// preflights. Nothing here reads a cookie, so `*` gives nothing away.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const tJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function handleTrackerCall(
  call: TrackerCall,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return tJson({ code: 'http_405', message: 'method' }, 405);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_T_BODY) return tJson({ code: 'http_413', message: 'too_large' }, 413);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return tJson({ code: 'http_400', message: 'bad_request' }, 400);
  }

  const str = (k: string): string | null =>
    typeof body[k] === 'string' ? (body[k] as string) : null;

  try {
    if (call === 'start_session') {
      // Location and device come from the request itself, not the page:
      // the network knows the country, and the page is somebody else's HTML.
      const geo = geoFromRequest(request) ?? {};
      const result = await startSession(env, {
        p_share_slug: str('p_share_slug') ?? '',
        p_email: str('p_email'),
        p_fingerprint: str('p_fingerprint'),
        p_referrer: str('p_referrer'),
        p_user_agent: request.headers.get('user-agent') ?? str('p_user_agent'),
        p_country_code: geo.country ?? str('p_country_code'),
        p_city: geo.city ?? str('p_city'),
        p_device_type: geo.deviceType ?? str('p_device_type'),
        p_os: geo.os ?? str('p_os'),
        p_browser: geo.browser ?? str('p_browser'),
      });
      return tJson(result);
    }
    if (call === 'comment') {
      const comment = await addComment(env, {
        p_session_id: str('p_session_id') ?? '',
        p_token: str('p_token') ?? '',
        p_section_id: str('p_section_id'),
        p_section_title: str('p_section_title'),
        p_body: str('p_body') ?? '',
      });
      // After the reply, like the first-read alert: the comment is stored
      // either way, and the reader must not wait on Telegram to see "sent".
      ctx.waitUntil(sendCommentAlert(env, comment.alert));
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const result = await updateSession(env, {
      p_session_id: typeof body['p_session_id'] === 'string' ? body['p_session_id'] : '',
      p_token: typeof body['p_token'] === 'string' ? body['p_token'] : '',
      p_active_seconds: Number(body['p_active_seconds'] ?? 0),
      p_max_scroll: Number(body['p_max_scroll'] ?? 0),
      p_sections: body['p_sections'] ?? [],
    });
    // After the reply: the alert must never slow or fail a heartbeat.
    if (result.alert) ctx.waitUntil(sendFirstReadAlert(env, result.alert));
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  } catch (err) {
    if (err instanceof RpcFailure) return tJson({ code: err.code, message: err.message }, 400);
    if (err instanceof UpstreamError) {
      console.error('tracker call', call, err.message);
      return tJson({ code: 'http_503', message: 'unavailable' }, 503);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- og image

async function handleOgImage(share: Share, isDisabled: boolean, env: Env): Promise<Response> {
  const key = share.document_og_image_r2_key;
  if (!key || isDisabled) return new Response('Not Found', { status: 404 });
  const obj = await env.DOCS_BUCKET.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  const type = obj.httpMetadata?.contentType ?? imageTypeOf(key);
  // Only images, whatever the object claims: this route is public.
  if (!type.startsWith('image/') || type.includes('svg')) {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function imageTypeOf(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    }[ext] ?? 'application/octet-stream'
  );
}

// ---------------------------------------------------------------- gates

/**
 * The address step on a link that asks for a verified address. The form's
 * token is signed over the challenge this browser is about to hold, so a post
 * arriving without both is refused. An existing challenge is reused so two tabs
 * do not invalidate each other's pending code.
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

/** Asking the opt-out question, the only thing that mints its challenge. */
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
 * The opt-out write. Returns null when this POST is not one. The GET only
 * asks: a shared document may navigate its own tab even from the sandbox, so a
 * plain navigation must never be able to flip a browser-wide preference.
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

  const challenge = readOptOutChallenge(request.headers.get('cookie'));
  if (!(await verifyOptOutToken(token, optout, slug, hostname, challenge, env.SESSION_SECRET))) {
    return askOptOut(slug, optout, hostname, env, 400);
  }

  // Either way the returning-reader identifier is wiped, and the challenge is
  // spent so the confirmation is single-use.
  const headers = new Headers({ Location: `/r/${slug}` });
  if (optout === '1') headers.append('Set-Cookie', OPT_OUT_COOKIE);
  else for (const c of OPT_OUT_CLEAR_COOKIES) headers.append('Set-Cookie', c);
  headers.append('Set-Cookie', READER_CLEAR_COOKIE);
  headers.append('Set-Cookie', OPT_OUT_CHALLENGE_CLEAR_COOKIE);
  return new Response(null, { status: 303, headers });
}

async function handlePasswordSubmit(
  request: Request,
  share: Share,
  env: Env,
  card: OgCard,
): Promise<Response> {
  const slug = share.slug;
  const form = await request.formData();
  const password = form.get('password');
  if (typeof password !== 'string' || password.length === 0) {
    return withCard(passwordForm(slug, 'Password is required.'), card);
  }
  const verdict = await verifySharePassword(env, slug, password);
  if (verdict === 'rate_limited') {
    return withCard(passwordForm(slug, 'Too many attempts. Wait a minute, then try again.'), card);
  }
  if (verdict !== 'ok') return withCard(passwordForm(slug, 'Incorrect password.'), card);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/r/${slug}`,
      'Set-Cookie': await issueAuthCookie(slug, env.SESSION_SECRET),
    },
  });
}

async function handleEmailSubmit(
  request: Request,
  share: Share,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  card: OgCard,
): Promise<Response> {
  const form = await request.formData();
  const raw = form.get('email');
  if (typeof raw !== 'string')
    return withCard(emailGateForm(share.slug, 'Email is required.'), card);
  const email = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    return withCard(emailGateForm(share.slug, 'Please enter a valid email address.'), card);
  }

  if (share.verify_email) {
    // A forged post would spend a victim's budget and put a code in their
    // inbox, so it is refused: first on origin, then on the signed field,
    // which is checked BEFORE anything is spent.
    if (!isOwnGatePost(request, url)) {
      return withCard(
        await verifiedEmailGate(request, share.slug, env, "That didn't come from this page."),
        card,
      );
    }
    const ok = await verifyGateToken(
      typeof form.get('t') === 'string' ? (form.get('t') as string) : null,
      'email',
      share.slug,
      readVerifyChallenge(request.headers.get('cookie')),
      '',
      env.SESSION_SECRET,
    );
    if (!ok) {
      return withCard(
        await verifiedEmailGate(request, share.slug, env, 'That form expired. Try again.'),
        card,
      );
    }
    return withCard(await sendCodeStep(request, share, email, env, ctx), card);
  }

  // Union semantics: if any list is set, the address must match one of them.
  if (!isEmailAllowed(share, email)) {
    return withCard(
      emailGateForm(share.slug, "This document isn't shared with your address."),
      card,
    );
  }
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
 * The database call happens for EVERY address, permitted or not, and the
 * answer is the same page for both: the gate must never tell somebody holding
 * the link who is on the allow-list. Whether a message follows is a fact in a
 * mailbox, not on this screen. The send runs after the reply.
 */
async function sendCodeStep(
  request: Request,
  share: Share,
  email: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const started = Date.now();
  const existing = readVerifyChallenge(request.headers.get('cookie'));
  const challenge = existing ?? newVerifyChallenge();
  const code = newVerificationCode();
  const codeHash = await hashVerificationCode(share.id, email, code, env.SESSION_SECRET);
  // The raw address never leaves this worker.
  const ipHash = await hashReporterAddress(
    request.headers.get('CF-Connecting-IP') ?? '',
    env.SESSION_SECRET,
  );
  const permitted = isEmailAllowed(share, email);
  const verdict = await issueVerificationCode(env, {
    shareId: share.id,
    email,
    codeHash,
    challenge,
    ipHash,
    permitted,
  });

  if (verdict === 'ok' && permitted) {
    ctx.waitUntil(
      (async () => {
        const ok = await Promise.race([
          sendVerificationCode(env, {
            to: email,
            code,
            documentTitle: share.document_title ?? 'a document',
            sender: share.owner_display_name ?? share.owner_email ?? 'Someone',
            host: request.headers.get('host') ?? env.SHARE_HOST ?? new URL(request.url).host,
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SEND_TIMEOUT_MS)),
        ]);
        if (!ok) {
          console.error(
            'verification code not sent',
            env.EMAIL ? 'provider_refused' : 'no_email_binding',
            share.id,
          );
        }
      })(),
    );
  }

  await padTo(started, gateFloorMs(env));

  // One page for every outcome, over the limit included.
  const res = verifyCodeForm(
    share.slug,
    email,
    await issueGateToken('code', share.slug, challenge, email, env.SESSION_SECRET),
  );
  // Whenever a code was stored, so the challenge's ten minutes restart with
  // the code bound to it; never on a refused request, which would strand the
  // working code the reader already holds.
  if (verdict === 'ok') res.headers.append('Set-Cookie', verifyChallengeCookie(challenge));
  return res;
}

/**
 * Step two: the code comes back. Every way of being wrong is one sentence.
 * On success two cookies: the verified one this link looks at, and the plain
 * email one, so turning the option off later does not sign readers out.
 */
async function handleVerifySubmit(
  request: Request,
  share: Share,
  url: URL,
  env: Env,
  card: OgCard,
): Promise<Response> {
  if (!isOwnGatePost(request, url)) {
    return withCard(
      await verifiedEmailGate(request, share.slug, env, "That didn't come from this page."),
      card,
    );
  }
  const form = await request.formData();
  const rawEmail = form.get('email');
  const rawCode = form.get('code');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!EMAIL_REGEX.test(email)) {
    return withCard(emailGateForm(share.slug, 'Please enter a valid email address.'), card);
  }

  const challenge = readVerifyChallenge(request.headers.get('cookie'));
  // Before an attempt is spent: a forged post never reaches the database.
  const tokenOk = await verifyGateToken(
    typeof form.get('t') === 'string' ? (form.get('t') as string) : null,
    'code',
    share.slug,
    challenge,
    email,
    env.SESSION_SECRET,
  );
  if (!tokenOk) {
    return withCard(
      await verifiedEmailGate(request, share.slug, env, 'That form expired. Try again.'),
      card,
    );
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
  await padTo(started, Math.min(VERIFY_FLOOR_MS, gateFloorMs(env)));

  if (verdict !== 'ok') {
    return withCard(
      verifyCodeForm(
        share.slug,
        email,
        await issueGateToken('code', share.slug, challenge!, email, env.SESSION_SECRET),
        'That code is not right. Check the email and try again.',
        401,
      ),
      card,
    );
  }

  const headers = new Headers({ Location: `/r/${share.slug}` });
  headers.append('Set-Cookie', await issueVerifiedCookie(share.slug, email, env.SESSION_SECRET));
  headers.append('Set-Cookie', await issueEmailCookie(share.slug, email, env.SESSION_SECRET));
  headers.append('Set-Cookie', VERIFY_CHALLENGE_CLEAR_COOKIE);
  return new Response(null, { status: 303, headers });
}

// Combined allow-list check: true when no list is set, or the address is on
// allowed_emails, or its domain is on allowed_email_domains.
function isEmailAllowed(share: Share, email: string): boolean {
  const emails = share.allowed_emails ?? [];
  const domains = share.allowed_email_domains ?? [];
  if (emails.length === 0 && domains.length === 0) return true;
  if (emails.map((e) => e.toLowerCase()).includes(email)) return true;
  const domain = email.split('@')[1] ?? '';
  return domains.map((d) => d.toLowerCase()).includes(domain);
}

// ---------------------------------------------------------------- attachments

// Same gate order as the document. Any failure is a 404, never a 403: we do
// not confirm a file exists behind a gate the reader has not passed.
async function handleAttachmentDownload(
  request: Request,
  slug: string,
  attachmentId: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const share = await getShareBySlug(env, slug);
  if (!share) return notFound();
  if (share.revoked_at) return notFound();
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return notFound();
  // A deleted document takes its attachments with it, even on a live link.
  const doc = await getDocument(env, share.document_id);
  if (!doc || doc.deleted_at) return notFound();

  if (share.require_password) {
    const cookie = await verifyAuthCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return notFound();
  }
  let recipientEmail: string | null = null;
  if (share.require_email) {
    const cookie = share.verify_email
      ? await verifyVerifiedCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET)
      : await verifyEmailCookie(request.headers.get('cookie'), slug, env.SESSION_SECRET);
    if (!cookie) return notFound();
    if (!isEmailAllowed(share, cookie.email)) return notFound();
    recipientEmail = cookie.email;
  }

  const attachment = await getAttachment(env, attachmentId);
  if (!attachment) return notFound();
  // Cross-document enumeration defence.
  if (attachment.document_id !== share.document_id) return notFound();

  const obj = await env.DOCS_BUCKET.get(attachment.r2_key);
  if (!obj) return notFound();

  const geo = geoFromRequest(request);
  ctx.waitUntil(
    (async () => {
      const viewerId = recipientEmail
        ? await getViewerIdByShareEmail(env, share.id, recipientEmail)
        : null;
      await logAttachmentDownload(env, {
        attachment_id: attachment.id,
        share_id: share.id,
        recipient_email: recipientEmail,
        country_code: geo?.country ?? null,
        device_type: geo?.deviceType ?? null,
        user_agent: request.headers.get('User-Agent'),
        viewer_id: viewerId,
        session_id: null,
        filename: attachment.filename,
        size_bytes: attachment.size_bytes,
      });
    })().catch((err: unknown) => console.error('download log failed', err)),
  );

  const safeName = attachment.filename.replace(/"/g, '');
  const headers = new Headers();
  headers.set('Content-Type', attachment.mime_type);
  headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
  headers.set('Content-Length', String(attachment.size_bytes));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  return new Response(obj.body, { status: 200, headers });
}
