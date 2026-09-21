// /compare/livesend — the closest competitor we had not written about.
// LiveSend serves the same buyer as HTMLRadar (an agency or consultant
// sending a client-facing HTML report) and on 21 September 2026 it was the
// top result for "share HTML report with clients", a search where HTMLRadar
// did not appear at all.
//
// Every LiveSend fact on this page was verified on 21 September 2026 against
// livesend.io's own pages — home (which carries the pricing block), FAQ, the
// Claude connector page and the terms of service — and nothing else. The
// sources, the supporting sentences, and the claims that were dropped as
// unverifiable are written down in
// docs/workstreams/seo-and-indexing/COMPARE-LIVESEND-EVIDENCE-2026-09-21.md.
// If you change a LiveSend claim here, re-verify it and update that file.
//
// Two traps a future editor should know about. LiveSend has no /pricing page
// (it 404s); pricing is a block on the home page whose billing toggle
// defaults to Yearly, so a plain fetch shows $12/mo and the real monthly
// price is $15. And LiveSend is NOT cheaper than HTMLRadar month to month —
// both are $15 — it is $6 a year cheaper when paid annually. Say it that way.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { V2Footer } from '@/components/V2Footer';
import { SectionMark } from '@/components/SectionMark';
import { DirectAnswer } from '@/components/DirectAnswer';
import { BreadcrumbLd } from '@/components/JsonLd';
import { Faq } from '@/components/Faq';
import { pageMeta } from '@/lib/seo';
import { Check, X } from 'lucide-react';

export const runtime = 'edge';

export const metadata = pageMeta({
  title: 'HTMLRadar vs LiveSend (2026) | HTMLRadar',
  description:
    'Both turn an HTML report into a tracked client link. LiveSend edits in place and takes comments; HTMLRadar reads section by section and is open source.',
  path: '/compare/livesend',
});

// The date every LiveSend claim on this page was last checked against
// livesend.io's own pages. Printed under the H1 and again above the table.
const CHECKED = '21 September 2026';

interface Row {
  feature: string;
  htmlradar: string | boolean;
  livesend: string | boolean;
}

const ROWS: Row[] = [
  {
    feature: 'What you send it',
    htmlradar: 'An HTML file, or a URL you already host',
    livesend: 'An HTML file, or HTML pasted as code',
  },
  {
    feature: 'Reading data it reports',
    htmlradar: 'Section by section, per recipient, with dwell time and scroll depth',
    livesend: 'Opens, unique visitors, read time and country',
  },
  {
    feature: 'Edit the document after sending',
    htmlradar: 'Replace the whole file; every link keeps working',
    livesend: 'Edit the text in the browser on Pro; every save is versioned',
  },
  {
    feature: 'Comments from readers',
    htmlradar: false,
    livesend: 'On Pro: a reader selects a passage and comments; you reply and resolve',
  },
  {
    feature: 'Free plan',
    htmlradar: '2 tracked links, full section-level analytics, a “Powered by HTMLRadar” credit',
    livesend: '3 documents, public link only, watermark, anonymous open alerts, 7-day counts',
  },
  {
    feature: 'Password, expiry and allow-lists',
    htmlradar: 'E-mail gate, password, expiry, revoke and allow-lists on the free plan',
    livesend: 'Password protection and custom expiration listed on Pro',
  },
  {
    feature: 'Entry price',
    htmlradar: '$15 a month, or $150 a year, unlimited links',
    livesend: '$15 a month, or $144 a year ($12 a month billed annually), unlimited documents',
  },
  {
    feature: 'Team plan',
    htmlradar: 'None; one flat price, no per-seat charge',
    livesend: '$59 a month, or $564 a year, 3 seats included, then $25 a seat',
  },
  {
    feature: 'Your own domain',
    htmlradar: 'Included in Pro, one CNAME record',
    livesend: 'Stated as roadmap; links are livesend.io addresses today',
  },
  {
    feature: 'Claude connector',
    htmlradar: 'mcp.htmlradar.com/mcp, seven tools',
    livesend: 'livesend.io/api/mcp/mcp, twelve tools',
  },
  {
    feature: 'Largest HTML file',
    htmlradar: '30 MB uploaded in the dashboard; 5 MB through the API or connector',
    livesend: '3 MB, or 6 MB on Pro',
  },
  {
    feature: 'PDF-to-HTML converter',
    htmlradar: 'Free at /convert, in your browser, no account',
    livesend: 'None published',
  },
  {
    feature: 'Open source',
    htmlradar: 'AGPL-3.0, whole repository',
    livesend: 'No source or licence published',
  },
  {
    feature: 'Self-hosting',
    htmlradar: 'Your own Cloudflare and Supabase accounts',
    livesend: 'Hosted service; no self-hosted option published',
  },
];

function Cell({ v }: { v: string | boolean }) {
  if (v === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-signal-dark">
        <Check className="size-4" aria-hidden /> Yes
      </span>
    );
  }
  if (v === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-graphite">
        <X className="size-4" aria-hidden /> No
      </span>
    );
  }
  return <span className="text-ink">{v}</span>;
}

export default function CompareLiveSendPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'HTMLRadar vs LiveSend', url: '/compare/livesend' },
            ]}
          />
          <SectionMark>HTMLRadar · Compare</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            HTMLRadar vs LiveSend.
          </h1>
          <DirectAnswer updated={CHECKED} label="Competitor facts checked">
            Choose LiveSend if you want to fix the wording of a report in your browser after you
            have sent it, or if you want your client to select a passage and comment on it, because
            LiveSend does both on its Pro plan and HTMLRadar does neither. Choose HTMLRadar if what
            you need back is which sections each recipient read and for how long, or if you want to
            read the source, run it on your own infrastructure, or put a password, an expiry date
            and an e-mail gate on a link without paying.
          </DirectAnswer>
          <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
            These two products are aimed at the same person. LiveSend&rsquo;s home page opens with
            &ldquo;Deliver client reports on your own branded link&rdquo; and names marketing
            agencies, consultants and B2B sales teams; HTMLRadar was built for the same three. Both
            take an HTML report that an assistant or a person wrote and turn it into a tracked link
            instead of an attachment. So this page is not an argument that one is a worse product.
            It is a list of the places where the two genuinely differ, checked against
            LiveSend&rsquo;s own pages on {CHECKED}.
          </p>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              The headline difference
            </h2>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  HTMLRadar
                </h3>
                <p className="mt-3 font-serif text-[20px] leading-snug text-ink">
                  Measures reading, section by section. Open source.
                </p>
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
                  The report you get back names the headings each recipient stopped on and how long
                  they stayed on each one. The whole repository is AGPL-3.0 and runs on your own
                  Cloudflare and Supabase accounts if you would rather not use ours.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper-2/40 p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  LiveSend
                </h3>
                <p className="mt-3 font-serif text-[20px] leading-snug text-ink">
                  Keeps the document editable, and lets readers reply to it.
                </p>
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
                  On its Pro plan you can fix a number or a paragraph in the browser without
                  re-uploading anything, every save is versioned, and a client can select a passage
                  and leave a comment that you answer from your dashboard.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What LiveSend does that HTMLRadar does not
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              Four things, stated from LiveSend&rsquo;s own pages as they read on {CHECKED}.
            </p>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                <strong className="font-medium text-ink">
                  Editing a published document in place.
                </strong>{' '}
                LiveSend&rsquo;s FAQ says you can fix a number or a paragraph directly in the
                dashboard on Pro, with no re-upload and no resend, and that every save is versioned.
                HTMLRadar has no editor: you change the file on your own machine and replace it.
              </li>
              <li>
                <strong className="font-medium text-ink">Comments from the reader.</strong> LiveSend
                invites a client to annotate the document by selecting text, and the sender replies
                and resolves from the dashboard. HTMLRadar has nothing of the kind — it measures
                reading and sends you nothing the reader typed.
              </li>
              <li>
                <strong className="font-medium text-ink">A larger connector.</strong> The LiveSend
                connector for Claude lists twelve tools against HTMLRadar&rsquo;s seven, and two of
                them have no HTMLRadar equivalent: editing a published document, and restoring an
                earlier version.
              </li>
              <li>
                <strong className="font-medium text-ink">A team plan.</strong> LiveSend sells a Team
                plan with a shared space, central administration and one invoice. HTMLRadar has no
                team plan at all — one account, one flat price.
              </li>
            </ul>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              On price, the honest version is narrower than it first looks. Billed monthly both Pro
              plans are $15. Paid a year at a time, LiveSend is $144 and HTMLRadar is $150, so
              LiveSend is $6 a year cheaper, and only then.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What HTMLRadar does that LiveSend does not
            </h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                <strong className="font-medium text-ink">
                  Reading measured section by section.
                </strong>{' '}
                The analytics LiveSend publishes are opens, unique visitors, read time and country;
                no per-section or per-heading measure appears anywhere on its pages. HTMLRadar
                records time against each heading or slide, per recipient, so you can see that
                someone spent four minutes on the pricing section and nine seconds on the method
                notes.
              </li>
              <li>
                <strong className="font-medium text-ink">Open source, and self-hostable.</strong>{' '}
                HTMLRadar is AGPL-3.0 across the whole repository — tracker, proxy, schema and web
                app — and runs in your own Cloudflare and Supabase accounts. LiveSend publishes no
                source repository, no licence and no self-hosting option; it is a hosted service
                operated by Nanoscale Studio, a sole proprietorship registered in France.
              </li>
              <li>
                <strong className="font-medium text-ink">Your own domain, included in Pro.</strong>{' '}
                One CNAME record and your links are served from decks.yourcompany.com instead of
                ours. LiveSend&rsquo;s FAQ states that custom domains are on its roadmap and that
                every document lives at a livesend.io address today.
              </li>
              <li>
                <strong className="font-medium text-ink">
                  Every link control on the free plan.
                </strong>{' '}
                An e-mail gate, a password, an expiry date, revoke, and e-mail-domain and per-e-mail
                allow-lists all work on HTMLRadar&rsquo;s free plan. LiveSend lists password
                protection and custom expiration on Pro, and its free plan is described as public
                link only.
              </li>
              <li>
                <strong className="font-medium text-ink">A PDF-to-HTML converter.</strong> If what
                you have is a PDF deck rather than an HTML page, HTMLRadar converts it in your
                browser, free and without an account. LiveSend publishes no converter.
              </li>
              <li>
                <strong className="font-medium text-ink">Room for a larger file.</strong> LiveSend
                states a 3 MB limit per HTML file, 6 MB on Pro. HTMLRadar accepts 30 MB through the
                dashboard, and 5 MB through the API or the connector.
              </li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Side by side
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-graphite">
              LiveSend column checked against livesend.io&rsquo;s home, FAQ, connector and terms
              pages on {CHECKED}.
            </p>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">Feature</th>
                    <th className="px-5 py-3">HTMLRadar</th>
                    <th className="px-5 py-3">LiveSend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ROWS.map((r) => (
                    <tr key={r.feature}>
                      <td className="px-5 py-3.5 align-top text-ink">{r.feature}</td>
                      <td className="px-5 py-3.5 align-top">
                        <Cell v={r.htmlradar} />
                      </td>
                      <td className="px-5 py-3.5 align-top">
                        <Cell v={r.livesend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What each one costs
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              Prices as published on {CHECKED}. LiveSend lists three plans: Free at $0, Pro at $15 a
              month billed monthly or $144 a year, and Team at $59 a month billed monthly or $564 a
              year, with three seats included and $25 a seat after that. Its free plan covers three
              documents on a public link, with a LiveSend watermark on every page, anonymous
              &ldquo;opened&rdquo; alerts and seven days of view and visitor counts. Its own terms
              of service restate the Pro price as &ldquo;$15/month or $12/month billed annually
              ($144/year)&rdquo;.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar is $15 a month or $150 a year for unlimited tracked links, with no per-seat
              charge, and a free plan of two tracked links carrying the same section-level analytics
              as Pro and every link control. A{' '}
              <Link href="/custom-domains" className="text-signal-dark hover:underline">
                custom domain for your tracked links
              </Link>{' '}
              is included in Pro at no extra charge. The full breakdown is on the{' '}
              <Link href="/pricing" className="text-signal-dark hover:underline">
                HTMLRadar pricing page
              </Link>
              .
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              One warning if you are checking these numbers yourself: LiveSend has no /pricing page,
              the prices sit in a block on its home page, and that block&rsquo;s billing switch
              opens on Yearly. Read it quickly and you will come away thinking Pro is $12 a month
              when the monthly price is $15.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When LiveSend is the right choice
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                The report changes after you send it, in small ways, often, and you would rather fix
                a number in a browser than edit a file and upload it again.
              </li>
              <li>
                You want the client to write back inside the document rather than in an e-mail, on
                the exact sentence they are asking about.
              </li>
              <li>
                Several people in your firm send client work and you want one shared space, one
                invoice and central administration.
              </li>
              <li>
                You want your assistant to do more of the work from the conversation than
                HTMLRadar&rsquo;s seven tools cover, including editing a published document and
                restoring an earlier version.
              </li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When HTMLRadar is the right choice
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                The question you actually want answered is which part of the report held attention,
                not only whether it was opened and for how many minutes in total.
              </li>
              <li>
                You want to read the tracking code, or keep client documents on infrastructure you
                control, under a licence that lets you.
              </li>
              <li>
                You want a password, an expiry date, an e-mail gate or an allow-list on a link
                before you are ready to pay for anything.
              </li>
              <li>
                Your links should carry your own domain, and you would rather not wait for a
                roadmap.
              </li>
              <li>What you have is a PDF deck, and you need it to become a web page first.</li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When not to choose HTMLRadar
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar has a narrow job and there are cases where it is the wrong tool. Do not
              choose it if the document has to stay editable in a browser after it is sent, because
              HTMLRadar has no editor and replacing the file means producing a new file. Do not
              choose it if you need comments back from the reader, or a shared team space with one
              invoice, because it has neither. Do not choose it if you need to roll a document back
              to an earlier version on demand: HTMLRadar records every version&rsquo;s filename,
              size and time, but there is no button that restores one. And if what you send is a PDF
              or an office file that will never become a web page, the section-level reading data
              that is the point of HTMLRadar will not be there for you.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Moving from LiveSend
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              There is no import. What transfers is the HTML file itself: download or re-export the
              document, upload it to HTMLRadar, and create one link per recipient. Links you already
              sent from LiveSend keep working at LiveSend — nothing here switches them off — so you
              can run the next report through both and compare what each tells you. If you want a
              hand with that, email{' '}
              <a
                href="mailto:hello@htmlradar.com"
                className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
              >
                hello@htmlradar.com
              </a>
              . Free.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              One habit worth carrying over: if you are used to editing a sent document in place,
              read{' '}
              <Link
                href="/for/update-a-document-after-sending"
                className="text-signal-dark hover:underline"
              >
                how to update a document after you have sent it on HTMLRadar
              </Link>{' '}
              first, because the same outcome is reached a different way.
            </p>
          </section>

          <Faq
            items={[
              {
                q: 'Is LiveSend or HTMLRadar better for sharing an HTML report with clients?',
                a: 'It depends on what you want back. Both take an HTML report and give you a tracked link, and both are aimed at agencies, consultants and B2B sales teams. LiveSend reports opens, unique visitors, read time and country, and lets you edit the document in the browser afterwards and collect comments from the reader on its Pro plan. HTMLRadar reports which sections each recipient read and for how long, is open source under AGPL-3.0 and self-hostable, and puts the e-mail gate, password, expiry and allow-lists on its free plan.',
              },
              {
                q: 'How much does LiveSend cost?',
                a: 'On 21 September 2026 LiveSend listed a free plan of three documents, a Pro plan at $15 a month billed monthly or $144 a year, and a Team plan at $59 a month billed monthly or $564 a year with three seats included and $25 a seat after that. Its terms of service restate Pro as "$15/month or $12/month billed annually ($144/year)". HTMLRadar Pro is $15 a month or $150 a year, so the two are identical month to month and LiveSend is $6 a year cheaper paid annually.',
              },
              {
                q: 'Is LiveSend open source?',
                a: 'Not as far as its own site says. LiveSend publishes no source repository, no licence statement and no self-hosting option on any of its pages; its terms describe a hosted service operated by Nanoscale Studio, a sole proprietorship registered in France. HTMLRadar is AGPL-3.0 across the whole repository — tracker, proxy worker, schema and web app — and can be run entirely in your own Cloudflare and Supabase accounts.',
              },
              {
                q: 'Can I edit a document after I have sent the link?',
                a: 'On LiveSend, yes: its FAQ says Pro users fix a number or a paragraph directly in the dashboard, with every save versioned. On HTMLRadar there is no editor. You change the file yourself and replace it, and every link you have already sent serves the new contents the next time it is opened, with the same address and the same reading history. The trade is that HTMLRadar needs a new file and LiveSend does not.',
              },
              {
                q: 'Does LiveSend have a Claude connector?',
                a: 'Yes. LiveSend publishes a connector at livesend.io/api/mcp/mcp and describes it as twelve tools grouped under five intentions, including editing a published document and restoring an earlier version. HTMLRadar publishes a connector at mcp.htmlradar.com/mcp with seven tools: publish a document, make another link for it, list your links, read who opened one, switch one off, replace the contents behind every link, and check which plan you are on.',
              },
              {
                q: 'Which one tracks how long someone spent on each section?',
                a: 'HTMLRadar does. It records time against each heading or slide, per recipient, so the report distinguishes four minutes on the pricing section from nine seconds on the appendix. LiveSend publishes opens, unique visitors, read time and country; no per-section measure appears on any of its pages, though it does e-mail you when a document is opened.',
              },
            ]}
          />

          <section className="mt-14">
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Try HTMLRadar free
            </Link>
            <p className="mt-3 text-[13px] text-graphite">
              First 2 tracked links free. No credit card. AGPLv3 source on{' '}
              <a
                href="https://github.com/htmlradar/htmlradar"
                className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
              >
                GitHub
              </a>
              .
            </p>
          </section>

          <div className="mt-20 border-t border-line pt-10">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              Related:{' '}
              <Link
                href="/use-case/client-report-tracking"
                className="text-signal-dark hover:underline"
              >
                sending an HTML report to a client
              </Link>
              ,{' '}
              <Link href="/compare/docsend" className="text-signal-dark hover:underline">
                HTMLRadar vs DocSend
              </Link>
              ,{' '}
              <Link href="/compare/papermark" className="text-signal-dark hover:underline">
                HTMLRadar vs Papermark
              </Link>
              ,{' '}
              <Link href="/pricing" className="text-signal-dark hover:underline">
                HTMLRadar pricing
              </Link>
              ,{' '}
              <Link href="/custom-domains" className="text-signal-dark hover:underline">
                tracked links on your own domain
              </Link>
              , and{' '}
              <Link href="/self-hosted" className="text-signal-dark hover:underline">
                self-hosted document tracking
              </Link>
              .
            </p>
          </div>
        </article>
      </main>
      <V2Footer />
    </>
  );
}
