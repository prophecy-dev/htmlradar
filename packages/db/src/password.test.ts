import { describe, expect, it } from 'vitest';
import { hashSharePassword, verifySharePassword } from './password.js';

describe('share passwords', () => {
  it('round-trips, in the pbkdf2$<iter>$<salt>$<hash> format', async () => {
    const stored = await hashSharePassword('correct horse');
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifySharePassword('correct horse', stored)).toBe(true);
    expect(await verifySharePassword('correct hors', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashSharePassword('same')).not.toBe(await hashSharePassword('same'));
  });

  it('refuses missing, malformed and over-expensive hashes', async () => {
    expect(await verifySharePassword('x', null)).toBe(false);
    expect(await verifySharePassword('x', 'bcrypt$whatever')).toBe(false);
    const stored = await hashSharePassword('x');
    const [, , salt, hash] = stored.split('$');
    expect(await verifySharePassword('x', `pbkdf2$10000000$${salt}$${hash}`)).toBe(false);
  });
});
