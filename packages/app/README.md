# @htmlradar/app — the dashboard

Somnia-internal build: Next.js 16 on a Cloudflare Worker (via `@opennextjs/cloudflare`),
data in D1 (`DB`), files in R2 (`DOCS_BUCKET`), sign-in by Cloudflare Access. No
Supabase, no billing, no marketing pages. Bindings live in `wrangler.jsonc`; settings
are listed in `.env.example`.

## Cloudflare Access

Put the whole Worker hostname behind an Access application, and set
`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` so the app verifies every request's
`Cf-Access-Jwt-Assertion` itself. `ALLOWED_EMAIL_DOMAINS` narrows it further. Anyone who
gets past Access gets a profile, keyed by their lower-cased e-mail, on first visit.

**`/api/v1/*` needs a Bypass policy.** The public API (and `packages/mcp`) authenticates
with `Authorization: Bearer hr_live_…` keys created under Settings → API keys; Access
would otherwise answer those requests with its login page. Add a second Access
application for the path `/api/v1/` on the same hostname with a single **Bypass /
Everyone** policy. The proxy (`src/proxy.ts`) skips that path, and every route there refuses a
request without a valid key.

## Local development

```sh
pnpm install
cd packages/app
npx wrangler d1 migrations apply htmlradar --local   # D1 simulation under .wrangler/state
ACCESS_INSECURE_DEV=1 DEV_USER_EMAIL=you@somnia.network SESSION_SECRET=dev-secret pnpm dev
```

`next dev` gets local D1 and R2 through `initOpenNextCloudflareForDev()` (see `next.config.mjs`).
Without Access configured (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`) the app refuses everyone, unless `ACCESS_INSECURE_DEV=1` — local development only; it trusts a header anyone can send.

## Build, preview, deploy

`opennextjs-cloudflare` does not run on native Windows; use WSL, macOS/Linux or CI.

```sh
pnpm --filter @htmlradar/app build:cf   # next build + OpenNext bundle into .open-next/
pnpm --filter @htmlradar/app preview    # build:cf, then the Worker locally (reads .dev.vars)
pnpm --filter @htmlradar/app deploy     # build:cf, then deploy the htmlradar-app Worker
```
