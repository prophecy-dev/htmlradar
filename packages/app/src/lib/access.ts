// Who is asking — resolved from Cloudflare Access. No database, so the
// proxy can use it as well as server components.
//
// Order of trust:
//   1. ACCESS_TEAM_DOMAIN + ACCESS_AUD set → the Cf-Access-Jwt-Assertion header
//      must verify against the team's certs; its e-mail claim is the user.
//   2. Not configured, and ACCESS_INSECURE_DEV=1 → the
//      cf-access-authenticated-user-email header, else DEV_USER_EMAIL. For
//      `next dev` only: anyone can send that header.
//   3. Otherwise nobody gets in. A deploy that forgets (1) is locked, not open.
// Then ALLOWED_EMAIL_DOMAINS (comma-separated), when set, must match.

import { createRemoteJWKSet, jwtVerify } from 'jose';

type Env = (name: string) => string | undefined;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let set = jwksCache.get(host);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`));
    jwksCache.set(host, set);
  }
  return set;
}

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' };

export function emailAllowed(email: string, allowedDomains: string | undefined): boolean {
  const list = (allowedDomains ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (list.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return list.includes(domain);
}

export async function resolveAccessEmail(headers: Headers, env: Env): Promise<AccessResult> {
  let email: string | null = null;
  const team = env('ACCESS_TEAM_DOMAIN');
  const aud = env('ACCESS_AUD');
  if (team && aud) {
    const token = headers.get('cf-access-jwt-assertion');
    if (!token) return { ok: false, reason: 'unauthenticated' };
    try {
      const host = team.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const { payload } = await jwtVerify(token, jwks(team), {
        audience: aud,
        issuer: `https://${host}`,
      });
      email = typeof payload['email'] === 'string' ? payload['email'] : null;
    } catch {
      return { ok: false, reason: 'unauthenticated' };
    }
  } else if (env('ACCESS_INSECURE_DEV') === '1') {
    email = headers.get('cf-access-authenticated-user-email') || env('DEV_USER_EMAIL') || null;
  }
  if (!email) return { ok: false, reason: 'unauthenticated' };
  email = email.trim().toLowerCase();
  if (!emailAllowed(email, env('ALLOWED_EMAIL_DOMAINS'))) return { ok: false, reason: 'forbidden' };
  return { ok: true, email };
}
