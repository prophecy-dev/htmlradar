# @htmlradar/app — the dashboard

Somnia-internal build: Next.js 16 on a Cloudflare Worker (via `@opennextjs/cloudflare`),
data in D1 (`DB`), files in R2 (`DOCS_BUCKET`), sign-in by Privy e-mail login. No
Supabase, no billing, no marketing pages. Bindings live in `wrangler.jsonc`; settings
are listed in `.env.example`.

## Sign-in

`/login` runs Privy with e-mail codes only. The page posts the Privy **identity token** to
`/api/auth/session`, which verifies it against the Privy app's JWKS (`PRIVY_APP_ID`), reads
the e-mail from its linked accounts and, if the domain is in `ALLOWED_EMAIL_DOMAINS`
(default `somnia.foundation`), sets a 12-hour `hr_session` cookie signed with
`SESSION_SECRET`. The middleware checks that cookie on every request (and the domain again).
Anyone signed in gets a profile, keyed by their lower-cased e-mail, on first visit.

In the Privy dashboard: e-mail login on, the dashboard origin in the allowed origins, and
"Return user data in an identity token" on.

`/api/v1/*` skips the sign-in: the public API (and `packages/mcp`) authenticates with
`Authorization: Bearer hr_live_…` keys created under Settings → API keys, and every route
there refuses a request without a valid key.

## Local development

```sh
pnpm install
cd packages/app
npx wrangler d1 migrations apply htmlradar --local   # D1 simulation under .wrangler/state
ACCESS_INSECURE_DEV=1 DEV_USER_EMAIL=you@somnia.foundation pnpm dev
```

`next dev` gets local D1 and R2 through `initOpenNextCloudflareForDev()` (see `next.config.mjs`).
That skips sign-in. To try the real Privy login locally, set `PRIVY_APP_ID` and
`SESSION_SECRET` instead (the dev fallback is ignored once `SESSION_SECRET` is set).
Without `SESSION_SECRET` and without `ACCESS_INSECURE_DEV=1` the app refuses everyone.

## Build, preview, deploy

`opennextjs-cloudflare` does not run on native Windows; use WSL, macOS/Linux or CI.

```sh
pnpm --filter @htmlradar/app build:cf   # next build + OpenNext bundle into .open-next/
pnpm --filter @htmlradar/app preview    # build:cf, then the Worker locally (reads .dev.vars)
pnpm --filter @htmlradar/app deploy     # build:cf, then deploy the htmlradar-app Worker
```
