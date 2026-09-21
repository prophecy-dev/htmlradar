// Where a recipient's link lives.
//
// Recipient documents are served by the proxy worker on their own host (e.g.
// https://docs.hive.land), never on the dashboard's origin, so a document's
// HTML never shares an origin with a signed-in session.
//
// NEXT_PUBLIC_SHARE_ORIGIN is read at build time by Next.js, so it is baked
// into both the server and the browser bundle. The trailing slash is trimmed
// so a base pasted from an address bar does not produce //r/.
export const SHARE_BASE = (
  process.env.NEXT_PUBLIC_SHARE_ORIGIN ??
  process.env.NEXT_PUBLIC_SHARE_BASE ??
  'http://localhost:8787'
).replace(/\/+$/, '');

// The same thing without the scheme, for places that print a link.
export const SHARE_HOST = SHARE_BASE.replace(/^https?:\/\//, '');

/** The public address of a share. */
export const shareUrl = (slug: string): string => `${SHARE_BASE}/r/${slug}`;

/** The same address without the scheme. */
export const shareUrlLabel = (slug: string): string => shareUrl(slug).replace(/^https?:\/\//, '');
