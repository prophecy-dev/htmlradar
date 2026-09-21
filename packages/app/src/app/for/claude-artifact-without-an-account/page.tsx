// One question, one page: "how do I share a Claude artifact with someone who
// does not have a Claude account?" The answer turned out to be genuinely
// conditional in September 2026 — Anthropic now has two sharing mechanisms
// with opposite answers — so the page leads with the fork rather than a flat
// yes or no. Source sentences for every claim are in
// docs/workstreams/seo-and-indexing/ARTIFACT-PAGES-EVIDENCE-2026-09-21.md.

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
  title: 'Share a Claude Artifact Without an Account | HTMLRadar',
  description:
    'Whether your reader needs a Claude account depends on how the artifact was shared. Both rules, and the export route that works for anyone.',
  path: '/for/claude-artifact-without-an-account',
});

const ANTHROPIC_SHARE_DOC =
  'https://support.claude.com/en/articles/9547008-publish-and-share-artifacts';
const ANTHROPIC_ARTIFACTS_DOC =
  'https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them';
const ANTHROPIC_INVITE_DOC =
  'https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact';

const FAQ = [
  {
    q: 'Does someone need a Claude account to open an artifact I share?',
    a: 'It depends which mechanism you used. For an artifact published from chat, Anthropic states that non-users can view and interact with it without signing up. For an artifact shared from the Share dialog — which covers the new Claude experience, Claude Design, Claude Slides, Claude Docs and Claude Code — Anthropic states that a Claude account is required and that people without one cannot open it even if they have the link.',
  },
  {
    q: 'How do I tell which kind of artifact I have?',
    a: 'Look for a Publish button. Anthropic documents publishing as available on Free, Pro and Max plans for artifacts made in chat on the previous experience, and says that publishing, embed codes and copying an artifact code are available only for artifacts made in chat. If you see a Share dialog with access levels instead, your viewer will need an account.',
  },
  {
    q: 'What is the way that always works, whatever the artifact is?',
    a: 'Export the artifact as an HTML file and host it somewhere that does not ask for a sign-in. Anthropic documents viewing the underlying code, copying it, and downloading files to use outside the conversation. Uploading that file to HTMLRadar gives you a link that opens in any browser with no account on either side.',
  },
  {
    q: 'Will an exported artifact still work outside Claude?',
    a: 'A self-contained HTML page will. An artifact that uses Claude to answer questions will not, because Anthropic documents that those apps run on its infrastructure and that users authenticate with their own Claude account. The same applies to artifacts that read connected tools through MCP, and to persistent storage, which Anthropic says is only available for published artifacts.',
  },
];

export default function ClaudeArtifactWithoutAnAccountPage() {
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
                name: 'Share a Claude artifact without an account',
                url: '/for/claude-artifact-without-an-account',
              },
            ]}
          />
          <SectionMark>HTMLRadar · Claude artifacts</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            Sharing a Claude artifact with someone who has no Claude account.
          </h1>
          <DirectAnswer updated="September 2026">
            Sometimes they can open it and sometimes they cannot, and which one you get depends on
            how the artifact was shared rather than on who you sent it to. An artifact published
            from chat opens for anyone; an artifact shared from the Share dialog requires every
            viewer to sign in to Claude.
          </DirectAnswer>

          <section className="mt-10">
            <p className="max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              This is the detail that catches people out, so it is worth reading Anthropic&apos;s
              own wording. Its{' '}
              <a
                href={ANTHROPIC_SHARE_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                page on publishing and sharing artifacts
              </a>{' '}
              splits artifacts into two groups by where they were made, and gives them opposite
              rules. Checked 21 September 2026.
            </p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">How it was shared</th>
                    <th className="px-5 py-3">Can a non-user open it?</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  <tr>
                    <td className="px-5 py-3.5 align-top text-ink">
                      Published from chat, with the Publish button
                      <span className="mt-1 block text-[13px] text-graphite">
                        Free, Pro and Max plans, previous chat experience
                      </span>
                    </td>
                    <td className="px-5 py-3.5 align-top text-ink-soft">
                      Yes. Anthropic says non-users can &ldquo;view and interact with any published
                      artifact without signing up&rdquo; and are prompted to sign up only for
                      advanced features such as AI-powered capabilities.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 align-top text-ink">
                      Shared from the Share dialog
                      <span className="mt-1 block text-[13px] text-graphite">
                        The new Claude experience, Claude Design, Slides, Docs and Claude Code
                      </span>
                    </td>
                    <td className="px-5 py-3.5 align-top text-ink-soft">
                      No. Anthropic says a Claude account is required, and that people without one
                      &ldquo;can&apos;t open or interact with a shared artifact, even if they have
                      the link&rdquo;.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 align-top text-ink">
                      Invited by e-mail address
                      <span className="mt-1 block text-[13px] text-graphite">
                        Beta, on Pro, Max, Team and Enterprise
                      </span>
                    </td>
                    <td className="px-5 py-3.5 align-top text-ink-soft">
                      No.{' '}
                      <a
                        href={ANTHROPIC_INVITE_DOC}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-signal-dark hover:underline"
                      >
                        Anthropic says
                      </a>{' '}
                      the person needs a Claude account with the address you invited, and must
                      create one first if they do not have it.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Two things to know before you send either kind
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              First, a shared chat artifact brings the conversation&apos;s files with it. Anthropic
              writes that viewers &ldquo;also get access to any attachments and files in the
              conversation that created it&rdquo;, and advises thinking about that before sharing
              from a conversation with sensitive documents in it.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              Second, your reader may not see what you see. Anthropic documents that viewers use
              their own access: an artifact that pulls from connected apps uses the viewer&apos;s
              connections, not yours, and shows an error where they lack access. A client with no
              Claude account has no connections at all.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              The route that works regardless
            </h2>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-[16px] leading-relaxed text-ink-soft">
              <li>
                In the artifact window, view the underlying code and download the file.{' '}
                <a
                  href={ANTHROPIC_ARTIFACTS_DOC}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-signal-dark hover:underline"
                >
                  Anthropic documents both
                </a>
                , and lists single-page HTML websites among the things artifacts commonly are.
              </li>
              <li>
                Check it is one self-contained file &mdash; styles, scripts and images inline, or
                assets at absolute URLs.
              </li>
              <li>
                Upload it to HTMLRadar and send the link. It opens in any browser, on any device,
                with no account on the recipient&apos;s side and nothing to install.
              </li>
            </ol>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Where HTMLRadar helps, and where it does not
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              It helps with the ordinary case: a deck, a proposal, a report or a one-pager that
              Claude wrote as a page. You get a link with no sign-in wall, and because it is your
              link rather than Anthropic&apos;s, it also tells you who opened it, which sections
              they read and how long they stayed &mdash; which a published artifact does not report.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              It does not help when the artifact is only interesting because it is running inside
              Claude. Anything that asks Claude questions, reads a connected tool, or saves data
              between visits needs Anthropic&apos;s infrastructure and a signed-in viewer. Exporting
              the HTML gives you the shell without the behaviour, so leave those where they are and
              accept that your reader will need an account.
            </p>
          </section>

          <Faq items={FAQ} />

          <section className="mt-14">
            <Link
              href="/tools/claude-artifact-to-link"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Turn the artifact into an open link
            </Link>
            <p className="mt-3 text-[13px] text-graphite">
              First 2 tracked links free. No account needed on the recipient&apos;s side, ever.
            </p>
          </section>

          <div className="mt-20 border-t border-line pt-10">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              Related:{' '}
              <Link href="/for/claude-artifact-expiry" className="text-signal-dark hover:underline">
                whether Claude artifacts expire
              </Link>
              ,{' '}
              <Link
                href="/for/claude-artifact-access-control"
                className="text-signal-dark hover:underline"
              >
                putting a password or an expiry date on one
              </Link>
              , and{' '}
              <Link href="/tools" className="text-signal-dark hover:underline">
                the rest of the AI-made HTML cluster
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
