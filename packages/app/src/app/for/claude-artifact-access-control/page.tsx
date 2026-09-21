// One question, one page: "how do I put a password or an expiry date on a
// Claude artifact I share?" Claude's own options are audience levels, not
// gates — the word "password" appears nowhere in Anthropic's sharing
// documentation, so this page says that plainly instead of implying a hidden
// setting. Every Claude claim is logged with its source sentence in
// docs/workstreams/seo-and-indexing/ARTIFACT-PAGES-EVIDENCE-2026-09-21.md,
// and every HTMLRadar claim below is confirmed in the same file against
// lib/types.ts, docs/[id]/actions.ts, proxy/src/index.ts and PricingTiers.tsx.

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
  title: 'Password or Expiry on a Claude Artifact | HTMLRadar',
  description:
    'Claude offers audience levels, not a password or an expiry date. What its sharing settings actually do, and how to add a real gate by exporting the HTML.',
  path: '/for/claude-artifact-access-control',
});

const ANTHROPIC_SHARE_DOC =
  'https://support.claude.com/en/articles/9547008-publish-and-share-artifacts';
const ANTHROPIC_INVITE_DOC =
  'https://support.claude.com/en/articles/16989529-invite-people-outside-your-organization-to-an-artifact';

const FAQ = [
  {
    q: 'Can you password-protect a Claude artifact?',
    a: 'Not through Claude. Anthropic’s help centre page on publishing and sharing artifacts is the page that enumerates the sharing settings, and it lists audience levels and access levels only. There is no password, passcode or PIN field on a Claude artifact link, and Anthropic documents none.',
  },
  {
    q: 'Can you set an expiry date on a Claude artifact link?',
    a: 'No date setting is documented. The only expiry anywhere in Anthropic’s artifact documentation applies to pending email invitations, which expire after 30 days; accepted invitations do not expire, and links do not expire at all. Ending access means unpublishing or unsharing.',
  },
  {
    q: 'What access controls does Claude actually offer?',
    a: 'Audience: on Pro and Max plans, "Only you" or "Anyone with the link"; on Team and Enterprise plans, "Only people with access", "Everyone in your organization", or "Anyone with the link". Access level: view or edit for most artifacts, with comment as well for Claude Design and Claude Slides. Enterprise owners also control an organisation-wide External sharing toggle.',
  },
  {
    q: 'How do I put a password and an expiry on a Claude artifact with HTMLRadar?',
    a: 'Download the artifact as an HTML file, upload it to HTMLRadar, and set the options on the share link: a password of at least eight characters, an email gate, an allow-list of addresses or domains, and an expiry date after which the link stops opening. All four are on the free plan, which limits how many tracked links you create rather than which controls you can use.',
  },
];

export default function ClaudeArtifactAccessControlPage() {
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
                name: 'Password or expiry on a Claude artifact',
                url: '/for/claude-artifact-access-control',
              },
            ]}
          />
          <SectionMark>HTMLRadar · Claude artifacts</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            Putting a password or an expiry date on a Claude artifact.
          </h1>
          <DirectAnswer updated="September 2026">
            Claude has neither. Its sharing settings choose an audience &mdash; only you, your
            organisation, or anyone with the link &mdash; and an access level, and Anthropic
            documents no password field and no expiry date anywhere in them. To get either, you
            export the HTML and put it behind a link that has them.
          </DirectAnswer>

          <section className="mt-10">
            <p className="max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              That is a claim about documentation, which is the only kind of claim worth making
              here. Anthropic&apos;s{' '}
              <a
                href={ANTHROPIC_SHARE_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                page on publishing and sharing artifacts
              </a>{' '}
              is the page that enumerates the settings, and the word &ldquo;password&rdquo; does not
              appear on it. Nor does any date. Read on 21 September 2026.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              What Claude does offer
            </h2>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">Control</th>
                    <th className="px-5 py-3">What it does</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    [
                      'Audience, Pro and Max',
                      '“Only you” or “Anyone with the link”. Two settings, no middle ground.',
                    ],
                    [
                      'Audience, Team and Enterprise',
                      '“Only people with access”, “Everyone in your organization”, or “Anyone with the link”. The last one needs an Enterprise owner to turn on External sharing first.',
                    ],
                    [
                      'Access level',
                      'View or edit for most artifacts; view, comment or edit for Claude Design and Claude Slides; view or edit for Claude Docs.',
                    ],
                    [
                      'Invite by e-mail address',
                      'In beta on Pro, Max, Team and Enterprise. The closest thing to a per-person gate: an invitation works only for the person invited, who must sign in with that address. Up to 50 people per artifact.',
                    ],
                    [
                      'Allowed domains, on an embed',
                      'Lists the websites that may embed a published artifact. It governs embedding, not who can open the artifact’s own link.',
                    ],
                    [
                      'Version pinning',
                      'A link can show the latest version or one specific version. If you share the latest, viewers see your changes as you make them.',
                    ],
                  ].map(([control, effect]) => (
                    <tr key={control}>
                      <td className="px-5 py-3.5 align-top text-ink">{control}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
              The invitation route is documented{' '}
              <a
                href={ANTHROPIC_INVITE_DOC}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-dark hover:underline"
              >
                separately
              </a>
              . Worth knowing: a pending invitation expires after 30 days, an accepted one never
              does, and if the artifact is also shared with &ldquo;anyone with the link&rdquo; then
              the people you invited get the same access as everyone else regardless of the level
              you gave them.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Why that is a gap and not a preference
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              &ldquo;Anyone with the link&rdquo; is a reasonable default for a prototype. It is the
              wrong setting for a pricing page, a term sheet or a client report, because the link
              outlives the conversation: it gets forwarded, pasted into a thread, and opened by
              people you never picked. The other option is to require every reader to hold a Claude
              account, which your client probably does not. Between &ldquo;anyone&rdquo; and
              &ldquo;only Claude users&rdquo; there is nothing.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              The HTMLRadar route
            </h2>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-[16px] leading-relaxed text-ink-soft">
              <li>Download the artifact as a single, self-contained HTML file.</li>
              <li>
                Upload it to HTMLRadar, or ask Claude to publish it for you through the connector.
              </li>
              <li>
                Create the share link and set what it should ask for before it opens. Send that link
                instead of the artifact.
              </li>
            </ol>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-line bg-paper">
              <table className="w-full min-w-[560px] text-[14px]">
                <thead className="bg-paper-2/40 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                  <tr>
                    <th className="px-5 py-3">Per-link setting</th>
                    <th className="px-5 py-3">What the reader meets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    [
                      'Password',
                      'A prompt before the document renders. Minimum eight characters, stored hashed.',
                    ],
                    [
                      'Email gate',
                      'The reader gives an address before the document opens, and that address is attached to everything they read.',
                    ],
                    [
                      'Allow-list',
                      'Named addresses, or whole email domains, so only the client’s people get in.',
                    ],
                    [
                      'Expiry date',
                      'After the date you set, the link stops serving the document. Nothing to remember to switch off.',
                    ],
                    ['Revoke', 'Closes one link immediately, without touching the others.'],
                  ].map(([setting, effect]) => (
                    <tr key={setting}>
                      <td className="px-5 py-3.5 align-top text-ink">{setting}</td>
                      <td className="px-5 py-3.5 align-top text-ink-soft">{effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              All five are on the free plan. The free plan limits how many tracked links you create
              &mdash; two, for the lifetime of the account &mdash; not which controls you may put on
              them.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Where this does not help
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
              A password on an HTMLRadar link protects the copy HTMLRadar serves. It does nothing to
              the artifact still sitting in Claude, so if you already published that one, unpublish
              it or you have two doors and only one lock. And if the artifact needs Claude to run
              &mdash; it asks Claude questions, reads a connected tool, or keeps stored data &mdash;
              exporting the HTML gives you the page without the behaviour. Those belong in Claude,
              gated the way Claude gates them.
            </p>
          </section>

          <Faq items={FAQ} />

          <section className="mt-14">
            <Link
              href="/tools/claude-artifact-to-link"
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-medium text-paper shadow-[0_1px_0_rgba(31,17,8,0.15)] transition hover:bg-signal-dark"
            >
              Put a password on a Claude artifact
            </Link>
            <p className="mt-3 text-[13px] text-graphite">
              First 2 tracked links free. Password, email gate, allow-list and expiry included.
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
