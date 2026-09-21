// The last step of an e-mail sign-in: one button, and nothing happens until
// it is pressed.
//
// Why a button at all. On 17 and 18 September 2026 a corporate mailbox
// (drscholls.com, Microsoft-hosted) produced six auth.callback_failed events.
// The cause is in app_events: each of the three sign-in links this person
// asked for produced a SUCCESSFUL user.signed_in 13 to 16 seconds after the
// request, carrying no `hr:fp` cookie and from a browser that had never
// visited — a Defender Safe Links scanner opening the e-mail's links on
// delivery. Every one of the human's own clicks then failed as "expired",
// because a one-time token had already been spent by a machine. He only got
// in through Google.
//
// The remedy is the shape of the request, not a cleverer check: a scanner
// issues GETs and follows redirects, and does not fill in and submit a form.
// So this page renders on GET and verifies nothing; /auth/callback's POST
// handler is the only place the token is spent.
//
// No client JavaScript: a plain form, so the page works before (and without)
// hydration. The expired case is not handled here — the POST redirects to
// /sign-in?error=expired, which already carries the recovery copy and the one
// field and button that send a fresh link.

import { redirect } from 'next/navigation';
import { HeroRadar } from '@/components/HeroRadar';
import { safeNext } from '@/lib/safe-next';

export const runtime = 'edge';

export const metadata = {
  title: 'Confirm sign-in',
  // A single-use token sits in this URL. Keep it out of every index.
  robots: { index: false, follow: false },
};

export default function ConfirmSignInPage({
  searchParams,
}: {
  searchParams?: { token_hash?: string; next?: string };
}) {
  const tokenHash = searchParams?.token_hash ?? '';
  const next = safeNext(searchParams?.next);

  // Nothing to confirm — somebody reached the page without a link. /sign-in is
  // where a link gets asked for, so send them there rather than show a button
  // that cannot work.
  if (!tokenHash) {
    redirect(next === '/docs' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-16">
      <div aria-hidden className="hero-bloom pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-80px] top-[-60px] opacity-50 md:right-[-40px] md:top-[-20px]"
      >
        <HeroRadar size={280} />
      </div>

      <div className="relative w-full max-w-md">
        <a href="/" className="mb-10 block font-mono text-[13px] tracking-wide text-ink">
          HTML<span className="text-signal">Radar</span>
        </a>

        <h1 className="text-letterpress font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[48px]">
          One more tap.
        </h1>
        <p className="mt-3 text-[15px] text-ink-soft">
          Your link is good. Press the button to finish signing in.
        </p>

        <form method="post" action="/auth/callback" className="mt-8">
          <input type="hidden" name="token_hash" value={tokenHash} />
          {next !== '/docs' ? <input type="hidden" name="next" value={next} /> : null}
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-signal px-4 py-3 text-[14.5px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
          >
            Continue to HTMLRadar
          </button>
        </form>

        <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
          Your link is used only when you press the button, so your mail provider&rsquo;s security
          check can&rsquo;t use it up first.
        </p>
      </div>
    </main>
  );
}
