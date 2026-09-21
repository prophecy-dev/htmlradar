// /privacy — the public policy for the hosted service, rendered in the
// HTMLRadar voice + palette. Linked from every page footer and reachable
// without sign-in.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { V2Footer } from '@/components/V2Footer';
import { Reveal } from '@/components/Reveal';
import { SectionMark } from '@/components/SectionMark';
import { pageMeta } from '@/lib/seo';

export const dynamic = 'force-static';

export const metadata = pageMeta({
  title: 'Privacy Policy | HTMLRadar',
  description:
    'How HTMLRadar handles the data it collects. The policy that applies to the hosted version at htmlradar.com.',
  path: '/privacy',
});

export default function PrivacyPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <Reveal reveal={false}>
            <SectionMark>HTMLRadar · Hosted service</SectionMark>
          </Reveal>

          <Reveal reveal={false} delay={0.05}>
            <h1 className="text-letterpress mt-8 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
              Privacy.
            </h1>
          </Reveal>

          <Reveal reveal={false} delay={0.1}>
            <p className="mt-6 text-[15px] text-graphite">
              How HTMLRadar handles the data it collects. This policy applies to the hosted version
              at htmlradar.com. If you self-host, you own the data and write your own policy.
            </p>
          </Reveal>

          <div className="mt-14 space-y-10 text-[16px] leading-[1.7] text-ink-soft">
            <Section title="What we collect">
              <p>When a recipient opens a tracked share, we record:</p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  The <strong className="text-ink">email address</strong> they enter at the gate, if
                  the share requires one.
                </li>
                <li>
                  If the sender turns on <strong className="text-ink">email verification</strong>,
                  we send that address a six-digit code. We store only a keyed hash of the code,
                  never the code itself. The code works for ten minutes, and we delete the record an
                  hour after it was sent — the job that clears them runs every five minutes, so in
                  the worst case a record is there for about sixty-five minutes. We keep it that
                  long, and no longer, only so that nobody can use the gate to send somebody a
                  hundred codes. Once an address has been verified we record that, and the sender
                  sees a verified mark beside it in their report. The code is sent through our mail
                  provider, Resend.
                </li>
                <li>
                  A <strong className="text-ink">random fingerprint</strong> — a value we generate
                  so that the same person opening the same document twice counts as one reader
                  rather than two. On a document we serve, it lives in a cookie named{' '}
                  <code className="font-mono text-[14px] text-signal-dark">__Host-hr_rid</code>. The
                  browser sends that cookie only to the exact host that served the document, and
                  marks it so that scripts on the page cannot read it. It expires after 90 days.
                  Each document gets a different identifier derived from it, so the value one
                  document is given does not match the value another document is given. The page the
                  sender wrote is given that document's value and can read it.
                </li>
                <li>
                  If you <strong className="text-ink">self-host</strong> and embed the tracker
                  directly in your own page, there is no cookie. The tracker keeps a random value in
                  that site's{' '}
                  <code className="font-mono text-[14px] text-signal-dark">localStorage</code>,
                  which is shared by every page on that site rather than being one value per
                  document.
                </li>
                <li>
                  <strong className="text-ink">Session metrics</strong>: start time, total active
                  time, max scroll depth, sections read with dwell.
                </li>
                <li>
                  <strong className="text-ink">Coarse network metadata</strong>: IP-derived country
                  and city (we never store the IP itself), device / OS / browser from the
                  user-agent, referrer URL.
                </li>
              </ul>
              <p className="mt-4">
                We don't collect keystrokes, mouse positions, third-party trackers, anything from
                outside the document, or anything that identifies the recipient beyond the email
                they provided.
              </p>
              <p className="mt-4">
                Recipient documents are served from a separate domain, htmlradar.page, which shares
                no cookies or browser storage with htmlradar.com, and old htmlradar.com links
                redirect there automatically.
              </p>
            </Section>

            <Section title="What we collect when you use the app yourself">
              <p>
                Separately from the share-tracking above, the hosted app records a small amount of
                first-party usage data so we can fix bugs and understand which features get used:
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>
                  <strong className="text-ink">Product events</strong> — when you sign in, upload a
                  document, create or revoke a share, hit the free-tier cap, view the upgrade page,
                  click a CTA, or submit feedback. Stored in a table called{' '}
                  <code className="font-mono text-[14px] text-signal-dark">app_events</code>. The
                  monitor worker replays these first-party events to PostHog server-side for product
                  analytics. Your account email is added to your PostHog user profile after sign-in.
                  Owner-scoped share events can include a first open, gate outcome, country, device,
                  or email domain, but not a recipient's raw email address. The browser does not
                  load a PostHog script.
                </li>
                <li>
                  <strong className="text-ink">Page views</strong> — when your browser loads a page
                  on htmlradar.com. We store the path, referrer, and a random fingerprint
                  (anonymous, generated client-side, never linked to your email unless you're signed
                  in).
                </li>
                <li>
                  <strong className="text-ink">Crash + error reports</strong> — when JavaScript on a
                  page throws an error, we capture the message + stack to a{' '}
                  <code className="font-mono text-[14px] text-signal-dark">error_log</code> table so
                  we can fix it. We do not use Sentry or any third-party error service.
                </li>
                <li>
                  <strong className="text-ink">Feedback</strong> — anything you submit through{' '}
                  <Link
                    href="/feedback"
                    className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
                  >
                    /feedback
                  </Link>{' '}
                  is stored in a{' '}
                  <code className="font-mono text-[14px] text-signal-dark">feedback</code> table and
                  emailed directly to the founder. Email field is optional.
                </li>
              </ul>
              <p className="mt-4">
                No third-party tracking scripts. No third-party cookies for analytics or
                advertising. No session replay.
              </p>
            </Section>

            <Section title="Where data lives">
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  Document HTML you upload — Cloudflare R2, encrypted at rest in the region of your
                  bucket.
                </li>
                <li>Primary application data — Supabase Postgres, encrypted at rest.</li>
                <li>
                  Product analytics events — PostHog, sent server-side from the monitor worker.
                </li>
              </ul>
            </Section>

            <Section title="Who can see your data">
              <p>
                Only the document owner can see analytics about their shares. Postgres Row Level
                Security enforces this at the database layer — an authenticated user querying
                directly cannot see another user's data.
              </p>
              <p className="mt-3">
                Operators of the hosted service have technical access to the underlying database for
                support and abuse investigation. Access is logged and limited.
              </p>
            </Section>

            <Section title="Data retention">
              <p>
                Sessions and section events are currently retained indefinitely. Permanently
                deleting an individual share removes its viewers, sessions, section events, and
                attachment-download records from Supabase immediately. The in-app Delete document
                action archives the document: it removes document and share access, but retains the
                database rows and uploaded HTML for recovery.
              </p>
            </Section>

            <Section title="Right to delete">
              <p>
                Recipients and account holders can request permanent deletion by emailing{' '}
                <a
                  href="mailto:privacy@htmlradar.com"
                  className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
                >
                  privacy@htmlradar.com
                </a>
                . Include the email address tied to the data and, for account holders, the affected
                document. We complete verified requests within 14 days, including matching data in
                Supabase, R2, and PostHog where applicable.
              </p>
            </Section>

            <Section title="Opt out">
              <p>
                A recipient can opt out of tracking by calling{' '}
                <code className="font-mono text-[14px] text-signal-dark">
                  window.HTMLRadar.optOut()
                </code>{' '}
                in the browser console of any tracked page, and confirming on the page that opens.
                On a document we serve, confirming records the choice in a cookie on the host that
                served the document, deletes the fingerprint cookie, and applies to every HTMLRadar
                link opened on that host afterwards. While it is in place we set no fingerprint and
                put no tracker on the page. On a directly embedded tracker the choice is stored in
                that site's localStorage; the script still downloads with the page, then stops
                before recording anything.
              </p>
              <p className="mt-3">
                The same page also carries a link to report it, which works the same way whether it
                opens on htmlradar.page or on a customer&rsquo;s own connected domain.
              </p>
            </Section>

            <Section title="Cookies">
              <p>
                The hosted service uses session cookies for authentication, set when you sign in. A
                tracked link sets cookies on the host that serves the document: the fingerprint
                described above (
                <code className="font-mono text-[14px] text-signal-dark">__Host-hr_rid</code>
                ), one holding the recipient&rsquo;s opt-out choice (
                <code className="font-mono text-[14px] text-signal-dark">__Host-hr_optout</code>),
                one that ties an opt-out confirmation to the browser that asked for it (
                <code className="font-mono text-[14px] text-signal-dark">__Host-hr_optout_c</code>,
                ten minutes), one that permits printing (
                <code className="font-mono text-[14px] text-signal-dark">__Host-hr_print</code>),
                and one that stands in for a password or an email once the recipient has passed that
                gate. The <code className="font-mono text-[14px] text-signal-dark">__Host-</code>{' '}
                names are ones a browser will only accept from the exact host that serves the
                document, so no other site can write them. The browser sends each of them only to
                the host that set it, and marks them so that scripts on the page cannot read them.
                We do not use third-party cookies for analytics or advertising.
              </p>
              <p className="mt-3">
                On your first visit to htmlradar.com, we also set a cookie named{' '}
                <code className="font-mono text-[14px] text-signal-dark">hr:src</code>, mirrored in
                your browser's local storage, recording the page you arrived on and any campaign
                tags in the link (such as{' '}
                <code className="font-mono text-[14px] text-signal-dark">utm_source</code> or{' '}
                <code className="font-mono text-[14px] text-signal-dark">gclid</code>). This tells
                us which of our pages and channels bring people who sign up. It lives only on our
                own domain, in a first-party cookie and local storage with no third-party trackers,
                and lasts one year. You can clear it any time by clearing site data for
                htmlradar.com in your browser.
              </p>
            </Section>

            <Section title="Open source">
              <p>
                HTMLRadar is AGPL-3.0 open source. You can audit exactly what the tracker collects
                and how it's transmitted at{' '}
                <a
                  href="https://github.com/htmlradar/htmlradar"
                  className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
                >
                  github.com/htmlradar/htmlradar
                </a>
                .
              </p>
            </Section>

            <Section title="If we e-mailed you first" id="outreach">
              <p>
                Sometimes we write to a business we have not spoken to before, because its published
                work suggests it sends proposals, decks or reports as web pages. When we do, this is
                what happens with the address. We take it from the firm's own website or a public
                professional profile, and the e-mail says which page. We store the address, the name
                if one was published, the firm, the page it came from and the dates we wrote, in a
                private spreadsheet that only the founder can read, for at most twelve months. We
                use it for at most two e-mails and for nothing else. We do not sell it, share it or
                add it to any list. Reply with the word stop, or any words that mean the same, and
                we delete the row the same day and never write again. The lawful basis in the UK is
                legitimate interest in telling a relevant business about a product for that
                business; the assessment behind that is available on request. Write to{' '}
                <a
                  href="mailto:hello@htmlradar.com"
                  className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
                >
                  hello@htmlradar.com
                </a>{' '}
                for a copy, to ask what we hold about you, or to have it deleted.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                <a
                  href="mailto:privacy@htmlradar.com"
                  className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
                >
                  privacy@htmlradar.com
                </a>
              </p>
            </Section>
          </div>
        </article>
      </main>
      <V2Footer />
    </>
  );
}

function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id}>
      <h2 className="font-serif text-[24px] leading-snug text-ink md:text-[26px]">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
