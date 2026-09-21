// Whether this installation may OFFER the verified e-mail gate.
//
// THE PROBLEM THIS SOLVES. The gate is the only thing in the product that
// needs the Worker to send an e-mail, and the Worker can only do that if the
// deploy gave it a Resend credential of its own (see the RESEND_API_KEY note in
// packages/proxy/src/env.ts). Without one, every link with verification
// switched on fails closed for every reader: no code is ever sent, nobody can
// type one, and nothing opens. An owner must not be able to walk into that.
//
// SO THE APP ASKS THE DEPLOY, NOT THE WORKER. The flag is written into the
// build by the same step that refuses to build without the secret
// (.github/workflows/deploy.yml, "Preflight"), so the answer here and the
// Worker's ability to send come from one value read once in one run. They
// cannot disagree.
//
// WHY NOT ASK THE WORKER AT RENDER TIME. That was the other option, and it
// costs a network round trip on every render of the share form to learn
// something that changes about once a year — and it needs a new
// capability endpoint on the recipient host, which is a surface that today
// answers nothing but documents and one domain-check probe. A build flag is
// smaller, and it is the shape this repository already uses for exactly this
// kind of question (NEXT_PUBLIC_TRUST_HANDLES, read from the Worker's own
// wrangler.toml in the same preflight step).
//
// WHAT IT CANNOT DO, said plainly: a build flag goes stale. If the key is
// revoked the day after a deploy, this still says yes. That gap is covered by
// the daily live journey, which asks the provider to accept a real code for a
// sink address and fails within a day (packages/app/scripts/live-journey.mjs).
// The two together are the honest mechanism: the flag stops an owner switching
// on a gate that was never going to work, and the journey catches the key that
// stopped working afterwards.
//
// OFF IS THE SAFE DIRECTION AND THE DEFAULT. Absent, empty or anything but '1'
// and 'true' hides the option and refuses to store it. A link that already has
// verification on keeps it — the Worker's behaviour is not gated by this, only
// the offer is — because switching a customer's security setting off because
// our own build flag is unset would be the wrong way round.

/**
 * Read inside the function rather than at module load, for the reason
 * customDomainsEnabled gives: next-on-pages resolves env at request time on the
 * edge runtime and not always at module load.
 *
 * NEXT_PUBLIC_, because the share form is a client component and has to know
 * whether to render the toggle at all. There is nothing secret in the answer —
 * it is "does this installation send e-mail", which anybody who receives one
 * already knows.
 *
 * WRITTEN OUT IN FULL, ON PURPOSE. Next.js puts a NEXT_PUBLIC_ value into the
 * browser bundle by substituting the literal text `process.env.NEXT_PUBLIC_…`
 * before the code ever runs. A computed read — `process.env[name]` behind a
 * helper — is not that text, so nothing is substituted, the client bundle asks
 * an object that is not there, and the answer is false on every deploy however
 * the flag was set. Astra reproduced exactly that with the installed compiler.
 * So this one variable is named literally here and nowhere else, and there is
 * no indirection to tempt the next edit.
 */
export function verifiedGateEnabled(): boolean {
  const raw = (process.env.NEXT_PUBLIC_VERIFY_EMAIL_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
