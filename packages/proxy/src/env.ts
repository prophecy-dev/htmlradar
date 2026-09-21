// Worker environment. Secrets are set via `wrangler secret put`;
// non-secret vars come from wrangler.toml. R2 bucket is a binding, not a
// fetched resource — Cloudflare wires it at request time.

export interface Env {
  // Secrets
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SESSION_SECRET: string;
  // The verified e-mail gate's code e-mail, and the one new credential this
  // worker needs.
  //
  // WHY THE WORKER SENDS IT ITSELF. Every other e-mail in the product is sent
  // from Postgres: a trigger or an RPC calls `net.http_post`, pg_net queues the
  // row and a background worker delivers it. That path was the obvious one here
  // — the worker already reaches two such RPCs with the service-role key it
  // holds — and it cannot be used, for one reason. pg_net is asynchronous by
  // construction: it returns a request id, not an outcome, so the caller cannot
  // learn whether the provider accepted the message. Decision 10 of the brief
  // requires the gate to FAIL CLOSED with an honest sentence when a send is
  // refused, and a path that cannot report a refusal cannot fail closed on one.
  // It would also put a queue poll between the reader and their code, where a
  // direct call puts one HTTPS request.
  //
  // Absent, the gate refuses to mint a code and says so. It never opens the
  // document.
  RESEND_API_KEY?: string;
  // The From address, in the form the provider wants ("HTMLRadar
  // <hello@htmlradar.com>"). The same value as the `resend_from` Vault secret
  // the database path uses; kept as a worker secret rather than read out of the
  // database so one failed lookup cannot silently change who the mail is from.
  RESEND_FROM?: string;
  // The provider's endpoint. A var, not a secret, and overridable for ONE
  // reason: a local production-style run points it at a stub so the golden
  // journey can read the code without a real inbox (packages/app/e2e/journeys).
  // Unset means the real provider.
  RESEND_API_URL?: string;
  // The gate's timing floor, in milliseconds (see GATE_FLOOR_MS in index.ts).
  // A var with a safe default, overridable for the same single reason
  // RESEND_API_URL is: the unit suite and a local run would otherwise spend a
  // second and a fifth waiting on every gate post for a property that has no
  // meaning off the public internet. Production never sets it.
  GATE_FLOOR_MS?: string;

  // Vars
  // Upstream the tracker bundle is fetched from. Recipient documents load it
  // from their own host (see TRACKER_PATH in index.ts); this is where the
  // worker gets it.
  TRACKER_URL: string;
  // Host that serves recipient documents. Recipient HTML gets a registrable
  // domain of its own so it never shares an origin — or a reputation — with
  // the application. Defaults to htmlradar.page; self-hosters set their own
  // in wrangler.toml.
  SHARE_HOST?: string;
  // Comma-separated hosts that used to serve /r/ and now only redirect there.
  // Defaults to htmlradar.com. Empty for a self-hoster who never moved.
  LEGACY_HOSTS?: string;
  // The trust layer's one gate setting
  // (docs/workstreams/content-domain/TRUST-LAYER-DESIGN-2026-08-31.md).
  // Three states:
  //   ""   off. /r/{slug} serves the document exactly as it does today, and
  //        the wrapper's frame and print routes are not-found.
  //   list a comma-separated list of slugs, for QA shares only.
  //   "*"  every share.
  // Rolling back is this setting and one deploy; no database change either
  // way, and no already-sent link changes its address in any state.
  TRUST_WRAPPER?: string;
  // The trust layer's OTHER gate: handle links (Gate 2 in the design's
  // "Migration order, gates, and rollback").
  //
  // ONE SETTING REACHES BOTH HALVES, which is Sol's ninth finding. This line
  // in wrangler.toml is what wrangler hands the Worker, and the deploy
  // workflow's preflight reads the same line into NEXT_PUBLIC_TRUST_HANDLES
  // for the application build. The Worker half gates the apex-to-handle
  // redirect; the application half gates allocating a handle and stamping it
  // on new shares. They cannot disagree, so newly generated handle links and
  // the redirects that serve them switch off together.
  //
  // Two states: "" or unset is off, "*" is on. Off, a share that already
  // stores a hostname is served in place on the apex instead of redirected —
  // it still opens, and its handle-host address still works, because the
  // stored-hostname rules that serve it are NOT gated. Only the redirect is.
  TRUST_HANDLES?: string;
  // Git commit bound at deploy time (`wrangler deploy --var GIT_SHA:...` from
  // .github/workflows/deploy.yml); absent under `wrangler dev` and in tests.
  GIT_SHA?: string;

  // Bindings
  DOCS_BUCKET: R2Bucket;
}
