// Bindings the Pages project provides (packages/app/wrangler.jsonc), read
// through getRequestContext() from @cloudflare/next-on-pages.
interface CloudflareEnv {
  DB: D1Database;
  DOCS_BUCKET: R2Bucket;
}
