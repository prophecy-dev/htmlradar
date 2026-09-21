// Every page is internal. The middleware checks the dashboard session cookie
// (lib/access.ts): no session goes to /login, a session for an address outside
// ALLOWED_EMAIL_DOMAINS gets a 403. /login and /api/auth/* are how you get a
// session; /api/v1/* authenticates API keys itself.
//
// Still `middleware.ts`, not Next 16's `proxy.ts`: a proxy always runs on the
// Node.js runtime, which @opennextjs/cloudflare supports only experimentally.

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, resolveAccessEmail } from '@/lib/access';

const env = (name: string) => process.env[name] || undefined;

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (
    pathname.startsWith('/api/v1/') ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/login' ||
    pathname === '/forbidden'
  ) {
    return NextResponse.next();
  }
  const result = await resolveAccessEmail(req.cookies.get(SESSION_COOKIE)?.value, env);
  if (result.ok) return NextResponse.next();
  if (result.reason === 'forbidden') {
    return NextResponse.redirect(new URL('/forbidden', req.url));
  }
  if (req.method !== 'GET' || pathname.startsWith('/api/')) {
    return new NextResponse('Sign in to use HTMLRadar.', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const login = new URL('/login', req.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Skip static assets and the Next internals.
  matcher: ['/((?!_next/|v1/|pdfjs/|favicon|icon|apple-icon|.*\\.(?:png|svg|ico|js|css|mjs)$).*)'],
};
