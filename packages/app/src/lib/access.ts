// Who is asking. Dashboard sign-in is Privy e-mail login, turned into our own
// short-lived session cookie. No database, so the middleware can use it as
// well as server components.
//
// Flow:
//   1. /login runs Privy (e-mail OTP only). Once signed in, the page posts the
//      Privy identity token to /api/auth/session.
//   2. verifyPrivyIdentityToken checks it against the app's JWKS and reads the
//      e-mail from its linked accounts. If that e-mail is allowed, the route sets
//      the SESSION_COOKIE, an HMAC over the e-mail and an expiry.
//   3. Every request after that only verifies the cookie (resolveAccessEmail).
//
// Fails closed: without SESSION_SECRET nobody gets a session. ACCESS_INSECURE_DEV=1
// trusts DEV_USER_EMAIL instead, and only in `next dev` (NODE_ENV=development,
// which a production build inlines as 'production'). The domain allow-list
// defaults to somnia.foundation, so a deploy that forgets ALLOWED_EMAIL_DOMAINS
// is not open to every Privy user. It is checked when the cookie is minted and
// again on every request.

import { createRemoteJWKSet, jwtVerify } from 'jose';

type Env = (name: string) => string | undefined;

export const SESSION_COOKIE = 'hr_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_ALLOWED_DOMAINS = 'somnia.foundation';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(appId: string) {
  let set = jwksCache.get(appId);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));
    jwksCache.set(appId, set);
  }
  return set;
}

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' };

export function allowedDomains(env: Env): string {
  return env('ALLOWED_EMAIL_DOMAINS') ?? DEFAULT_ALLOWED_DOMAINS;
}

// An empty list lets nobody in. Set ALLOWED_EMAIL_DOMAINS to widen it.
export function emailAllowed(email: string, domains: string): boolean {
  const list = domains
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return list.includes(domain);
}

// The e-mail from a Privy identity token's `linked_accounts` claim, which Privy
// signs as either an array or a JSON string of one. Only an e-mail account
// counts: that is the address the user proved with the one-time code.
export function emailFromLinkedAccounts(raw: unknown): string | null {
  let accounts: unknown = raw;
  if (typeof raw === 'string') {
    try {
      accounts = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(accounts)) return null;
  for (const a of accounts) {
    if (a && typeof a === 'object' && (a as { type?: unknown }).type === 'email') {
      const address = (a as { address?: unknown }).address;
      if (typeof address === 'string' && address.includes('@')) return address.trim().toLowerCase();
    }
  }
  return null;
}

export async function verifyPrivyIdentityToken(
  token: string,
  appId: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(appId), {
      issuer: 'privy.io',
      audience: appId,
    });
    return emailFromLinkedAccounts(payload['linked_accounts']);
  } catch {
    return null;
  }
}

// SESSION_SECRET also signs the proxy's recipient cookies, so the message uses
// the proxy's collision-proof form: a JSON array led by a purpose no proxy
// message uses (packages/proxy/src/auth.ts, "ONE SIGNING HELPER").
function sessionMessage(e: string, exp: number): string {
  return JSON.stringify(['dashboard-session', e, String(exp)]);
}

export async function signSession(
  email: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const e = base64url(new TextEncoder().encode(email));
  return `${e}.${exp}.${await hmac(sessionMessage(e, exp), secret)}`;
}

export async function verifySession(
  value: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const [e, expRaw, mac] = value.split('.');
  if (!e || !expRaw || !mac) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 <= now) return null;
  const expected = await hmac(sessionMessage(e, exp), secret);
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    return new TextDecoder().decode(fromBase64url(e));
  } catch {
    return null;
  }
}

export async function resolveAccessEmail(
  sessionCookie: string | undefined,
  env: Env,
): Promise<AccessResult> {
  let email: string | null = null;
  const secret = env('SESSION_SECRET');
  if (sessionCookie && secret) {
    email = await verifySession(sessionCookie, secret);
  } else if (
    !secret &&
    env('ACCESS_INSECURE_DEV') === '1' &&
    process.env.NODE_ENV === 'development'
  ) {
    email = env('DEV_USER_EMAIL') ?? null;
  }
  if (!email) return { ok: false, reason: 'unauthenticated' };
  email = email.trim().toLowerCase();
  if (!emailAllowed(email, allowedDomains(env))) return { ok: false, reason: 'forbidden' };
  return { ok: true, email };
}

async function hmac(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
