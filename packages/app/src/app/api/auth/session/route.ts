// Turns a Privy identity token into the dashboard session cookie, and clears
// it again. See lib/access.ts for the whole flow.

import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  allowedDomains,
  emailAllowed,
  signSession,
  verifyPrivyIdentityToken,
} from '@/lib/access';
import { envVar } from '@/lib/cf';

// A cross-site form can post a JSON-looking text/plain body (login CSRF), so
// only same-origin JSON requests may start a session.
function sameOriginJson(req: NextRequest): boolean {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return false;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  return !origin || origin === req.nextUrl.origin;
}

export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const appId = envVar('PRIVY_APP_ID');
  const secret = envVar('SESSION_SECRET');
  if (!appId || !secret) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  let token: unknown;
  try {
    token = ((await req.json()) as { identityToken?: unknown }).identityToken;
  } catch {
    token = null;
  }
  if (typeof token !== 'string' || !token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  }
  const emails = await verifyPrivyIdentityToken(token, appId);
  if (!emails) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  const email = emails.find((e) => emailAllowed(e, allowedDomains(envVar)));
  if (!email) {
    return NextResponse.json(
      { error: 'email_not_allowed', email: emails[0] ?? null },
      { status: 403 },
    );
  }
  const res = NextResponse.json({ ok: true, email });
  res.cookies.set(SESSION_COOKIE, await signSession(email, secret), {
    httpOnly: true,
    secure: req.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
