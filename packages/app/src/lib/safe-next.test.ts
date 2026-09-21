import { describe, it, expect } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('passes clean in-app paths (incl. query strings) through unchanged', () => {
    expect(safeNext('/docs')).toBe('/docs');
    expect(safeNext('/docs/123?tab=analytics')).toBe('/docs/123?tab=analytics');
    expect(safeNext('/upgrade?reason=quota')).toBe('/upgrade?reason=quota');
    expect(safeNext('/settings')).toBe('/settings');
  });

  it('defaults missing/empty values to /docs', () => {
    expect(safeNext(null)).toBe('/docs');
    expect(safeNext(undefined)).toBe('/docs');
    expect(safeNext('')).toBe('/docs');
  });

  it('rejects protocol-relative and backslash open-redirects', () => {
    expect(safeNext('//evil.com')).toBe('/docs');
    // The exact shape the sign-in short-circuit used to ACCEPT (regression guard):
    expect(safeNext('/\\evil.com')).toBe('/docs');
    expect(safeNext('/\\/\\evil.com')).toBe('/docs');
    // A backslash anywhere, not just at the front.
    expect(safeNext('/docs\\@evil.com')).toBe('/docs');
  });

  // These reached production. Every one of them starts with a single slash,
  // so every prefix check passed them, and then the URL parser threw the
  // control character away and resolved the rest as an absolute URL.
  it('rejects a control character smuggled between the slashes', () => {
    expect(safeNext('/\t/evil.example')).toBe('/docs');
    expect(safeNext('/\n/evil.example')).toBe('/docs');
    expect(safeNext('/\r/evil.example')).toBe('/docs');
    expect(safeNext('/\u0000/evil.example')).toBe('/docs');
    expect(safeNext('/\u007F/evil.example')).toBe('/docs');
    // Trailing and mid-path control characters are no better.
    expect(safeNext('/docs\r\nX-Injected: 1')).toBe('/docs');
  });

  it('proves the rejected shapes really did escape the site', () => {
    // What the redirect would have resolved to, had safeNext let it through.
    expect(new URL('/\t/evil.example', 'https://htmlradar.com').origin).toBe(
      'https://evil.example',
    );
    // And what it resolves to now.
    expect(new URL(safeNext('/\t/evil.example'), 'https://htmlradar.com').origin).toBe(
      'https://htmlradar.com',
    );
  });

  it('rejects absolute URLs and non-path values', () => {
    expect(safeNext('https://evil.com')).toBe('/docs');
    expect(safeNext('http://evil.com')).toBe('/docs');
    expect(safeNext('evil.com')).toBe('/docs');
    expect(safeNext('javascript:alert(1)')).toBe('/docs');
  });
});
