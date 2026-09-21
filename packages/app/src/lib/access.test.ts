import { describe, expect, it } from 'vitest';
import { emailAllowed, resolveAccessEmail } from './access';

const env =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name];

describe('emailAllowed', () => {
  it('lets anyone in when no domains are configured', () => {
    expect(emailAllowed('a@anything.io', undefined)).toBe(true);
    expect(emailAllowed('a@anything.io', ' ')).toBe(true);
  });

  it('matches the domain exactly, case-insensitively, with or without @', () => {
    expect(emailAllowed('Ann@Somnia.Network', 'somnia.network, @hive.land')).toBe(true);
    expect(emailAllowed('bo@hive.land', 'somnia.network, @hive.land')).toBe(true);
    expect(emailAllowed('eve@evil-somnia.network', 'somnia.network')).toBe(false);
    expect(emailAllowed('eve@somnia.network.evil.io', 'somnia.network')).toBe(false);
  });
});

describe('resolveAccessEmail without JWT verification configured', () => {
  it('trusts the Access e-mail header and lowercases it', async () => {
    const headers = new Headers({ 'cf-access-authenticated-user-email': 'Ann@Somnia.Network' });
    expect(await resolveAccessEmail(headers, env({}))).toEqual({
      ok: true,
      email: 'ann@somnia.network',
    });
  });

  it('falls back to DEV_USER_EMAIL, and refuses when there is nothing', async () => {
    expect(await resolveAccessEmail(new Headers(), env({ DEV_USER_EMAIL: 'dev@x.io' }))).toEqual({
      ok: true,
      email: 'dev@x.io',
    });
    expect(await resolveAccessEmail(new Headers(), env({}))).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('refuses an address outside ALLOWED_EMAIL_DOMAINS', async () => {
    const headers = new Headers({ 'cf-access-authenticated-user-email': 'x@gmail.com' });
    expect(
      await resolveAccessEmail(headers, env({ ALLOWED_EMAIL_DOMAINS: 'somnia.network' })),
    ).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('resolveAccessEmail with JWT verification configured', () => {
  const configured = env({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' });

  it('ignores the plain e-mail header and DEV_USER_EMAIL: only a verified token counts', async () => {
    const headers = new Headers({ 'cf-access-authenticated-user-email': 'ann@somnia.network' });
    expect(await resolveAccessEmail(headers, configured)).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('refuses a token that does not verify', async () => {
    const headers = new Headers({ 'cf-access-jwt-assertion': 'not.a.jwt' });
    expect(await resolveAccessEmail(headers, configured)).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });
});
