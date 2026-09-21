import { afterEach, describe, expect, it, vi } from 'vitest';

// Where a recipient's link points. Read once at module load, because Next.js
// inlines NEXT_PUBLIC_* at build time — so each case re-imports the module.

const ORIGINAL = {
  origin: process.env.NEXT_PUBLIC_SHARE_ORIGIN,
  base: process.env.NEXT_PUBLIC_SHARE_BASE,
};

function set(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function load(origin?: string, base?: string) {
  vi.resetModules();
  set('NEXT_PUBLIC_SHARE_ORIGIN', origin);
  set('NEXT_PUBLIC_SHARE_BASE', base);
  return import('./share-url');
}

afterEach(() => {
  set('NEXT_PUBLIC_SHARE_ORIGIN', ORIGINAL.origin);
  set('NEXT_PUBLIC_SHARE_BASE', ORIGINAL.base);
});

describe('share links', () => {
  it('falls back to the local proxy when nothing is configured', async () => {
    const { shareUrl } = await load();
    expect(shareUrl('acme')).toBe('http://localhost:8787/r/acme');
  });

  it('uses NEXT_PUBLIC_SHARE_ORIGIN', async () => {
    const { shareUrl, SHARE_HOST, shareUrlLabel } = await load('https://docs.hive.land');
    expect(shareUrl('acme-proposal')).toBe('https://docs.hive.land/r/acme-proposal');
    expect(SHARE_HOST).toBe('docs.hive.land');
    expect(shareUrlLabel('acme-proposal')).toBe('docs.hive.land/r/acme-proposal');
  });

  it('prefers the origin over the legacy base', async () => {
    const { shareUrl } = await load('https://a.example', 'https://b.example');
    expect(shareUrl('x')).toBe('https://a.example/r/x');
  });

  it('accepts the legacy NEXT_PUBLIC_SHARE_BASE', async () => {
    const { shareUrl } = await load(undefined, 'https://b.example');
    expect(shareUrl('x')).toBe('https://b.example/r/x');
  });

  // Copying the base out of a browser address bar is how you end up with one.
  it('tolerates a trailing slash', async () => {
    const { shareUrl } = await load('https://docs.example.org/');
    expect(shareUrl('x-y-z')).toBe('https://docs.example.org/r/x-y-z');
  });
});
