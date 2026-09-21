// Link unfurls: the Open Graph card a pasted link shows in Slack, Telegram,
// LinkedIn, iMessage and the rest, and the crawlers that fetch it.
//
// WHAT A CARD MAY SAY. Only what the sender set for it: the document title,
// `documents.og_description`, and the image at `og_image_r2_key` (served at
// /r/{slug}/og-image). Never text from the document body — on a gated share
// that would leak exactly what the gate protects.
//
// WHAT AN UNFURL BOT GETS. A page with the card and nothing else: no document,
// no tracker, no session, no alert. A preview fetch is not a read, and a
// sender's "first open" alert firing because Slack unfurled the link is the
// fake open gtm asked us to filter out.

import { escapeHtml } from './escape.js';

// Substrings of the User-Agent each preview crawler sends. Case-insensitive.
// "WhatsApp" covers its link-preview fetcher; "Googlebot" and "Applebot" also
// cover their image and news variants; Slack-ImgProxy fetches og:image.
export const UNFURL_BOTS = [
  'Slackbot',
  'Slack-ImgProxy',
  'TelegramBot',
  'Twitterbot',
  'facebookexternalhit',
  'Discordbot',
  'redditbot',
  'LinkedInBot',
  'WhatsApp',
  'Applebot',
  'Googlebot',
  'SkypeUriPreview',
] as const;

const BOT_RE = new RegExp(UNFURL_BOTS.map((b) => b.replace(/[-]/g, '\\-')).join('|'), 'i');

export const isUnfurlBot = (ua: string | null): boolean => !!ua && BOT_RE.test(ua);

export interface OgCard {
  title: string;
  description: string;
  /** Absolute URL of the card image, or null to omit og:image entirely. */
  image: string | null;
  /** Absolute URL of the link itself. */
  url: string;
  siteName: string;
}

const DEFAULT_DESCRIPTION = 'A document has been shared with you. Open to view.';

/** The card for a share, from the columns the sender controls and nothing else. */
export function cardFor(
  share: {
    slug: string;
    document_title: string | null;
    document_og_description: string | null;
    document_og_image_r2_key: string | null;
  },
  origin: string,
  siteName: string,
): OgCard {
  return {
    title: share.document_title?.trim() || 'Shared document',
    description: share.document_og_description?.trim() || DEFAULT_DESCRIPTION,
    image: share.document_og_image_r2_key ? `${origin}/r/${share.slug}/og-image` : null,
    url: `${origin}/r/${share.slug}`,
    siteName,
  };
}

/** A generic card for pages that belong to no share (not found, privacy). */
export const genericCard = (origin: string, siteName: string): OgCard => ({
  title: 'Shared document',
  description: DEFAULT_DESCRIPTION,
  image: null,
  url: origin,
  siteName,
});

/** The <meta> tags for a card. */
export function ogMeta(c: OgCard): string {
  const e = escapeHtml;
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${e(c.siteName)}">`,
    `<meta property="og:title" content="${e(c.title)}">`,
    `<meta property="og:description" content="${e(c.description)}">`,
    ...(c.url ? [`<meta property="og:url" content="${e(c.url)}">`] : []),
    ...(c.image
      ? [
          `<meta property="og:image" content="${e(c.image)}">`,
          `<meta name="twitter:image" content="${e(c.image)}">`,
        ]
      : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(c.title)}">`,
    `<meta name="twitter:description" content="${e(c.description)}">`,
  ].join('\n');
}

/** What an unfurl bot is served: the card, a title, and no document. */
export function ogOnlyPage(c: OgCard): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(c.title)}</title>
<meta name="description" content="${escapeHtml(c.description)}">
${ogMeta(c)}
<meta name="robots" content="noindex, nofollow">
</head>
<body><h1>${escapeHtml(c.title)}</h1><p>${escapeHtml(c.description)}</p></body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short: a sender who changes the card should see it on the next paste.
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
