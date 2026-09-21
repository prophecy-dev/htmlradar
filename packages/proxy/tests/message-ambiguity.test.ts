import { describe, expect, it } from 'vitest';
import {
  hashVerificationCode,
  issueAuthCookie,
  issueEmailCookie,
  issueGateToken,
  issuePrintGrant,
  issueVerifiedCookie,
  newPrintSecret,
  verifyAuthCookie,
  verifyEmailCookie,
  verifyGateToken,
  verifyOwnerPreviewToken,
  verifyPrintGrant,
  verifyVerifiedCookie,
} from '../src/auth.js';

// Signed-message ambiguity: the forgery Astra found, its mirrors, and the
// character rules the formats that were NOT changed depend on.
//
// The bug: every message used to be fields joined by a delimiter, and a field
// was allowed to contain the delimiter. Two different purposes could therefore
// produce the same bytes, and a signature minted for one was a valid signature
// for the other. See the audit in the header of src/auth.ts for the pair-by-
// pair analysis this file pins.

const SECRET = 'test-session-secret';

/** Pull the four fields out of the cookie the issuer produced. */
function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=').slice(1).join('=');
}

const b64url = (s: string): string => Buffer.from(s).toString('base64url');

describe('the critical forgery, exactly as it was reported', () => {
  it('an ordinary e-mail cookie can no longer be repackaged as a verified one', async () => {
    // An ordinary, unrestricted link whose custom ending is the legal slug
    // `verified`, entered with an address that carries the target slug across
    // the old delimiter.
    const ordinary = await issueEmailCookie('verified', 'acme-proposal:buyer@acme.test', SECRET);
    const [, , expiry, mac] = cookieValue(ordinary).split('.');

    // Repackaged under the verified cookie's name and shape for the target.
    const forged = `__Host-hr_v_acme-proposal=acme-proposal.${b64url('buyer@acme.test')}.${expiry}.${mac}`;

    expect(await verifyVerifiedCookie(forged, 'acme-proposal', SECRET)).toBeNull();
  });

  it('and the ordinary cookie it was made from still works for its own link', async () => {
    // The fix must not have broken the format it was forged from.
    const ordinary = await issueEmailCookie('verified', 'acme-proposal:buyer@acme.test', SECRET);
    const held = `htmlradar_email_verified=${cookieValue(ordinary)}`;
    expect(await verifyEmailCookie(held, 'verified', SECRET)).not.toBeNull();
  });

  it('a genuine verified cookie is still accepted, and only for its own link', async () => {
    const real = await issueVerifiedCookie('acme-proposal', 'buyer@acme.test', SECRET);
    const held = `__Host-hr_v_acme-proposal=${cookieValue(real)}`;
    expect(await verifyVerifiedCookie(held, 'acme-proposal', SECRET)).not.toBeNull();
    // The same bytes under another link's name prove nothing.
    const moved = `__Host-hr_v_other-deck=${cookieValue(real)}`;
    expect(await verifyVerifiedCookie(moved, 'other-deck', SECRET)).toBeNull();
  });
});

describe('the mirrored pairs', () => {
  it('a password cookie cannot be read as an e-mail cookie', async () => {
    const pwd = await issueAuthCookie('acme-proposal', SECRET);
    const [slug, expiry, mac] = cookieValue(pwd).split('.');
    const forged = `htmlradar_email_${slug}=${slug}.${b64url('x@y.z')}.${expiry}.${mac}`;
    expect(await verifyEmailCookie(forged, slug!, SECRET)).toBeNull();
  });

  it('an e-mail cookie cannot be read as a password cookie', async () => {
    // The address carries a colon, which is the only reason this pair is worth
    // testing at all: the expiry segment would have to be `{email}:{expiry}`,
    // and that cannot round-trip through parseInt.
    const mail = await issueEmailCookie('acme-proposal', 'a:b@c.test', SECRET);
    const [slug, , expiry, mac] = cookieValue(mail).split('.');
    const forged = `htmlradar_auth_${slug}=${slug}.${expiry}.${mac}`;
    expect(await verifyAuthCookie(forged, slug!, SECRET)).toBeNull();
  });

  it('a print grant cannot be read as an e-mail cookie, or the reverse', async () => {
    const cookieSecret = newPrintSecret();
    const grant = await issuePrintGrant('acme-proposal', 'htmlradar.page', cookieSecret, SECRET);
    const [expiry, mac] = grant.split('.');
    const forged = `htmlradar_email_acme-proposal=acme-proposal.${b64url('x@y.z')}.${expiry}.${mac}`;
    expect(await verifyEmailCookie(forged, 'acme-proposal', SECRET)).toBeNull();

    // And an address shaped like the print message's pipe-joined fields.
    const mail = await issueEmailCookie(
      'print',
      `acme-proposal|htmlradar.page|${cookieSecret}@x.test`,
      SECRET,
    );
    const [, , mailExpiry, mailMac] = cookieValue(mail).split('.');
    expect(
      await verifyPrintGrant(
        `${mailExpiry}.${mailMac}`,
        'acme-proposal',
        'htmlradar.page',
        `__Host-hr_print=${cookieSecret}`,
        SECRET,
      ),
    ).toBe(false);
  });

  it('an owner-preview token cannot be forged from an e-mail cookie', async () => {
    // Only reachable if an address could equal a slug, and an address must
    // contain '@' while a slug may not.
    const mail = await issueEmailCookie('owner-preview', 'acme-proposal@x.test', SECRET);
    const [, , expiry, mac] = cookieValue(mail).split('.');
    expect(
      await verifyOwnerPreviewToken(`acme-proposal.${expiry}.${mac}`, 'acme-proposal', SECRET),
    ).toBe(false);
  });

  it('a verification code hash is not an e-mail cookie signature', async () => {
    // The old code-hash format was one length coincidence away from this pair
    // colliding, which is why it was migrated even though it was not
    // exploitable. Pinned so it cannot drift back.
    const hash = await hashVerificationCode('share-1', 'buyer@acme.test', '123456', SECRET);
    const mail = await issueEmailCookie('verify', 'share-1|buyer@acme.test', SECRET);
    const [, , , mailMac] = cookieValue(mail).split('.');
    expect(hash).not.toBe(mailMac);
  });
});

describe('the character rules the unchanged formats depend on', () => {
  // The audit in src/auth.ts leans on these. If any of them is ever widened,
  // the analysis has to be redone, and this is what will say so.
  it('a slug is lowercase letters, digits and hyphens only', () => {
    const SLUG = /^[a-z0-9-]+$/;
    for (const good of ['acme-proposal', 'verified', 'print', 'owner-preview']) {
      expect(SLUG.test(good)).toBe(true);
    }
    for (const bad of ['has:colon', 'has|pipe', 'has@at', 'HasUpper', 'has.dot']) {
      expect(SLUG.test(bad)).toBe(false);
    }
  });

  it('an address always contains an at sign, which no pipe-family field may', () => {
    // This single fact is what keeps the whole pipe family safe from the
    // colon family. It is the email regex from index.ts.
    const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    expect(EMAIL.test('buyer@acme.test')).toBe(true);
    // It deliberately DOES allow these, which is why the fix was needed.
    expect(EMAIL.test('a:b@c.test')).toBe(true);
    expect(EMAIL.test('a|b@c.test')).toBe(true);
    // And it cannot match anything without an at sign.
    expect(EMAIL.test('acme-proposal')).toBe(false);
    expect(EMAIL.test('htmlradar.page')).toBe(false);
  });

  it('a print or reader secret is thirty-two lowercase hex characters', () => {
    expect(/^[0-9a-f]{32}$/.test(newPrintSecret())).toBe(true);
  });
});

describe('the gate form token', () => {
  it('is accepted only with the challenge it was signed over', async () => {
    const challenge = newPrintSecret();
    const token = await issueGateToken('email', 'acme-proposal', challenge, '', SECRET);
    expect(await verifyGateToken(token, 'email', 'acme-proposal', challenge, '', SECRET)).toBe(
      true,
    );
    expect(
      await verifyGateToken(token, 'email', 'acme-proposal', newPrintSecret(), '', SECRET),
    ).toBe(false);
    expect(await verifyGateToken(token, 'email', 'acme-proposal', null, '', SECRET)).toBe(false);
  });

  it('cannot be moved between links, steps or addresses', async () => {
    const challenge = newPrintSecret();
    const code = await issueGateToken('code', 'acme-proposal', challenge, 'a@x.test', SECRET);
    // Another link.
    expect(await verifyGateToken(code, 'code', 'other-deck', challenge, 'a@x.test', SECRET)).toBe(
      false,
    );
    // The other step.
    expect(
      await verifyGateToken(code, 'email', 'acme-proposal', challenge, 'a@x.test', SECRET),
    ).toBe(false);
    // Another address — this is what stops a token obtained for the
    // attacker's own address being spent against somebody else's code.
    expect(
      await verifyGateToken(code, 'code', 'acme-proposal', challenge, 'b@x.test', SECRET),
    ).toBe(false);
  });
});
