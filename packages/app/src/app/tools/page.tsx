// /tools index. The four free tools, one line each, plus the rest of the
// "AI-made HTML to a tracked link" cluster. Exists so "Tools" in the header
// and footer has a single target instead of pointing at one of the three
// tools and hoping the visitor finds the other two, and so every page in
// that cluster has one hub to link back to.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { V2Footer } from '@/components/V2Footer';
import { BreadcrumbLd } from '@/components/JsonLd';
import { SectionMark } from '@/components/SectionMark';
import { pageMeta } from '@/lib/seo';

export const runtime = 'edge';

export const metadata = pageMeta({
  title: 'Free Tools | HTMLRadar',
  description:
    'Free tools from HTMLRadar: turn an HTML file into a shareable link, share a Claude artifact as a link, save a Claude artifact as a PDF, or turn a PDF deck into a web page.',
  path: '/tools',
});

// The rest of the "AI-made HTML to a tracked link" cluster. Kept separate
// from TOOLS because these are guides and references, not browser tools.
const GUIDES = [
  {
    href: '/for/claude-artifacts',
    title: 'Track a Claude artifact',
    description:
      'What happens after you send an artifact, and how a tracked link answers whether it was read.',
  },
  {
    href: '/for/claude-artifact-expiry',
    title: 'Do Claude artifacts expire?',
    description:
      'What Anthropic documents about how long a shared artifact link lasts, and what actually ends access.',
  },
  {
    href: '/for/claude-artifact-without-an-account',
    title: 'Share an artifact with someone who has no Claude account',
    description:
      'Whether your reader needs an account depends on how the artifact was shared. Both rules, and the route that always works.',
  },
  {
    href: '/for/claude-artifact-access-control',
    title: 'Password or expiry on a Claude artifact',
    description:
      'Claude offers audience levels, not a password or a date. What it does offer, and how to add a real gate.',
  },
  {
    href: '/for/update-a-document-after-sending',
    title: 'Update a document after you have sent it',
    description:
      'Replace the contents behind a link you already sent. What stays the same, what does not, and the limits.',
  },
  {
    href: '/for/claude-code',
    title: 'HTMLRadar for Claude Code',
    description: 'Share the HTML that Claude Code writes, straight from the terminal session.',
  },
  {
    href: '/mcp',
    title: 'The HTMLRadar MCP server',
    description: 'Connect Claude to HTMLRadar so it can create and check tracked links for you.',
  },
  {
    href: '/blog/share-html-from-claude-code',
    title: 'Share a page from Claude Code, then ask who read it',
    description: 'A walkthrough, from the file Claude wrote to the reading report.',
  },
];

const TOOLS = [
  {
    href: '/tools/html-to-link',
    title: 'HTML file to link',
    description: 'Drop an HTML file, preview it, and get a link that shows who opened it.',
  },
  {
    href: '/tools/claude-artifact-to-link',
    title: 'Claude artifact to link',
    description: 'Share a Claude artifact as a link that works without a Claude account.',
  },
  {
    href: '/tools/claude-artifact-to-pdf',
    title: 'Claude artifact to PDF',
    description: 'Save a Claude artifact as a PDF you can attach or print.',
  },
  {
    href: '/convert',
    title: 'PDF deck to web page',
    description: 'Convert a PDF deck into an HTML web page, free in your browser.',
  },
];

export default function ToolsIndexPage() {
  return (
    <>
      <NavBar />
      <main className="relative">
        <article className="mx-auto max-w-3xl px-6 pb-20 pt-28 md:pb-28 md:pt-32">
          <BreadcrumbLd
            items={[
              { name: 'Home', url: '/' },
              { name: 'Tools', url: '/tools' },
            ]}
          />
          <SectionMark>HTMLRadar · Free tools</SectionMark>
          <h1 className="text-letterpress mt-6 font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[56px]">
            Free tools.
          </h1>
          <p className="mt-6 max-w-lg text-[15.5px] leading-relaxed text-ink-soft">
            No account needed to start. Each one runs in your browser until you ask for a tracked
            link.
          </p>

          <ul className="mt-16 divide-y divide-line">
            {TOOLS.map((t) => (
              <li key={t.href} className="py-8 first:pt-0">
                <Link href={t.href} className="group block">
                  <h2 className="font-serif text-[28px] leading-snug text-ink transition group-hover:text-signal-dark md:text-[32px]">
                    {t.title}
                  </h2>
                  <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{t.description}</p>
                  <span className="link-slide mt-4 inline-flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.16em] text-signal-dark">
                    Open →
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <section className="mt-20 border-t border-line pt-10">
            <h2 className="font-serif text-[28px] leading-snug text-ink md:text-[32px]">
              Turning AI-made HTML into a tracked link
            </h2>
            <ul className="mt-8 divide-y divide-line">
              {GUIDES.map((g) => (
                <li key={g.href} className="py-6 first:pt-0">
                  <Link href={g.href} className="group block">
                    <h3 className="font-serif text-[21px] leading-snug text-ink transition group-hover:text-signal-dark md:text-[23px]">
                      {g.title}
                    </h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
                      {g.description}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </article>
      </main>
      <V2Footer />
    </>
  );
}
