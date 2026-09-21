// OAuth + magic-link return path.
//
// Two ways in. OAuth (Google) returns with a `code` (PKCE), exchanged for a
// session cookie. E-mail links carry `token_hash` + `type=email` instead: the
// Supabase e-mail templates build the link as
// `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`. That is the only
// form that works when the link is requested by our server route
// (/api/auth/magic-link, since 4 Sep 2026) rather than by the browser: with no
// PKCE state in the browser, Supabase's default `{{ .ConfirmationURL }}` link
// fell back to the implicit flow and put the tokens in the URL fragment, which
// no server can read, so every e-mail sign-in from 4 to 16 Sep 2026 landed the
// person on the page signed OUT (three of three fell back to Google on 14 Sep).
// The hash form also works when the link is opened in a different browser
// from the one that asked for it, which a phone opening a desktop's e-mail is.
//
// What a GET with a `token_hash` must NOT do is spend it. Corporate mail
// security opens every link in a message before the human does: on 17 and 18
// September 2026 a Microsoft Defender Safe Links scanner spent all three of
// one user's sign-in links 13 to 16 seconds after each was sent, signed in
// inside its own sandbox, and left the human six "expired" clicks and no way
// in but Google. So the GET hands the token to /auth/confirm, which shows one
// button, and only the POST that button submits verifies it. Scanners issue
// GETs and follow redirects; they do not submit forms.
//
// `next` is the only externally-controlled redirect target on the site
// and must be validated — accepting `next=//evil.com` makes us a phishing
// gateway. Sanitisation lives in the shared `safeNext` (see lib/safe-next),
// which this route, /auth/confirm and /sign-in all use so they can't drift.

import { NextResponse, type NextRequest } from 'next/server';
import { serverClient } from '@/lib/supabase-server';
import { captureServerEvent } from '@/lib/events';
import { safeNext } from '@/lib/safe-next';

export const runtime = 'edge';

// Both auth paths carry a single-use sign-in token in the URL, so every
// response that mentions one has to say so.
//
// no-referrer: a subresource request, or the HTMLRadar link in the
// confirmation page's corner, could otherwise carry the token-bearing URL in
// a Referer header and drop an unspent token into somebody's request log.
//
// no-store: this URL must never come from a cache — not the browser's, not an
// intermediary's — because what it produces depends on whether the token has
// been spent yet.
//
// Stamped here, on the handler's own responses, rather than declared in
// next.config: `headers()` is applied by Next's own routing layer, and
// next-on-pages does not run that layer in front of a Cloudflare Pages
// function, so the declaration was silently absent in production while
// passing in `next dev`. The middleware does the same for /auth/confirm.
// Not exported: a route.ts may only export the HTTP verbs and Next's own
// route-segment fields, and the build refuses anything else.
const TOKEN_URL_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

function sealed(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(TOKEN_URL_HEADERS)) res.headers.set(key, value);
  return res;
}

// Only attach `next` when it's a real destination, to avoid noisy `?next=/docs`.
function withNext(dest: URL, next: string): URL {
  if (next !== '/docs') dest.searchParams.set('next', next);
  return dest;
}

// Redirect to /sign-in with an error, PRESERVING the intended destination
// so a transient failure doesn't strand the user away from where they were
// headed (e.g. /upgrade?reason=quota). /sign-in is also the recovery state:
// it already renders "That magic link expired. Send yourself a fresh one."
// above the one field and one button that request a new one.
async function signInError(
  req: NextRequest,
  next: string,
  reason: string,
  providerError?: string | null,
  // What /sign-in is told, when that differs from what we record. A refused
  // cross-origin POST is recorded as `cross_origin`, because that is the
  // cause, but the page is told `invalid`: whoever is looking at it is either
  // the victim of a forgery, for whom the sign-in simply did not work, or the
  // attacker, who learns nothing.
  errorParam: string = reason,
) {
  // Awaited — edge runtime cancels un-awaited fetches on return.
  // distinct_id falls back to the anon fingerprint so failed attempts
  // still stitch to the person if they eventually sign up.
  //
  // The key is `reason`, not `code`: the six failures of 17-18 September read
  // as causeless in every query that asked for `properties->>'reason'`, and a
  // failure path whose cause nobody can find is a failure path that teaches
  // nothing. Every exit from here names one.
  await captureServerEvent({
    event: 'auth.callback_failed',
    distinctId: req.cookies.get('hr:fp')?.value ?? 'anon',
    properties: { reason, provider_error: providerError ?? null },
  });
  const dest = withNext(new URL('/sign-in', req.url), next);
  dest.searchParams.set('error', errorParam);
  // 303, never the default 307: a 307 preserves the method, so a failed POST
  // would POST again to /sign-in and a refresh would offer to resubmit the
  // token. The recovery page must be reached with a GET.
  return sealed(NextResponse.redirect(dest, 303));
}

// The canonical origin, the same literal /api/auth/magic-link uses to build
// the e-mailed link in the first place.
const SITE_ORIGIN = 'https://htmlradar.com';

// Login CSRF. The POST spends a token and issues a session, and it needs no
// existing session to work, so SameSite cookies do not defend it: any site
// can auto-submit a form carrying an attacker's OWN unused token and land the
// victim inside the attacker's account, where everything the victim then
// uploads belongs to the attacker.
//
// A browser sets `Origin` on every cross-origin form POST and cannot be
// talked out of it, so requiring it to be ours is the whole defence. It is
// mandatory: a missing Origin is refused, because that is what a non-browser
// client looks like. `Sec-Fetch-Site` is a second opinion only when it is
// there — older Safari omits it, and refusing on absence would lock those
// people out. The request's own origin is accepted alongside the canonical
// one so localhost and preview deployments still work; on Pages only bound
// hostnames reach the worker, so it is not an attacker-controlled value.
function isSameOriginPost(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  if (origin !== SITE_ORIGIN && origin !== new URL(req.url).origin) return false;
  const fetchSite = req.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}

// Always fire signed_in. If the user row was created in the last 60s
// (handle_new_user trigger only runs on auth.users insert), this is
// also the user's first sign-in, so capture signed_up too. Read the
// anon fingerprint cookie (set client-side in events-client) so we can
// alias pre-signup browsing to the user post-hoc.
// Awaited (not void) — this route runs on the edge, where an un-awaited
// fetch is cancelled the moment the redirect returns. `void` here
// silently dropped every signed_in/signed_up/$identify event since
// launch (zero in app_events as of 2026-07-03). captureServerEvent
// never throws, so awaiting costs one round-trip and cannot block auth.
async function captureSignIn(
  req: NextRequest,
  user: {
    id: string;
    created_at: string;
    email?: string | null;
    app_metadata?: { provider?: string };
  },
) {
  const fingerprint = req.cookies.get('hr:fp')?.value ?? null;
  // First-touch source, written by events-client on the visitor's very first
  // page view and mirrored to a cookie so this server-side event can read it.
  // Without this, a signup records nothing about where the person came from —
  // which is why neither paying customer's source was ever in the dashboard.
  let firstTouch: Record<string, unknown> = {};
  try {
    const raw = req.cookies.get('hr:src')?.value;
    if (raw) firstTouch = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
  } catch {
    // A malformed cookie must never block sign-in.
  }
  const isNew = Date.now() - new Date(user.created_at).getTime() < 60_000;
  const provider = user.app_metadata?.['provider'] ?? null;
  const properties = { ...firstTouch, provider, fingerprint, email: user.email ?? null };
  const captures = [
    captureServerEvent({
      event: 'user.signed_in',
      distinctId: user.id,
      userId: user.id,
      properties,
    }),
  ];
  if (isNew) {
    captures.push(
      captureServerEvent({
        event: 'user.signed_up',
        distinctId: user.id,
        userId: user.id,
        properties,
      }),
    );
    // Alias event — same shape as PostHog's $identify. Lets a
    // dashboard query union events with distinct_id=user.id and
    // distinct_id=fingerprint as "same person".
    if (fingerprint) {
      captures.push(
        captureServerEvent({
          event: '$identify',
          distinctId: user.id,
          userId: user.id,
          properties: { alias_fingerprint: fingerprint },
        }),
      );
    }
  }
  await Promise.all(captures);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const next = safeNext(url.searchParams.get('next'));

  // The e-mail door. Hand the token on WITHOUT verifying it — see the header
  // comment. The link a scanner fetched is still good when the human clicks.
  // 303 so the browser and every scanner treat it as a plain GET onward.
  if (tokenHash) {
    const dest = withNext(new URL('/auth/confirm', req.url), next);
    dest.searchParams.set('token_hash', tokenHash);
    return sealed(NextResponse.redirect(dest, 303));
  }

  // No `code` → this wasn't a successful auth return. If the provider sent an
  // error (expired/denied magic link, OAuth error), surface it instead of
  // silently redirecting to `next` as though sign-in succeeded — otherwise the
  // user lands on a gated page, bounces back to sign-in, and never sees why.
  if (!code) {
    const providerError =
      url.searchParams.get('error_description') || url.searchParams.get('error');
    if (providerError) {
      return signInError(
        req,
        next,
        /expired|otp/i.test(providerError) ? 'expired' : 'callback',
        providerError,
      );
    }
    return sealed(NextResponse.redirect(new URL(next, req.url)));
  }

  const supabase = serverClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return signInError(req, next, 'callback', error.message);
  if (data.user) await captureSignIn(req, data.user);
  return sealed(NextResponse.redirect(new URL(next, req.url)));
}

// The e-mail door's second half: the form on /auth/confirm submits here, and
// only this handler spends the one-time token.
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === 'string' ? value : null;
  };
  const next = safeNext(field('next'));

  // Before anything is spent: this submission has to have come from our own
  // page. Checked ahead of the token so an attacker's form never reaches
  // verifyOtp at all.
  if (!isSameOriginPost(req)) {
    return signInError(
      req,
      next,
      'cross_origin',
      `origin ${req.headers.get('origin') ?? '(absent)'}, sec-fetch-site ${req.headers.get('sec-fetch-site') ?? '(absent)'}`,
      'invalid',
    );
  }

  const tokenHash = field('token_hash');
  if (!tokenHash) return signInError(req, next, 'callback', 'confirmation form carried no token');

  const supabase = serverClient();
  const { data, error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash });
  if (error) {
    // An e-mail link is single-use and expires in an hour; say so rather than
    // a generic failure, the same way an expired provider error is surfaced.
    return signInError(
      req,
      next,
      /expired|invalid|otp/i.test(error.message) ? 'expired' : 'callback',
      error.message,
    );
  }
  if (data.user) await captureSignIn(req, data.user);
  // 303, not the default 307: a 307 preserves the method and the browser
  // would POST to `next`.
  return sealed(NextResponse.redirect(new URL(next, req.url), 303));
}
