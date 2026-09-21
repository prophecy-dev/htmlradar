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

export async function POST(req: NextRequest) {
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
  const email = await verifyPrivyIdentityToken(token, appId);
  if (!email) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  if (!emailAllowed(email, allowedDomains(envVar))) {
    return NextResponse.json({ error: 'email_not_allowed', email }, { status: 403 });
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
