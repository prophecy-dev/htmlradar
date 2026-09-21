// Small helpers every query in this package leans on. D1 hands back plain
// rows: booleans are 0/1 and arrays are JSON text. Convert at this edge so
// callers keep the shapes the Postgres-era code expected.

export type DB = D1Database;

export const uuid = (): string => crypto.randomUUID();

export const nowIso = (): string => new Date().toISOString();

export const toBool = (v: unknown): boolean => v === 1 || v === true || v === '1';

export const fromBool = (v: boolean | null | undefined): 0 | 1 => (v ? 1 : 0);

export function toArray(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed: unknown = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export const fromArray = (v: readonly string[] | null | undefined): string | null =>
  v && v.length > 0 ? JSON.stringify(v) : null;

/** Lowercase hex of SHA-256. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random lowercase hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fixed-window counter in `rate_limits`. Returns true when the call is
 * allowed. Not atomic across isolates to the last request, which is fine for
 * an internal tool: D1 serialises writes, so the worst case is off-by-a-few.
 */
export async function hitRateLimit(
  db: DB,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = new Date(now - windowSeconds * 1000).toISOString();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_at, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_at < ?3 THEN 1 ELSE rate_limits.count + 1 END,
         window_at = CASE WHEN rate_limits.window_at < ?3 THEN ?2 ELSE rate_limits.window_at END
       RETURNING count`,
    )
    .bind(key, new Date(now).toISOString(), windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
