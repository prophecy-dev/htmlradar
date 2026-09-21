// One question, one page: "do Claude artifacts expire, and how long does a
// shared link last?" Everything said here about Claude's behaviour is logged
// with its source sentence in
// docs/workstreams/seo-and-indexing/ARTIFACT-PAGES-EVIDENCE-2026-09-21.md.
// The load-bearing honesty: Anthropic documents no expiry on a published
// link, so this page says that rather than inventing a number. The nearest
// siblings are /for/claude-artifact-access-control (how to put an expiry on
// one yourself) and /for/claude-artifact-without-an-account.

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
  title: 'Do Claude Artifacts Expire? | HTMLRadar',
  description:
    'Anthropic sets no expiry date on an artifact link. What actually ends access: unpublishing, unsharing, an org setting or a retention policy.',
  path: '/for/claude-artifact-expiry',
});

const ANTHROPIC_SHARE_DOC =
  'https://support.claude.com/en/articles/9547008-publish-and-share-artifacts';
const ANTHROPIC_INVITE_DOC =
  'https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact';
const ANTHROPIC_RETENTION_DOC =
  'https://support.claude.com/en/articles/10440198-configure-custom-data-retention-controls-for-enterprise-plans';

const FAQ = [
  {
    q: 'Do Claude artifacts expire?',
    a: 'Not on a timer that Anthropic documents. A published or shared artifact stays reachable until you unpublish or unshare it, delete it, or an organisation setting removes it. The one documented exception is an Enterprise organisation with a custom data retention period, where standalone chats and the artifacts inside them are deleted when that period ends.',
  },
  {
    q: 'How long does a shared Claude artifact link last?',
    a: 'Anthropic publishes no lifetime for it. The help centre describes how to end access — an Unpublish button, an Unshare option, and the Enterprise External sharing toggle — but never a date on which a working link stops working by itself.',
  },
  {
    q: 'Can I un-share a Claude artifact after I have sent the link?',
    a: 'Yes. Anthropic documents an Unpublish button for artifacts published from chat and an Unshare option in the Share dialog. Unpublishing is one-way: Anthropic states that once you unpublish an artifact you cannot publish that same artifact again, and that any persistent storage it used is permanently deleted.',
  },
  {
    q: 'Does anything in Claude expire after 30 days?',
    a: 'One thing does, and it is not the link. Anthropic documents that a pending email invitation to an artifact expires after 30 days, while an accepted invitation does not expire. Separately, 30 days is the shortest custom data retention period an Enterprise organisation can set.',
  },
];

export default function ClaudeArtifactExpiryPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'Tools', url: '/tools' },
              { name: 'Do Claude artifacts expire?', url: '/for/claude-artifact-expiry' },
            ]}
          />
          <SectionMark>HTMLRadar · Claude artifacts</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            Do Claude artifacts expire?
          </h1>
          <DirectAnswer updated="September 2026">
            No — Anthropic sets no expiry date on an artifact link, and publishes no lifetime for
            one. A shared or published artifact stays reachable until you unpublish or unshare it,
            delete it, or an organisation setting takes it away, which means the link you sent last
            year is probably still open today.
          </DirectAnswer>

          <section className="mt-10">
            <p className="max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              That is worth saying carefully, because &ldquo;it does not expire&rdquo; is a claim
              about documentation rather than about physics. Anthropic&apos;s{' '}
              <a
                href={ANTHROPIC_SHARE_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                help centre page on publishing and sharing artifacts
              </a>{' '}
              is the page that lists every sharing setting, and it describes several ways access can
              end. None of them is a date. Read on 21 September 2026.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What does end access, according to Anthropic
            </h2>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">What happens</th>
                    <th className="px-5 py-3">What Anthropic documents</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    [
                      'You unpublish a chat artifact',
                      'An Unpublish button appears after publishing and revokes access. It is one-way: Anthropic says you cannot publish that same artifact again, and that persistent storage it used is permanently deleted.',
                    ],
                    [
                      'You unshare from the Share dialog',
                      'The Share dialog offers an Unshare option in the Artifact shared modal.',
                    ],
                    [
                      'An Enterprise owner turns off External sharing',
                      'Anthropic states that existing public links stop working until it is turned back on.',
                    ],
                    ['You delete the artifact', 'Everyone you invited loses access.'],
                    [
                      'An Enterprise retention period ends',
                      'Standalone chats and any artifacts inside them are deleted. The shortest period an owner can set is 30 days, and the default is to keep data indefinitely.',
                    ],
                  ].map(([event, documented]) => (
                    <tr key={event}>
                      <td className="px-5 py-3.5 align-top text-ink">{event}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{documented}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
              The retention rule is{' '}
              <a
                href={ANTHROPIC_RETENTION_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                documented for Enterprise plans only
              </a>
              . On Free, Pro and Max there is no equivalent setting in the documentation, so nothing
              removes an artifact on a schedule.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              The one thing that really does expire in 30 days
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              If you invited someone to an artifact by e-mail rather than sending them a link,
              Anthropic{' '}
              <a
                href={ANTHROPIC_INVITE_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                documents that pending invitations expire after 30 days
              </a>
              , while accepted invitations do not expire. So the invitation has a clock on it and
              the access it grants does not. That is the opposite of what most people want when they
              ask whether an artifact expires.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Why &ldquo;it never expires&rdquo; is a problem, not a feature
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              A permanent link is fine for a demo you want the world to keep. It is less fine for a
              proposal, a pricing sheet or a board update. The version you sent in March is still
              the version someone can open in November, and your only lever is unpublishing &mdash;
              which, for a chat artifact, you cannot undo. There is no middle setting between
              &ldquo;open forever&rdquo; and &ldquo;gone for good&rdquo;.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Where HTMLRadar helps, and where it does not
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              HTMLRadar does not change anything inside Claude. It gives you a second route for the
              cases above: download the artifact as an HTML file, upload it, and send an HTMLRadar
              link instead. That link carries an expiry date you choose, and revoking it is
              reversible in the sense that you can always create another link for the same document.
              You can also replace the file behind a link you have already sent, so the recipient
              gets the current version rather than March&apos;s.
            </p>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              Where it does not help: if the artifact needs Claude to run &mdash; an AI-powered app,
              one that reads your connected tools, or one that keeps stored data &mdash; then
              Anthropic runs it on its own infrastructure and an exported HTML file will not carry
              that behaviour with it. Keep those in Claude. HTMLRadar is for the self-contained
              page.
            </p>
          </section>

          <Faq items={FAQ} />

          <section className="mt-14">
            <Link
              href="/tools/claude-artifact-to-link"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Give a Claude artifact an expiry date
            </Link>
            <p className="mt-3 text-[13px] text-graphite">
              First 2 tracked links free. Expiry, password and revoke are on the free plan too.
            </p>
          </section>

          <div className="mt-20 border-t border-line pt-10">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              Related:{' '}
              <Link
                href="/for/claude-artifact-access-control"
                className="text-signal-dark hover:underline"
              >
                putting a password or an expiry date on a Claude artifact
              </Link>
              ,{' '}
              <Link
                href="/for/claude-artifact-without-an-account"
                className="text-signal-dark hover:underline"
              >
                sharing one with someone who has no Claude account
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
