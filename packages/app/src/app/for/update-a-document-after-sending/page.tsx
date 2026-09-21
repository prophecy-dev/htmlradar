// /for/update-a-document-after-sending — the guide for the one thing an
// HTML document can do that a sent PDF cannot: change after it has gone out.
//
// Every statement about HTMLRadar's behaviour here was read out of the code
// in this repository on 21 September 2026, not from memory:
//   - the dashboard flow: (app)/docs/[id]/ReplaceDocumentButton.tsx and
//     replaceDocumentAction in (app)/docs/[id]/actions.ts
//   - the API: api/v1/documents/[id]/replace/route.ts
//   - the connector tool: packages/mcp/src/server.ts, `replace_document`
//   - what happens to reading data: sessions.document_version in
//     schema/001_init.sql, and the section aggregation in
//     (app)/docs/[id]/v2/page.tsx, which keys on the normalised section
//     TITLE rather than the DOM id — that is why a renamed heading starts a
//     new line in the chart, and it is the least obvious fact on this page.
// If you change a claim here, read those files again first.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { V2Footer } from '@/components/V2Footer';
import { SectionMark } from '@/components/SectionMark';
import { DirectAnswer } from '@/components/DirectAnswer';
import { BreadcrumbLd } from '@/components/JsonLd';
import { Faq } from '@/components/Faq';
import { pageMeta } from '@/lib/seo';

export const runtime = 'edge';

export const metadata = pageMeta({
  title: 'Update a Document After You Have Sent It | HTMLRadar',
  description:
    'Replace the contents behind a link you already sent. The address, its settings and the reading history stay put. What changes, what does not, the limits.',
  path: '/for/update-a-document-after-sending',
});

const FAQ = [
  {
    q: 'Can I update a document after I have already sent the link?',
    a: 'Yes. Replace the file on the document page in HTMLRadar and every link you have already sent serves the new contents the next time it is opened. The address does not change, the password, e-mail gate, expiry date and allow-list on each link do not change, and you do not have to send anybody a second link.',
  },
  {
    q: 'Does replacing a document break the link I already sent?',
    a: 'No. Replacing changes what the document points at; it does not touch the links. Each link keeps its slug, its recipient label and every setting it had, and the reading history recorded against it stays where it is. The HTTP API even says so in its reply, which carries links_unchanged: true.',
  },
  {
    q: 'What happens to the reading data I already collected?',
    a: 'It stays, all of it. Nothing is deleted when you replace a document, and every reading session records which version of the document that reader actually saw, so a session from before the change is still attributable to the version that was live at the time.',
  },
  {
    q: 'Does HTMLRadar keep old versions of a document?',
    a: 'It keeps a record of them. Every replace appends a row to the document version history with the version number, the file size, the time, and the filename when the file came through the browser. The "v" chip on the document page opens that list, with the version being served now marked Current. There is no button that restores an earlier version, so if you may want to go back, keep the earlier file yourself.',
  },
  {
    q: 'Can I edit the text of a document inside HTMLRadar?',
    a: 'No. HTMLRadar has no editor. You change the HTML wherever you wrote it — your editor, Claude, whatever produced the page — and upload the new file to replace the old one. What HTMLRadar guarantees is that the swap is invisible to the links you have already sent.',
  },
  {
    q: 'Can I replace a document I shared as a URL rather than a file?',
    a: 'No, and there would be nothing to replace. A document added by pasting a URL you host is served from your address, so it updates when you update the page at that address. Replacing is for documents whose HTML file HTMLRadar is storing.',
  },
];

export default function UpdateAfterSendingPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'Tools', url: '/tools' },
              {
                name: 'Update a document after sending it',
                url: '/for/update-a-document-after-sending',
              },
            ]}
          />
          <SectionMark>HTMLRadar · Guide</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            Updating a document after you have sent it.
          </h1>
          <DirectAnswer updated="September 2026">
            Replace the file on the document page and every link you have already sent serves the
            new contents the next time it is opened. The address stays the same, the password,
            e-mail gate, expiry date and allow-list on each link stay the same, and the reading you
            have already collected stays where it is. Nobody has to be sent a second link, and
            nobody has to be told to ignore the first one.
          </DirectAnswer>

          <section className="mt-10">
            <p className="max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              This is the one thing an HTML document can do that a PDF in somebody&rsquo;s inbox
              cannot. Once an attachment has gone out, the only fix is a second e-mail, and a second
              e-mail is an admission. A tracked link is an address you still control, so the fix is
              silent: you change what is behind it.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Three ways to do it
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
              All three do exactly the same thing. They differ only in where you are standing when
              you decide to fix something.
            </p>
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  In the dashboard
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  Open the document and press{' '}
                  <strong className="font-medium text-ink">Replace HTML</strong>. A file picker
                  opens straight away; choose the corrected file and it uploads. It accepts .html
                  and .htm files up to 30 MB. Re-selecting a file with the same name as last time
                  works — a common way to lose an afternoon in other tools.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  From Claude, or any assistant on the connector
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  Ask it to update the document and it calls the{' '}
                  <code className="font-mono text-[13.5px]">replace_document</code> tool with the
                  new markup. This is the loop the connector exists for: read who stopped where,
                  rewrite that part, put it behind the same links. The{' '}
                  <Link href="/mcp" className="text-signal-dark hover:underline">
                    connector page
                  </Link>{' '}
                  lists all seven tools.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-paper p-6">
                <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal-dark">
                  Over the API
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
                  <code className="font-mono text-[13.5px]">
                    POST /api/v1/documents/&#123;id&#125;/replace
                  </code>{' '}
                  with the full markup in an <code className="font-mono text-[13.5px]">html</code>{' '}
                  field. It answers with the new version number and{' '}
                  <code className="font-mono text-[13.5px]">links_unchanged: true</code>. The{' '}
                  <Link href="/docs/api" className="text-signal-dark hover:underline">
                    API reference
                  </Link>{' '}
                  has the rest.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What changes, and what does not
            </h2>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">After a replace</th>
                    <th className="px-5 py-3">What happens</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    [
                      'The link address',
                      'Unchanged. Every slug you have sent stays exactly as it was, including a name you chose yourself and a custom domain if you use one.',
                    ],
                    [
                      'Link settings',
                      'Unchanged. Password, e-mail gate, expiry date, allow-list, recipient label and download permission are properties of the link, and replacing does not touch them.',
                    ],
                    [
                      'When the reader sees it',
                      'On their next open. A page already open in somebody’s browser keeps showing what it loaded until they reload it.',
                    ],
                    [
                      'Reading already recorded',
                      'Kept, in full. Nothing is deleted, and each session stores the version number the reader actually saw.',
                    ],
                    [
                      'The version number',
                      'Goes up by one, and a row is added to the version history: number, size, time, who did it, and the filename when it came through the browser.',
                    ],
                    [
                      'The old file',
                      'Left in storage but no longer served. There is no route that serves a previous version to anybody.',
                    ],
                    [
                      'Attachments on the document',
                      'Untouched. Replacing swaps the HTML page, not the files riding along with it.',
                    ],
                  ].map(([what, happens]) => (
                    <tr key={what}>
                      <td className="px-5 py-3.5 align-top text-ink">{what}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{happens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What happens to the section names
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              This is the part worth understanding before you rewrite a heading, because it is the
              one place a replace can make an old reading report look different.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar measures reading against the headings in your page, and the document-level
              chart adds up that time by the heading&rsquo;s text, not by its position in the page
              or by any identifier in the markup. So a section that keeps its heading across
              versions stays one line in the chart, and the time readers of version one and version
              four spent on it accumulates together. That is what you want: &ldquo;Spend &amp;
              results&rdquo; should be one row whether it was the third section in March or the
              second in April.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              Rename a heading and you get a second line instead. The old name keeps the time it
              already had and the new name starts at zero, because nothing in the page tells us the
              two are the same section. Sections with no heading at all fall back to their
              identifier in the markup, which can change between exports, so give the parts of a
              document you care about real headings and leave them alone.
            </p>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              The limits, stated plainly
            </h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-[16px] leading-[1.7] text-ink-soft">
              <li>
                <strong className="font-medium text-ink">There is no editor.</strong> HTMLRadar does
                not let you change words inside the browser. You edit the page wherever you wrote it
                and upload the whole file again.
              </li>
              <li>
                <strong className="font-medium text-ink">
                  It is the whole document, every time.
                </strong>{' '}
                There is no partial update. The markup you supply becomes the document.
              </li>
              <li>
                <strong className="font-medium text-ink">
                  History is a record, not a rollback.
                </strong>{' '}
                Every version is listed, and no version can be restored with a click. Going back
                means uploading the earlier file again as a new version, so keep it.
              </li>
              <li>
                <strong className="font-medium text-ink">Uploaded documents only.</strong> A
                document you added by pasting a URL you host has nothing to replace; it changes when
                you change the page at that address.
              </li>
              <li>
                <strong className="font-medium text-ink">Size.</strong> 30 MB through the dashboard,
                5 MB through the API and the connector, and HTML only in all three.
              </li>
              <li>
                <strong className="font-medium text-ink">Two replaces at once.</strong> Through the
                API or the connector, if a second replace lands while the first is still in flight,
                one of them wins and the other is told it lost rather than quietly overwriting the
                winner.
              </li>
              <li>
                <strong className="font-medium text-ink">
                  Replacing is screened like any upload.
                </strong>{' '}
                Swapping new contents behind a link people already trust is exactly the move the
                phishing screen exists for, so the new file is checked the same way the first one
                was.
              </li>
              <li>
                <strong className="font-medium text-ink">
                  It does not un-read what was already read.
                </strong>{' '}
                Anybody who opened the link before you fixed it saw the old version. The dashboard
                records when each person opened, so you can see who read it before the change.
              </li>
            </ul>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              When to replace, and when to send a new link
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              Replace when it is the same document: a typo, a wrong number, a section rewritten
              because the reading report showed four people stopping at it, next month&rsquo;s
              edition of a report the same client receives every month. The client keeps one address
              all year and you keep one running record of their reading.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              Create a new document instead when it is a different document that happens to look
              similar — a proposal for another client, a deck for another round. Reading data is
              attached to the document, and two unrelated pieces of work sharing one record make
              both harder to read.
            </p>
          </section>

          <Faq items={FAQ} />

          <section className="mt-14">
            <Link
              href="/tools/html-to-link"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Turn an HTML file into a tracked link
            </Link>
            <p className="mt-3 text-[13px] text-graphite">
              First 2 tracked links free. No credit card. Replacing a document is on the free plan
              too.
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
              <Link href="/for/claude-artifacts" className="text-signal-dark hover:underline">
                the Claude artifact tracking workflow
              </Link>
              ,{' '}
              <Link href="/mcp" className="text-signal-dark hover:underline">
                the HTMLRadar connector for Claude
              </Link>
              , and{' '}
              <Link href="/docs/api" className="text-signal-dark hover:underline">
                the HTTP API reference
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
