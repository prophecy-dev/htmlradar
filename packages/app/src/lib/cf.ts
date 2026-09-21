import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// The D1 database and R2 bucket bound to this Worker (wrangler.jsonc). Only
// callable while a request is being handled; `next dev` gets local
// simulations through initOpenNextCloudflareForDev() in next.config.mjs.
export function bindings(): CloudflareEnv {
  return getCloudflareContext().env;
}

export const db = (): D1Database => bindings().DB;
export const bucket = (): R2Bucket => bindings().DOCS_BUCKET;

// Plain string settings. On the Worker they arrive on the request context; at
// build time and in tests they are in process.env.
export function envVar(name: string): string | undefined {
  try {
    const v = (getCloudflareContext().env as unknown as Record<string, unknown>)[name];
    if (typeof v === 'string' && v) return v;
  } catch {
    // outside a request (tests, build)
  }
  return process.env[name] || undefined;
}
