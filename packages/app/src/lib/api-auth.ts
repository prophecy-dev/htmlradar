// Bearer-key authentication and error shaping for the public API
// (src/app/api/v1/**). Edge-safe: Web Crypto only.
//
// A key is `hr_live_` followed by 40 lowercase hex characters (20 CSPRNG
// bytes). It is shown to the owner once; only its SHA-256 hash is stored, so
// a dump of api_keys cannot be replayed against the API.
//
// /api/v1/* is exempt from the dashboard sign-in (middleware.ts): the
// key is the only credential these routes accept.
//
// Nothing in this file logs the key, the hash, or any prefix of them.

import { findApiKeyByHash, hitRateLimit } from '@htmlradar/db/owner';
import { db } from './cf';

export const API_KEY_PREFIX = 'hr_live_';
const API_KEY_PATTERN = /^hr_live_[0-9a-f]{40}$/;

// Stored in the clear so the owner can tell keys apart: prefix + 6 hex chars.
const VISIBLE_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh key. Shown once, then only its hash survives. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(20)));
}

/** The part of a key that is safe to store and display. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, VISIBLE_PREFIX_LENGTH);
}

/**
 * The key out of an `Authorization: Bearer …` header, or null. A malformed
 * header costs a regex, not a database round trip.
 */
export function parseBearerKey(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/.exec(header.trim());
  const key = match?.[1];
  return key && API_KEY_PATTERN.test(key) ? key : null;
}

/** SHA-256, lowercase hex — the form stored in api_keys.key_hash. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return toHex(new Uint8Array(digest));
}

export type ApiKeyScope = 'full' | 'read_only';

export interface ApiCaller {
  userId: string;
  email: string;
  /** Anything other than exactly 'full' reads as 'read_only' (fails closed). */
  scope: ApiKeyScope;
}

// Every limit is per hour.
export const RATE_WINDOW_SECONDS = 3600;
const BAD_KEY_ATTEMPTS_PER_HOUR = 60;

/** Which budget a route spends. */
export interface ApiLimit {
  name: string;
  max: number;
  /** The route changes something; read-only keys are refused. */
  write?: boolean;
}

export const CREATION_MAX = 75;
export const CHEAP_MAX = 120;
/** The most rows one listing call returns. */
export const PAGE_SIZE = 50;

// Behind Cloudflare, cf-connecting-ip is set by the edge and cannot be forged.
function callerIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')?.trim() || 'unknown';
}

/** True when within the limit. Fails open: this is abuse control, not auth. */
async function withinLimit(key: string, max: number): Promise<boolean> {
  try {
    return await hitRateLimit(db(), key, max, RATE_WINDOW_SECONDS);
  } catch (e) {
    console.warn('[api] rate limiter failed open', key.split(':')[1], e);
    return true;
  }
}

export type ApiAuth = { caller: ApiCaller } | { error: Response };

/** Who is calling, or the response to send instead. */
export async function authenticateApiKey(req: Request, limit: ApiLimit): Promise<ApiAuth> {
  const key = parseBearerKey(req.headers.get('authorization'));
  const row = key ? await findApiKeyByHash(db(), await hashApiKey(key)) : null;
  if (!row) {
    const ok = await withinLimit(`api:bad-key:${callerIp(req)}`, BAD_KEY_ATTEMPTS_PER_HOUR);
    return { error: ok ? invalidKey() : rateLimited(RATE_WINDOW_SECONDS) };
  }
  if (!(await withinLimit(`api:${limit.name}:${row.user_id}`, limit.max))) {
    return { error: rateLimited(RATE_WINDOW_SECONDS) };
  }
  const scope: ApiKeyScope = row.scope === 'full' ? 'full' : 'read_only';
  if (limit.write && scope === 'read_only') return { error: readOnlyKey() };
  return { caller: { userId: row.user_id, email: row.email, scope } };
}

// ------------------------------------------------------------ responses

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function invalidKey(): Response {
  return json({ error: 'invalid_api_key', message: 'Missing or unknown API key.' }, 401);
}

export function rateLimited(retryAfterSeconds: number): Response {
  return json({ error: 'rate_limited', retry_after_seconds: retryAfterSeconds }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

export function readOnlyKey(): Response {
  return json(
    {
      error: 'read_only_key',
      message: 'This key is read-only and cannot create, revoke or replace anything.',
    },
    403,
  );
}

export function validationError(message: string): Response {
  return json({ error: 'validation', message }, 400);
}

export function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

export function tooLarge(maxBytes: number): Response {
  return json({ error: 'too_large', max_bytes: maxBytes }, 413);
}

export function serverError(): Response {
  return json({ error: 'internal', message: 'Something went wrong. Try again.' }, 500);
}

/** Parse a JSON object body, or the 400 to send instead. */
export async function readJsonObject(
  req: Request,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  try {
    const body: unknown = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return { body: body as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return { error: validationError('The request body must be a JSON object.') };
}

// ------------------------------------------------------------ paging

/** Where the last page stopped: a timestamp and the id that carried it. */
export interface PageCursor {
  created_at: string;
  id: string;
}

export const CURSOR_FORMAT = '<created_at>|<id>';

export function cursorOf(row: { created_at: string; id: string }): string {
  return `${row.created_at}|${row.id}`;
}

/**
 * The `before` cursor of a listing request, or the 400 to send. A cursor this
 * API did not hand out is refused rather than read as page one, so a paging
 * loop cannot become an endless one.
 */
export function readBefore(req: Request): { cursor: PageCursor | null } | { error: Response } {
  const raw = new URL(req.url).searchParams.get('before');
  if (!raw) return { cursor: null };
  const bar = raw.lastIndexOf('|');
  const createdAt = bar === -1 ? '' : raw.slice(0, bar);
  const id = bar === -1 ? '' : raw.slice(bar + 1);
  if (!id || Number.isNaN(new Date(createdAt).getTime())) {
    return {
      error: validationError(
        `"before" must be the next_before value from the previous page, of the form ${CURSOR_FORMAT}.`,
      ),
    };
  }
  return { cursor: { created_at: createdAt, id } };
}
