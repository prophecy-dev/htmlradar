// /compare/papermark — SEO target "Papermark alternative".
//
// Every Papermark fact on this page was verified on 21 September 2026 against
// papermark.com, the Papermark help centre or the papermark/papermark
// repository. The sources, the supporting sentences and the claims that were
// softened are written down in
// docs/workstreams/seo-and-indexing/COMPARE-PAGES-EVIDENCE-2026-09-21.md.
// If you change a Papermark claim here, re-verify it and update that file.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { V2Footer } from '@/components/V2Footer';
import { BreadcrumbLd } from '@/components/JsonLd';
import { Faq } from '@/components/Faq';
import { SectionMark } from '@/components/SectionMark';
import { DirectAnswer } from '@/components/DirectAnswer';
import { pageMeta } from '@/lib/seo';

export const runtime = 'edge';

export const metadata = pageMeta({
  title: 'Papermark Alternative for HTML Decks | HTMLRadar',
  description:
    'Papermark does not accept .html uploads. HTMLRadar tracks the HTML deck itself, section by section. AGPL-3.0, free for 2 links, then $15 a month.',
  path: '/compare/papermark',
});

// The date every Papermark claim on this page was last checked against
// Papermark's own pages and repository.
const CHECKED = '21 September 2026';

// Papermark's prices are listed in euros and dollars behind a currency
// toggle. The page renders euros by default, and euros are what we could read
// and cite, so euros are what we print — named as euros, with the date.
const ROWS: [string, string, string][] = [
  ['Upload an .html file', 'Yes — HTML is the main input', 'Not on the supported-file list'],
  [
    'Supported uploads',
    'HTML files, or a URL you already host',
    'PDF, spreadsheets, presentations, Word, images, video, audio, .msg, CAD, ZIP, and Notion URLs',
  ],
  [
    'Reading detail',
    'Which heading or slide of the HTML page, per recipient',
    'Page-by-page analytics on every plan',
  ],
  [
    'Analytics retention',
    'Sessions and section events retained indefinitely, per our privacy page',
    '30 days on Free, 1 year on Pro, 2 years on Business and Data Rooms',
  ],
  [
    'Free plan',
    '2 tracked links, full section-level analytics',
    '50 links, 50 documents, 1 team member',
  ],
  ['Entry paid price', '$15 a month, or $150 a year, unlimited links', '€24 a month for Pro'],
  [
    'Custom domain for links',
    'Included in Pro at $15 a month',
    'From the Business plan at €59 a month',
  ],
  [
    'Data rooms',
    'None',
    'Yes — the Data Rooms plan, €99 a month, adds granular file permissions and NDA agreements',
  ],
  [
    'Licence',
    'AGPL-3.0 across the whole repository',
    'AGPLv3 except the ee and app/(ee) directories, which are commercially licensed',
  ],
  [
    'Self-hosting',
    'Your own Cloudflare and Supabase accounts',
    'Source is public; the self-hosted option and self-hosting support are listed as Enterprise',
  ],
];

const FAQ = [
  {
    q: 'Can you upload an HTML file to Papermark?',
    a: 'Not as a document. Papermark’s published list of supported file types, checked on 21 September 2026, covers PDF, spreadsheets, presentations, Word, images, CAD, ZIP, video, audio, Outlook .msg and Google Earth files. Its one web entry is Notion URLs. Neither .html nor .htm appears on the list. HTMLRadar takes the .html file directly, or a URL you already host, and keeps it as a page for the recipient.',
  },
  {
    q: 'Is Papermark or HTMLRadar the better open-source DocSend alternative?',
    a: 'They answer different questions. Papermark is the broader product: document sharing, data rooms, page-by-page analytics on office files, and a much larger free plan at 50 links. HTMLRadar is narrow: it tracks HTML pages section by section. If your documents are PDFs and you want a data room, Papermark is the stronger choice. If your documents are HTML decks, briefs or proposals, Papermark has no path for them and HTMLRadar does.',
  },
  {
    q: 'How much does Papermark cost compared with HTMLRadar?',
    a: 'On 21 September 2026 Papermark listed, in euros and billed monthly, a free plan at €0, Pro at €24 a month, Business at €59 a month with three team members, and Data Rooms at €99 a month with three team members. HTMLRadar is $15 a month or $150 a year for unlimited tracked links with no per-seat charge, plus a free plan of 2 tracked links. Papermark’s free plan is far more generous on link count; HTMLRadar’s paid plan is cheaper and includes a custom domain that Papermark puts on its €59 tier.',
  },
  {
    q: 'Is Papermark fully open source?',
    a: 'Almost. Its LICENSE file, read on 21 September 2026, puts the repository under AGPLv3 with one carve-out: everything under the ee and app/(ee) directories is under a separate commercial licence. Its pricing page also lists the self-hosted option and self-hosting support as Enterprise lines. HTMLRadar is AGPL-3.0 across the whole repository with no separately licensed directory, and the self-hosting guide is in the repository for anyone.',
  },
  {
    q: 'Which should I choose for a pitch deck?',
    a: 'It depends on what the deck is. If it exists as a PDF or a PowerPoint and always will, Papermark will track it page by page and HTMLRadar will not. If it exists as HTML — a Claude artifact, a reveal.js build, a page you wrote — then converting it to a PDF just to track it throws away the layout and interactions you built, and HTMLRadar tracks the page as it is. If you have a PDF and want to try the HTML route, the free converter at /convert turns a landscape PDF deck into one HTML page in your browser.',
  },
  {
    q: 'Does HTMLRadar have data rooms?',
    a: 'No. HTMLRadar tracks one document per link, with attachments that ride along under the same link. There is no folder structure, no group permissions and no due-diligence workflow. If you need a data room, Papermark has one — its Data Rooms plan at €99 a month adds granular file permissions, NDA agreements and data-room analytics — and that is the honest answer.',
  },
];

export default function ComparePapermarkPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'HTMLRadar vs Papermark', url: '/compare/papermark' },
            ]}
          />
          <SectionMark>HTMLRadar · Compare</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            The Papermark alternative for HTML decks.
          </h1>
          <DirectAnswer updated={CHECKED} label="Competitor facts checked">
            Stay with Papermark if your documents are PDFs or office files, if you need a data room,
            or if a large free plan matters more than anything else — it gives you 50 links free
            where HTMLRadar gives you 2. Use HTMLRadar if the thing you send is an HTML deck, brief
            or proposal: Papermark&rsquo;s supported-file list has one web entry, Notion URLs, and
            does not include .html, while HTMLRadar keeps the page as a page and reports which
            sections each recipient read.
          </DirectAnswer>
          <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
            Papermark is a real open-source project with a real team behind it, and on most measures
            it is the broader product. We are not going to pretend otherwise. The difference that
            matters is narrow and specific: what the two of us do with a web page.
          </p>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What happens when you upload an HTML file
            </h2>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-paper-2/40 p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  In Papermark
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  Papermark&rsquo;s help centre lists the file types it supports: PDF, spreadsheets,
                  presentations including Keynote, Word, images, CAD, ZIP, video, audio, Outlook
                  .msg files and Google Earth files. Under &ldquo;Web Content&rdquo; there is one
                  entry, Notion URLs. Neither .html nor .htm is on the list, so an HTML deck has no
                  route in unless you convert it to something else first.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  In HTMLRadar
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  You drop the .html file in, or paste a URL you already host. Fonts, layout, links
                  and interactions all still work for the recipient. Each recipient gets their own
                  link, and the report tells you which headings or slides they read and for how
                  long.
                </p>
              </div>
            </div>
            <p className="mt-5 text-[16px] leading-relaxed text-ink-soft">
              If the document you actually hold is a PDF, you do not have to choose yet.{' '}
              <Link href="/convert" className="text-signal-dark hover:underline">
                Convert a PDF deck into a single HTML page for free in your browser
              </Link>{' '}
              — no account needed to convert and download — and see whether the HTML version is the
              one you would rather send.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Side by side
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-graphite">
              Papermark column checked against papermark.com, its help centre and the
              papermark/papermark repository on {CHECKED}. Papermark lists prices in euros and
              dollars; the euro prices are the ones its pricing page shows by default and the ones
              quoted here.
            </p>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">Feature</th>
                    <th className="px-5 py-3">HTMLRadar</th>
                    <th className="px-5 py-3">Papermark</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ROWS.map(([feature, htmlradar, papermark]) => (
                    <tr key={feature}>
                      <td className="px-5 py-3.5 align-top text-ink">{feature}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{htmlradar}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{papermark}</td>
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
              Prices as published on {CHECKED}, billed monthly. Papermark lists a free plan at €0
              with 50 links, 50 documents and one team member; Pro at €24 a month with unlimited
              links and custom branding; Business at €59 a month with three team members, a custom
              domain for documents and multi-file sharing; and Data Rooms at €99 a month with three
              team members, unlimited data rooms, NDA agreements and dynamic watermarking. Paying
              yearly is advertised as saving up to 35 per cent, and the Data Rooms plan offers a
              seven-day free trial.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar is $15 a month or $150 a year for unlimited tracked links, with no per-seat
              charge, and a free plan of two tracked links carrying the same section-level analytics
              as Pro. A{' '}
              <Link href="/custom-domains" className="text-signal-dark hover:underline">
                custom domain for your tracked links
              </Link>{' '}
              is included in Pro at no extra charge — one CNAME record, and then
              decks.yourcompany.com/r/acme-proposal instead of htmlradar.page. The full breakdown is
              on the{' '}
              <Link href="/pricing" className="text-signal-dark hover:underline">
                HTMLRadar pricing page
              </Link>
              .
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              Read plainly: Papermark&rsquo;s free plan is much larger than ours, and if 50 free
              links is what decides it for you, take them. Where HTMLRadar comes out ahead on price
              is the paid tier, because a custom domain sits in Pro at $15 rather than on a €59
              plan.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Open source, on both sides
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              Both products are open source, and the difference is in the fine print rather than in
              the headline. Papermark&rsquo;s LICENSE file puts the repository under AGPLv3 with one
              carve-out: everything under its <code>ee</code> and <code>app/(ee)</code> directories
              carries a separate commercial licence. Its pricing page also lists the self-hosted
              option, and support for self-hosting, as Enterprise lines.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar is AGPL-3.0 across the whole repository — tracker, proxy worker, schema and
              web app — with no separately licensed directory, and the self-hosting guide is in the
              repository for anyone who wants to run it in their own Cloudflare and Supabase
              accounts. Whether that matters depends entirely on what you intend to do with the
              code.{' '}
              <Link href="/self-hosted" className="text-signal-dark hover:underline">
                See how self-hosted document tracking works
              </Link>
              .
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When to use each product
            </h2>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  Use HTMLRadar
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  You already send HTML. You want to keep it as HTML, create per-recipient links,
                  and see which headings or slides held attention. You want one flat price with no
                  per-seat charge, and a custom domain without moving up two tiers.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper-2/40 p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  Use Papermark
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  Your documents are PDFs or office files, you need a data room with granular file
                  permissions and NDA agreements, you have a team to add, or you want the largest
                  free plan of the two. Papermark covers all of that and HTMLRadar covers none of
                  it.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When not to choose HTMLRadar
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar has a narrow job and there are cases where it is the wrong tool. Do not
              choose it if you need a data room, granular per-file permissions, NDA agreements,
              dynamic watermarking, screenshot protection or single sign-on: Papermark lists all of
              those and HTMLRadar has none of them. Do not choose it if your source of truth is a
              PDF or an office file that will never become a web page, because attachments ride
              along under a tracked link but the section-level reading data is for HTML. And if the
              deciding factor is how much you get for nothing, Papermark&rsquo;s 50 free links beat
              our 2 and we are not going to argue the point.
            </p>
          </section>

          <Faq items={FAQ} />

          <section className="mt-14">
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Track an HTML deck free
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
              <Link href="/compare/docsend" className="text-signal-dark hover:underline">
                HTMLRadar vs DocSend
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
              <Link href="/tools" className="text-signal-dark hover:underline">
                free tools for turning HTML into a link
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
              <Link href="/self-hosted" className="text-signal-dark hover:underline">
                self-hosted document tracking
              </Link>
              , and{' '}
              <Link href="/use-case/track-html-deck" className="text-signal-dark hover:underline">
                track an HTML deck
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
