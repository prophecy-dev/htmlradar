// Single source of truth for sanitizing the externally-controlled post-auth
// redirect target (`?next=`). `next` is the only attacker-influenced redirect
// destination on the site: accepting `next=//evil.com` or `next=/\evil.com`
// (which browsers treat as protocol-relative) would turn the auth flow into an
// open-redirect / phishing gateway. Anything that isn't a clean in-app path
// collapses to /docs.
//
// Used by BOTH /sign-in (already-authed short-circuit) and /auth/callback
// (post-exchange redirect). They previously each had their own copy and
// drifted — the sign-in page accepted `/\evil.com` that the callback rejected.
//
// Control characters have to go first, and it cannot be a prefix check.
// `/%09/evil.example` — a tab between the slashes — looks like an in-app path
// to every test below, and then the URL parser STRIPS the tab and resolves
// what is left as `https://evil.example/`. Any C0 control, DEL, or backslash
// anywhere in the value can do this, so none of them may appear at all.
// The control characters below are the point: this pattern exists to reject
// them, and no-control-regex only asks whether they were meant. They were.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001F\u007F\\]/;

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/docs';
  if (UNSAFE.test(raw)) return '/docs';
  if (!raw.startsWith('/')) return '/docs';
  if (raw.startsWith('//')) return '/docs';
  return raw;
}
