/// <reference types="@cloudflare/workers-types" />

// Bindings the Worker provides (packages/app/wrangler.jsonc), read through
// getCloudflareContext() from @opennextjs/cloudflare.
interface CloudflareEnv {
  DB: D1Database;
  DOCS_BUCKET: R2Bucket;
}
