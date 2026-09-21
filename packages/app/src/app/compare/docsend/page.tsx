// /compare/docsend — SEO target "DocSend alternative" (~5K/mo).
// Honest feature + pricing comparison. AGPL angle as differentiator.
//
// Every DocSend fact on this page was verified on 21 September 2026 against
// docsend.com or the DocSend help centre. The sources, the supporting
// sentences and the claims that were softened are written down in
// docs/workstreams/seo-and-indexing/COMPARE-PAGES-EVIDENCE-2026-09-21.md.
// If you change a DocSend claim here, re-verify it and update that file.

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
  title: 'DocSend Alternative for HTML Files (2026) | HTMLRadar',
  description:
    'DocSend does not accept .html uploads. HTMLRadar tracks the HTML page itself, section by section. Open source, free for 2 links, then $15 a month.',
  path: '/compare/docsend',
  languages: {
    en: '/compare/docsend',
    pl: '/pl/alternatywa-dla-docsend',
    'x-default': '/compare/docsend',
  },
});

// The date every competitor claim on this page was last checked against
// DocSend's own pages. It is printed twice — under the H1 and above the
// pricing table — so a reader can see the claims and the date together.
const CHECKED = '21 September 2026';

interface Row {
  feature: string;
  htmlradar: string | boolean;
  docsend: string | boolean;
  note?: string;
}

const ROWS: Row[] = [
  {
    feature: 'Upload an .html file',
    htmlradar: 'Yes — HTML is the main input',
    docsend: 'Not on the accepted-file list',
  },
  {
    feature: 'Accepted uploads',
    htmlradar: 'HTML files, or a URL you already host',
    docsend: 'PDF, PowerPoint, Word, Keynote, images, audio, video, spreadsheets',
  },
  {
    feature: 'Page-by-page reading data',
    htmlradar: 'Per section of the HTML page, per recipient',
    docsend: 'PDF, Word, PowerPoint, Google Docs, Google Slides and Keynote',
  },
  {
    feature: 'Tracking a web page you host',
    htmlradar: 'Full section-level reading',
    docsend: 'Device, location and visit time only, on a paid plan',
  },
  {
    feature: 'Free plan',
    htmlradar: '2 tracked links, full analytics on both',
    docsend: 'No free plan; 14-day trial of Advanced Data Rooms',
  },
  {
    feature: 'Entry price',
    htmlradar: '$15 a month, or $150 a year, unlimited links',
    docsend: '$30 per user per month on Standard',
  },
  {
    feature: 'Data rooms',
    htmlradar: false,
    docsend: 'Spaces, from the Advanced plan upwards',
  },
  {
    feature: 'E-signature',
    htmlradar: false,
    docsend: 'Unlimited signature requests on every plan',
  },
  {
    feature: 'NDAs, watermarking, SSO',
    htmlradar: false,
    docsend: 'On Advanced and above; SSO listed as an add-on',
  },
  { feature: 'Open source', htmlradar: 'AGPL-3.0, whole repository', docsend: false },
  {
    feature: 'Self-hosting',
    htmlradar: 'Your own Cloudflare and Supabase accounts',
    docsend: 'Hosted service only',
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

export default function ComparePage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'HTMLRadar vs DocSend', url: '/compare/docsend' },
            ]}
          />
          <SectionMark>HTMLRadar · Compare</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            The DocSend alternative for HTML files.
          </h1>
          <DirectAnswer updated={CHECKED} label="Competitor facts checked">
            Stay with DocSend if what you send is a PDF, a PowerPoint or a Keynote, or if you need
            data rooms, e-signature or enterprise access controls, because HTMLRadar has none of
            those. Use HTMLRadar if the thing you send is an HTML deck, brief or proposal: DocSend
            does not accept .html as an upload, and HTMLRadar keeps the page as a page and reports
            which sections each recipient read and for how long.
          </DirectAnswer>
          <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
            DocSend is an established document-tracking product owned by Dropbox, and it is good at
            what it does. This page is not an argument that it is worse. It is an answer to one
            narrow question: what do you do when the document you want to track is a web page rather
            than a file?
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
                  HTML-first, open source, $15 a month flat.
                </p>
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
                  Track HTML decks from Claude, ChatGPT, v0, reveal.js, or hand-written HTML.
                  Self-host the whole thing or use the hosted plan. AGPL-3.0, one price, no per-seat
                  charge.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper-2/40 p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  DocSend
                </h3>
                <p className="mt-3 font-serif text-[20px] leading-snug text-ink">
                  File tracking, data rooms and e-signature.
                </p>
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
                  A hosted product for PDFs, presentations, documents, media and spreadsheets, with
                  data rooms, unlimited e-signature, NDAs and dynamic watermarking on its higher
                  plans. Its accepted-file list does not include .html.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What happens when you upload an HTML file
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              This is the part most comparison pages skip, so here it is plainly, from
              DocSend&rsquo;s own help centre as it read on {CHECKED}.
            </p>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-paper-2/40 p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  In DocSend
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  DocSend&rsquo;s list of accepted uploads covers PDF, PowerPoint, Word, Keynote,
                  images, audio, video and spreadsheets. Neither .html nor .htm appears on it, and
                  neither appears on the separate download-only list, which covers .rtf, .txt and
                  archive formats. So there is no route that turns an HTML file into a DocSend
                  document.
                </p>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  If the page is already published somewhere public, DocSend can track a link to it
                  through its external URL links feature. What you get back is the visitor&rsquo;s
                  device and operating system, their approximate location and the time of the visit.
                  The feature is on paid plans only and is switched off during the trial.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  In HTMLRadar
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  You drop the .html file in, or paste a URL you already host. The page stays a
                  page: fonts, layout, links and interactions all still work for the recipient.
                </p>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  Each recipient gets their own link, and the report tells you which headings or
                  slides they read and how long they stayed on each. Knowing someone spent four
                  minutes on the Ask slide is a different piece of information from knowing they
                  reached eighty per cent of the scroll.
                </p>
              </div>
            </div>
            <p className="mt-5 text-[16px] leading-relaxed text-ink-soft">
              If what you actually have is a PDF, you do not have to pick a side yet.{' '}
              <Link href="/convert" className="text-signal-dark hover:underline">
                Convert a PDF deck into a single HTML page for free in your browser
              </Link>{' '}
              — no account needed to convert and download — and then decide which tracker suits the
              result.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Side by side
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-graphite">
              DocSend column checked against docsend.com and the DocSend help centre on {CHECKED}.
            </p>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">Feature</th>
                    <th className="px-5 py-3">HTMLRadar</th>
                    <th className="px-5 py-3">DocSend</th>
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
                        <Cell v={r.docsend} />
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
              Prices as published on {CHECKED}, billed monthly. DocSend lists three plans: Standard
              at $30 per user per month with one user included, Advanced at $150 a month with three
              users included, and Advanced Data Rooms at $180 a month with three users included.
              Paying yearly is advertised as saving up to 40 per cent. There is no free plan; there
              is a 14-day free trial of Advanced Data Rooms.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar is $15 a month or $150 a year for unlimited tracked links, with no per-seat
              charge, and a free plan that covers two tracked links with the same section-level
              analytics as Pro. A{' '}
              <Link href="/custom-domains" className="text-signal-dark hover:underline">
                custom domain for your tracked links
              </Link>{' '}
              is included in Pro at no extra charge, which is one CNAME record and then
              decks.yourcompany.com/r/acme-proposal instead of htmlradar.page. The full breakdown is
              on the{' '}
              <Link href="/pricing" className="text-signal-dark hover:underline">
                HTMLRadar pricing page
              </Link>
              .
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              The comparison is not like for like, and we would rather say so than pretend
              otherwise. DocSend&rsquo;s price buys a data room, e-signature and enterprise
              controls. HTMLRadar&rsquo;s price buys HTML tracking and nothing else.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When DocSend is the right choice
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                You send PDFs, presentations, office documents, media or spreadsheets, and you want
                page-by-page reading data on those formats. That is exactly what DocSend is built
                for.
              </li>
              <li>
                You need a data room. DocSend calls them Spaces, they arrive on the Advanced plan,
                and its top plan adds group permissions, audit logs, due diligence tracking and
                automatic file indexing. HTMLRadar has no data room at all.
              </li>
              <li>
                You need documents signed. DocSend includes unlimited e-signature on every plan.
                HTMLRadar does not do e-signature.
              </li>
              <li>
                You need NDAs and gating agreements, dynamic watermarking, visitor allow and block
                lists, tiered admin roles or single sign-on. DocSend lists all of these on its
                higher plans. HTMLRadar has none of them.
              </li>
              <li>You would rather not think about open-source licensing or self-hosting. Fair.</li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When HTMLRadar is the right choice
            </h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                You send HTML decks — Claude artifacts, reveal.js builds, hand-written pages — and
                you want them to stay HTML when you track them.
              </li>
              <li>
                You want to read the tracker code, or run the whole product in your own Cloudflare
                and Supabase accounts. HTMLRadar is AGPL-3.0 across the whole repository.
              </li>
              <li>
                You want to know which section held attention, per recipient, rather than a single
                scroll-depth number.
              </li>
              <li>
                You are one person or a small team and a per-seat price does not suit you. One flat
                price covers unlimited links.
              </li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When not to choose HTMLRadar
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar is a young product with a narrow job, and there are cases where it is the
              wrong tool. Do not choose it if you need a data room, e-signature, NDAs and gating
              agreements, dynamic watermarking, single sign-on or tiered administrative roles: it
              has none of those. Do not choose it if your source of truth is a PDF or an office file
              that will never become a web page, because attachments ride along under a tracked link
              but the section-level reading data is for HTML. And do not choose it if you need a
              vendor with a long compliance history behind it; DocSend is a Dropbox product and
              HTMLRadar is not.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Migrating from DocSend
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar does not import existing DocSend files. For new HTML decks, bring a Claude
              artifact, reveal.js build, or hand-written page; upload it to HTMLRadar; and create
              per-recipient share links. The workflow stays in HTML from start to finish. The{' '}
              <Link href="/tools" className="text-signal-dark hover:underline">
                free HTMLRadar tools for turning HTML and Claude artifacts into links
              </Link>{' '}
              are the quickest way to see what a recipient will get.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              If you need help with the cutover, email{' '}
              <a
                href="mailto:hello@htmlradar.com"
                className="text-signal-dark underline decoration-line decoration-2 underline-offset-4 hover:decoration-signal"
              >
                hello@htmlradar.com
              </a>{' '}
              and we&apos;ll walk through it. Free.
            </p>
          </section>

          <Faq
            items={[
              {
                q: 'Can you upload an HTML file to DocSend?',
                a: 'Not as a document. DocSend’s published list of accepted uploads, checked on 21 September 2026, covers PDF, PowerPoint, Word, Keynote, images, audio, video and spreadsheets, and its separate download-only list covers .rtf, .txt and archive formats. Neither list includes .html or .htm. If the page is already hosted publicly you can add it as an external URL link on a paid plan, but the visit data for those links is limited to the visitor’s device, location and the time of the visit.',
              },
              {
                q: 'What is the best free DocSend alternative?',
                a: 'DocSend has no free plan, only a 14-day trial, so any free alternative is a different product rather than a cheaper DocSend. HTMLRadar’s free plan covers 2 tracked links with the same section-level analytics as the paid plan and no credit card. Papermark’s free plan is more generous on link count — 50 links, with 30-day analytics retention — and is worth a look if your documents are PDFs. HTMLRadar is the one to try if your documents are HTML.',
              },
              {
                q: 'How much does DocSend cost compared with HTMLRadar?',
                a: 'On 21 September 2026 DocSend listed Standard at $30 per user per month, Advanced at $150 a month for three users, and Advanced Data Rooms at $180 a month for three users, billed monthly. HTMLRadar is $15 a month or $150 a year for unlimited tracked links with no per-seat charge. The plans are not equivalent: DocSend’s price includes data rooms, e-signature and enterprise controls that HTMLRadar does not have.',
              },
              {
                q: 'Does HTMLRadar track PDFs like DocSend does?',
                a: 'Not in the same way. HTMLRadar is HTML-first. PDFs, spreadsheets and ZIPs ride along as attachments under the same tracked link, and every download is logged per recipient, but the section-level dwell tracking is for HTML documents. If you want a PDF deck tracked section by section, convert it at /convert first — that is free and runs in your browser.',
              },
              {
                q: 'Can I self-host a DocSend alternative?',
                a: 'Yes. HTMLRadar is AGPL-3.0 across the whole repository — tracker, proxy worker, schema and web app — and runs in your own Cloudflare and Supabase accounts, with a self-hosting guide in the repository. DocSend is a hosted service with no self-hosted option. Papermark is also open source, under AGPLv3 apart from its ee and app/(ee) directories, which carry a commercial licence.',
              },
              {
                q: 'Does HTMLRadar support custom domains like DocSend’s branded subdomain?',
                a: 'Yes, and it is included in Pro at $15 a month with no extra charge. You add one CNAME record and your links are served from your own subdomain, for example decks.yourcompany.com/r/acme-proposal. Tracking, email gates, passwords and expiry dates behave exactly as before, and links you have already sent keep working at the address they were issued on.',
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
              <Link href="/compare/papermark" className="text-signal-dark hover:underline">
                HTMLRadar vs Papermark
              </Link>
              ,{' '}
              <Link
                href="/compare/docsend-vs-papermark"
                className="text-signal-dark hover:underline"
              >
                DocSend vs Papermark compared
              </Link>
              ,{' '}
              <Link href="/convert" className="text-signal-dark hover:underline">
                the free PDF-to-HTML converter
              </Link>
              ,{' '}
              <Link href="/pricing" className="text-signal-dark hover:underline">
                HTMLRadar pricing
              </Link>
              ,{' '}
              <Link href="/custom-domains" className="text-signal-dark hover:underline">
                tracked links on your own domain
              </Link>
              ,{' '}
              <Link href="/compare/peony" className="text-signal-dark hover:underline">
                HTMLRadar vs Peony
              </Link>
              ,{' '}
              <Link href="/compare/stacktree" className="text-signal-dark hover:underline">
                HTMLRadar vs Stacktree
              </Link>
              ,{' '}
              <Link href="/compare/tiiny-host" className="text-signal-dark hover:underline">
                HTMLRadar vs Tiiny.host
              </Link>
              ,{' '}
              <Link href="/compare/hummingdeck" className="text-signal-dark hover:underline">
                HTMLRadar vs HummingDeck
              </Link>
              ,{' '}
              <Link href="/self-hosted" className="text-signal-dark hover:underline">
                self-hosted document tracking
              </Link>
              , and{' '}
              <Link
                href="/use-case/pitch-deck-tracking"
                className="text-signal-dark hover:underline"
              >
                pitch deck tracking for founders
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
