import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMAIL_REGEX,
  getFingerprint,
  isOptedOut,
  optOut,
  setStoredEmail,
  getStoredEmail,
} from '../src/identity.js';

describe('EMAIL_REGEX', () => {
  it('accepts conventional addresses', () => {
    expect(EMAIL_REGEX.test('alice@example.com')).toBe(true);
    expect(EMAIL_REGEX.test('alice+filter@example.co.uk')).toBe(true);
    expect(EMAIL_REGEX.test('a.b.c@x.y.z')).toBe(true);
  });

  it('rejects junk that audit F-27 used to accept', () => {
    expect(EMAIL_REGEX.test('a.@b')).toBe(false); // no TLD
    expect(EMAIL_REGEX.test('@.')).toBe(false);
    expect(EMAIL_REGEX.test('a@b.')).toBe(false);
    expect(EMAIL_REGEX.test('a b@example.com')).toBe(false); // whitespace
  });
});

describe('identity storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the same fingerprint across calls', () => {
    const fp1 = getFingerprint();
    const fp2 = getFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeGreaterThan(10);
  });

  it('persists email + reads it back', () => {
    setStoredEmail('marc@example.com');
    expect(getStoredEmail()).toBe('marc@example.com');
  });

  it('optOut clears fingerprint+email and sets flag', () => {
    setStoredEmail('marc@example.com');
    getFingerprint();
    optOut();
    expect(isOptedOut()).toBe(true);
    expect(getStoredEmail()).toBe(null);
  });
});

// The defect this file's storage cannot solve, pinned so nobody "simplifies"
// boot() back to calling getFingerprint() unconditionally.
//
// A document served through the proxy carries a `sandbox` CSP with no
// allow-same-origin, so it runs in an opaque origin where every localStorage
// call throws. getFingerprint() catches that and returns a fresh random value,
// which means every load is a new reader: a sender got a fresh "someone opened
// your document" email on every open, and unique-reader counts inflated. The
// answer is the proxy's readerId, not anything in this module — see
// packages/proxy/tests/reader-identity.test.ts.
describe('when the document is sandboxed and storage throws', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage');

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });

  afterEach(() => {
    if (real) Object.defineProperty(window, 'localStorage', real);
  });

  it('hands back a DIFFERENT fingerprint on every call', () => {
    expect(getFingerprint()).not.toBe(getFingerprint());
  });

  it('still answers the other questions without throwing', () => {
    expect(isOptedOut()).toBe(false);
    expect(getStoredEmail()).toBe(null);
    expect(() => setStoredEmail('marc@example.com')).not.toThrow();
    expect(() => optOut()).not.toThrow();
  });
});
