// Route-level auth gate. Only paths starting with one of the protected
// prefixes below require a Supabase session — everything else falls
// through to Next's normal routing, including 404 / not-found. The
// middleware also refreshes the session cookie on every request via
// `getUser()` so tokens don't expire mid-browsing.
//
// We don't double-check auth inside (app)/layout.tsx — that was the
// previous pattern and added one redundant Supabase round-trip per
// render. The middleware is the single source of truth.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// Anything under one of these prefixes requires a session. Everything
// else (landing, /why, /pricing, /privacy, /sign-in, /typo404) is open
// and Next handles the route resolution (real page or not-found.tsx).
const PROTECTED_PREFIXES = ['/docs', '/dashboard', '/new', '/settings', '/upgrade'];

// Public despite falling under /docs: the API reference page, not a
// customer's document. Next's own router prefers this static route over
// (app)/docs/[id], but the auth gate runs first and would otherwise redirect
// every signed-out visitor — including search crawlers — to /sign-in.
const PUBLIC_EXCEPTIONS = new Set(['/docs/api']);

export async function middleware(req: NextRequest) {
  // www → apex, permanent. Both hosts are attached to the Pages project,
  // so Search Console indexed them as two competing sites and split
  // ranking signal. A `_redirects` host rule can't do this — Pages
  // ignores it when an advanced-mode _worker.js (next-on-pages) serves
  // the project — so the middleware owns the redirect.
  if (req.headers.get('host') === 'www.htmlradar.com') {
    const url = new URL(req.url);
    url.hostname = 'htmlradar.com';
    return NextResponse.redirect(url, 301);
  }

  const res = NextResponse.next();
  const pathname = req.nextUrl.pathname;

  // /auth/confirm is the last step of an e-mail sign-in and carries a
  // single-use token in its URL, so the page must never leak that URL through
  // a Referer header and must never be served from any cache.
  //
  // Set here because next.config's `headers()` is applied by Next's own
  // routing layer, which next-on-pages does not run in front of a Cloudflare
  // Pages function: the declaration passed in `next dev` and was absent in
  // production. Middleware is the one layer that does run there. It already
  // matches this path, and the branch below leaves the path public, so no
  // auth logic starts running on it. /auth/callback is a route handler and
  // stamps the same pair on its own responses (see auth/callback/route.ts).
  if (pathname === '/auth/confirm') {
    // strict-origin, NOT no-referrer. A browser derives the Origin header of
    // a form POST from the referrer policy, so under no-referrer Chrome sends
    // `Origin: null` and the login-CSRF check refused every real sign-in
    // (21 Sep 2026: "origin null, sec-fetch-site same-origin" in app_events).
    // strict-origin sends only `https://htmlradar.com` as the Referer — never
    // the path, never the token — and restores a real Origin on the POST.
    res.headers.set('Referrer-Policy', 'strict-origin');
    res.headers.set('Cache-Control', 'no-store');
  }

  const requiresAuth =
    !PUBLIC_EXCEPTIONS.has(pathname) &&
    PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Public path — skip the Supabase round-trip entirely. Saves ~100ms
  // on cold edge requests for the landing page.
  if (!requiresAuth) {
    return res;
  }

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        get: (name: string) => req.cookies.get(name)?.value,
        set: (name: string, value: string, options: CookieOptions) => {
          res.cookies.set({ name, value, ...options });
        },
        remove: (name: string, options: CookieOptions) => {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const signInUrl = new URL('/sign-in', req.url);
    // Preserve the original querystring on the `next` so post-sign-in
    // redirects land back on /upgrade?reason=quota (etc.) with the
    // contextual headline intact. Without `req.nextUrl.search` the
    // post-auth landing dropped to the generic Pro headline.
    signInUrl.searchParams.set('next', pathname + (req.nextUrl.search ?? ''));
    return NextResponse.redirect(signInUrl);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)'],
};
