import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  SESSION_TTL_SECONDS,
  emailAllowed,
  emailsFromLinkedAccounts,
  resolveAccessEmail,
  signSession,
  verifyPrivyIdentityToken,
  verifySession,
} from './access';

const env =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name];

const SECRET = 'test-secret-0123456789';

describe('emailAllowed', () => {
  it('lets nobody in when the list is empty', () => {
    expect(emailAllowed('a@somnia.foundation', '')).toBe(false);
    expect(emailAllowed('a@somnia.foundation', ' , ')).toBe(false);
  });

  it('matches the domain exactly, case-insensitively, with or without @', () => {
    expect(emailAllowed('Ann@Somnia.Foundation', 'somnia.foundation, @hive.land')).toBe(true);
    expect(emailAllowed('bo@hive.land', 'somnia.foundation, @hive.land')).toBe(true);
    expect(emailAllowed('eve@evil-somnia.foundation', 'somnia.foundation')).toBe(false);
    expect(emailAllowed('eve@somnia.foundation.evil.io', 'somnia.foundation')).toBe(false);
    expect(emailAllowed('eve@sub.somnia.foundation', 'somnia.foundation')).toBe(false);
  });
});

describe('emailsFromLinkedAccounts', () => {
  it('reads e-mail and Google accounts from an array or a JSON string', () => {
    const accounts = [
      { type: 'wallet', address: '0xabc' },
      { type: 'email', address: 'Ann@Somnia.Foundation' },
      { type: 'google_oauth', email: 'ann.g@somnia.foundation', subject: '123' },
    ];
    const want = ['ann@somnia.foundation', 'ann.g@somnia.foundation'];
    expect(emailsFromLinkedAccounts(accounts)).toEqual(want);
    expect(emailsFromLinkedAccounts(JSON.stringify(accounts))).toEqual(want);
  });

  it('ignores other account types that carry an e-mail', () => {
    expect(
      emailsFromLinkedAccounts([
        { type: 'discord_oauth', email: 'ann@somnia.foundation' },
        { type: 'github_oauth', email: 'ann@somnia.foundation' },
        { type: 'google_oauth', address: 'ann@somnia.foundation' },
      ]),
    ).toEqual([]);
    expect(emailsFromLinkedAccounts('not json')).toEqual([]);
    expect(emailsFromLinkedAccounts(undefined)).toEqual([]);
  });
});

describe('session cookie', () => {
  it('round-trips and expires', async () => {
    const now = Date.UTC(2026, 8, 21);
    const value = await signSession('ann@somnia.foundation', SECRET, now);
    expect(await verifySession(value, SECRET, now)).toBe('ann@somnia.foundation');
    expect(await verifySession(value, SECRET, now + SESSION_TTL_SECONDS * 1000)).toBe(null);
    expect(await verifySession(value, 'another-secret', now)).toBe(null);
  });

  it('rejects a cookie whose e-mail was swapped', async () => {
    const value = await signSession('ann@somnia.foundation', SECRET);
    const [, exp, mac] = value.split('.');
    const forged = `${btoa('eve@somnia.foundation').replace(/=+$/, '')}.${exp}.${mac}`;
    expect(await verifySession(forged, SECRET)).toBe(null);
    expect(await verifySession('garbage', SECRET)).toBe(null);
  });
});

describe('resolveAccessEmail', () => {
  it('accepts a valid session for the default domain only', async () => {
    const ok = await signSession('ann@somnia.foundation', SECRET);
    expect(await resolveAccessEmail(ok, env({ SESSION_SECRET: SECRET }))).toEqual({
      ok: true,
      email: 'ann@somnia.foundation',
    });
    const other = await signSession('bo@gmail.com', SECRET);
    expect(await resolveAccessEmail(other, env({ SESSION_SECRET: SECRET }))).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses everyone without SESSION_SECRET, unless ACCESS_INSECURE_DEV=1 in next dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      await resolveAccessEmail(undefined, env({ DEV_USER_EMAIL: 'dev@somnia.foundation' })),
    ).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(
      await resolveAccessEmail(
        undefined,
        env({ ACCESS_INSECURE_DEV: '1', DEV_USER_EMAIL: 'dev@somnia.foundation' }),
      ),
    ).toEqual({ ok: true, email: 'dev@somnia.foundation' });
  });

  it('ignores the dev fallback outside next dev', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      await resolveAccessEmail(
        undefined,
        env({ ACCESS_INSECURE_DEV: '1', DEV_USER_EMAIL: 'dev@somnia.foundation' }),
      ),
    ).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('ignores the dev fallback once SESSION_SECRET is set', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(
      await resolveAccessEmail(
        undefined,
        env({
          SESSION_SECRET: SECRET,
          ACCESS_INSECURE_DEV: '1',
          DEV_USER_EMAIL: 'dev@somnia.foundation',
        }),
      ),
    ).toEqual({ ok: false, reason: 'unauthenticated' });
  });
});

describe('verifyPrivyIdentityToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(appId: string) {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [jwk] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const sign = (claims: Record<string, unknown>, aud = appId, iss = 'privy.io') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject('did:privy:1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    return sign;
  }

  it('returns the verified e-mail', async () => {
    const sign = await setup('app-ok');
    const token = await sign({
      linked_accounts: JSON.stringify([{ type: 'email', address: 'ann@somnia.foundation' }]),
    });
    expect(await verifyPrivyIdentityToken(token, 'app-ok')).toEqual(['ann@somnia.foundation']);
  });

  it('rejects another app, another issuer, or a bad signature', async () => {
    const sign = await setup('app-strict');
    const claims = { linked_accounts: [{ type: 'email', address: 'ann@somnia.foundation' }] };
    expect(await verifyPrivyIdentityToken(await sign(claims, 'other-app'), 'app-strict')).toBe(
      null,
    );
    expect(
      await verifyPrivyIdentityToken(await sign(claims, 'app-strict', 'evil.io'), 'app-strict'),
    ).toBe(null);
    const token = await sign(claims);
    expect(await verifyPrivyIdentityToken(token.slice(0, -4) + 'AAAA', 'app-strict')).toBe(null);
  });
});
