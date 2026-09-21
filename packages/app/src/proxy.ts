// Every page is internal and sits behind Cloudflare Access. The proxy
// checks the Access identity (lib/access.ts) and answers 403 for anyone who
// is not allowed. /api/v1/* is exempt: it authenticates API keys itself, and
// the Access application must have a Bypass policy for that path.

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAccessEmail } from '@/lib/access';

const env = (name: string) => process.env[name] || undefined;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/v1/') || pathname === '/forbidden') {
    return NextResponse.next();
  }
  const result = await resolveAccessEmail(req.headers, env);
  if (!result.ok) {
    return new NextResponse(
      result.reason === 'forbidden'
        ? 'This HTMLRadar instance is for Somnia staff only.'
        : 'Sign in through Cloudflare Access to use HTMLRadar.',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
  return NextResponse.next();
}

export const config = {
  // Skip static assets and the Next internals.
  matcher: ['/((?!_next/|v1/|pdfjs/|favicon|icon|apple-icon|.*\\.(?:png|svg|ico|js|css|mjs)$).*)'],
};
