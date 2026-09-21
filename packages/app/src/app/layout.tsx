import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Newsreader, JetBrains_Mono } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import './globals.css';

// Newsreader — variable serif for editorial headlines. Less ubiquitous
// than Fraunces in the SaaS-landing-page rotation, more newspaper than
// magazine. Optical-size axis gives us proper display + body shaping.
// Self-hosted via next/font (no CDN flicker, no privacy leak to Google
// Fonts at runtime).
const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-serif',
  axes: ['opsz'],
  display: 'swap',
});

// Geist — Vercel's contemporary grotesque. Used for body, UI, controls.
// Picked over Inter to step out of the SaaS-Inter monoculture without
// paying for a foundry license. Distributed via the `geist` npm package
// rather than Google Fonts (Next 14.2 predates Geist's google-fonts
// inclusion). The package self-hosts the font files, same as next/font.

// JetBrains Mono — kept for kickers, slugs, section marks. Pairs cleanly
// with both Newsreader and Geist.
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'HTMLRadar', template: '%s · HTMLRadar' },
  description: 'Somnia-internal read tracking for HTML decks and proposals.',
  applicationName: 'HTMLRadar',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${GeistSans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
