# HTMLRadar — Somnia internal fork

A fork of [htmlradar/htmlradar](https://github.com/htmlradar/htmlradar) (AGPL-3.0), used to
track the HTML decks we send (Hivemarket sales decks, community-ops outreach, agency RFPs).
The changes from upstream:

- **Cloudflare only.** D1 replaces Supabase (`packages/db`: one schema, and TS in place of
  the Postgres RPCs/triggers). R2 holds the documents. **Cloudflare Email Service**
  (`send_email` binding) replaces Resend. Telegram carries optional first-read alerts.
- **Cloudflare Access is the login.** No accounts, billing, marketing site, custom domains,
  handles, MCP connector or monitor worker.
- **Recipient-side additions:** Open Graph unfurl cards (a per-document description and
  image), unfurl bots served a card-only page (no session, no alert), a `/privacy` page and a
  "tracked" pill, and section tracking that works on decks scrolling inside a container.

## Pieces

| Package            | Runs as                       | Notes                                           |
| ------------------ | ----------------------------- | ----------------------------------------------- |
| `packages/proxy`   | Worker `htmlradar-proxy`      | `/r/{slug}`, gates, tracker, `/t/*`, alerts     |
| `packages/app`     | Pages project `htmlradar-app` | dashboard + `/api/v1` (API keys)                |
| `packages/db`      | library + `migrations/`       | D1 `htmlradar`                                  |
| `packages/tracker` | bundled into the proxy        |                                                 |
| `packages/mcp`     | npm `htmlradar-mcp`           | set `HTMLRADAR_API_URL` to the dashboard origin |

## Deploy (test: Somnia account)

Credentials are in the gitignored repo-root `.env` (`SOM_CLOUDFLARE_API_TOKEN`,
`SOM_CLOUDFLARE_ACCOUNT_ID`, `HTMLRADAR_SESSION_SECRET`).

```bash
# from the repo root; wrangler reads CLOUDFLARE_*, so map the Somnia pair onto it
set -a; . ./.env; set +a
export CLOUDFLARE_API_TOKEN=$SOM_CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$SOM_CLOUDFLARE_ACCOUNT_ID

# schema
(cd packages/proxy && npx wrangler d1 migrations apply htmlradar --remote)

# recipient worker
(cd packages/proxy && npx wrangler deploy --var SHARE_HOST:<host> --var APP_ORIGIN:<dashboard origin> --var MAIL_FROM:<addr>)
(cd packages/proxy && printf %s "$HTMLRADAR_SESSION_SECRET" | npx wrangler secret put SESSION_SECRET)

# dashboard: next-on-pages does not build on native Windows; build in WSL/Linux/CI
(cd packages/app && NEXT_PUBLIC_SHARE_ORIGIN=<share origin> pnpm build:edge && npx wrangler pages deploy --branch main)
# the SAME secret on the Pages project, or "Preview as you" fails; redeploy after setting it
(cd packages/app && printf %s "$HTMLRADAR_SESSION_SECRET" | npx wrangler pages secret put SESSION_SECRET --project-name htmlradar-app)
```

The dashboard **refuses everyone** until `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are set on the
Pages project and an Access application covers its hostname. The Access app needs a
**Bypass** policy on `/api/v1/*`, because API keys authenticate themselves.
