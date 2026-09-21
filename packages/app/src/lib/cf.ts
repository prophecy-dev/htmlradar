import 'server-only';
import { getRequestContext } from '@cloudflare/next-on-pages';

// The D1 database and R2 bucket bound to this Pages project. Only callable
// while a request is being handled (edge runtime).
export function bindings(): CloudflareEnv {
  return getRequestContext().env;
}

export const db = (): D1Database => bindings().DB;
export const bucket = (): R2Bucket => bindings().DOCS_BUCKET;

// Plain string settings. On Pages they arrive on the request context; in
// `next dev` and at build time they are in process.env.
export function envVar(name: string): string | undefined {
  try {
    const v = (getRequestContext().env as unknown as Record<string, unknown>)[name];
    if (typeof v === 'string' && v) return v;
  } catch {
    // outside a request (tests, build)
  }
  return process.env[name] || undefined;
}
