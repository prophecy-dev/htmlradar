import { escapeHtml } from './escape.js';
import { genericCard, ogMeta, type OgCard } from './og.js';

// Recipient-facing HTML shells served by the proxy: the gate forms (email,
// password), the error states (revoked, expired, not found, source
// unreachable) and the privacy notice. Every recipient's first impression
// of a shared link — care over chrome.
//
// Design intent:
//   - Warm cream paper + oxblood accent + Fraunces serif headline.
//     Matches the v2 palette in `packages/app/tailwind.config.ts`.
//   - Editorial, not enterprise. The reader is a real person who just
//     received a deck from someone they know; the shell should feel like
//     receiving a well-typeset letter, not signing into a SaaS portal.
//   - Inline CSS so every response is one round-trip. Fraunces is loaded
//     from Google Fonts via <link rel=preconnect> + swap so the layout
//     doesn't shift when it lands.
//   - Mobile-first. Most recipients open links on phone first.
//   - prefers-reduced-motion respected.
//
// Constraints kept from the prior shell:
//   - All forms still POST to /r/{slug}/{auth|email} (proxy gate handlers
//     unchanged).
//   - HTTP status codes preserved (200 on first render, 401 on form error,
//     403 revoked, 404 not found, 410 expired, 502 source-unreachable).
//   - Output Content-Type stays text/html; charset=utf-8.
//
// OG meta tags. Every shell starts with a generic card between two markers;
// a gate page for a real share swaps in that share's card with withCard, so a
// link pasted into Slack unfurls with the title the sender chose even when
// the link is gated. Never recipient names, never document body text.

const FONTS_LINK = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&display=swap" rel="stylesheet">
`.trim();

const OG_START = '<!--og-->';
const OG_END = '<!--/og-->';
const ogBlock = (card: OgCard): string => `${OG_START}\n${ogMeta(card)}\n${OG_END}`;

/**
 * Swaps the generic card on a shell for `card`. Only this module's shells carry
 * the markers, so on anything else this returns the response unchanged.
 */
export async function withCard(res: Response, card: OgCard): Promise<Response> {
  const html = await res.text();
  const start = html.indexOf(OG_START);
  const end = html.indexOf(OG_END);
  const out =
    start >= 0 && end > start
      ? html.slice(0, start) + ogBlock(card) + html.slice(end + OG_END.length)
      : html;
  return new Response(out, { status: res.status, headers: res.headers });
}

/** Where the source is, as the AGPL asks. */
const SOURCE_URL = 'https://github.com/prophecy-dev/htmlradar';

const STYLES = `
:root {
  --paper: #FBF1E8;
  --paper-2: #F4E1CB;
  --paper-3: #EDD5BD;
  --ink: #1F1108;
  --ink-soft: #3A2818;
  --graphite: #876959;
  --signal: #7A1F2E;
  --signal-dark: #5A1521;
  --signal-soft: #D9B5B0;
  --line: #E8D5BD;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  background: var(--paper);
  background-image: radial-gradient(rgba(31, 17, 8, 0.04) 1px, transparent 1px);
  background-size: 24px 24px;
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  display: flex;
  flex-direction: column;
}
.frame {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-width: 460px;
  width: 100%;
  margin: 0 auto;
  padding: 32px 28px 56px;
}
.card {
  margin-top: 18vh;
  margin-bottom: auto;
}
@media (max-height: 640px) { .card { margin-top: 28px; } }
.kicker {
  font: 500 11px/1 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--graphite);
  margin: 0 0 14px;
}
h1 {
  font-family: "Fraunces", "Charter", "Iowan Old Style", Georgia, serif;
  font-weight: 400;
  font-size: 38px;
  line-height: 1.08;
  letter-spacing: -0.022em;
  color: var(--ink);
  margin: 0 0 14px;
}
p.lede {
  margin: 0 0 28px;
  font-size: 15.5px;
  line-height: 1.55;
  color: var(--ink-soft);
}
form { margin: 0; }
/* "text" is here for the verification code field, and leaving it out was a
   real defect rather than a cosmetic one: an input this block does not match
   gets the browser's default styling, which on iOS Safari means a font size
   under 16px — the threshold that zooms the viewport on focus and makes the
   page look broken at the exact moment the reader is typing. It also missed
   the border, the padding and the focus ring every other field here has. */
input[type="email"], input[type="password"], input[type="text"], select, textarea {
  width: 100%;
  font: inherit;
  /* 16px is the iOS Safari zoom-on-focus threshold. Anything smaller
     triggers a viewport zoom when the field is focused, shifting the
     layout and looking broken. Keep this at 16px on every breakpoint. */
  font-size: 16px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  border-radius: 8px;
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
input::placeholder, textarea::placeholder { color: rgba(135, 105, 89, 0.7); }
input:focus, select:focus, textarea:focus {
  border-color: var(--signal);
  box-shadow: 0 0 0 3px rgba(122, 31, 46, 0.10);
}
textarea { min-height: 96px; resize: vertical; margin-top: 12px; }
label {
  display: block;
  margin: 0 2px 8px;
  font: 500 11px/1 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--graphite);
}
/* The privacy line under each gate. Quiet, but always there. */
.report {
  margin-top: 26px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--graphite);
}
.report a { color: inherit; text-decoration: none; border-bottom: 1px dotted rgba(135, 105, 89, 0.6); }
.report a:hover { color: var(--signal); border-bottom-color: var(--signal); }
input.invalid {
  border-color: var(--signal-dark);
  box-shadow: 0 0 0 3px rgba(90, 21, 33, 0.12);
}
.error {
  min-height: 18px;
  margin: 10px 2px 0;
  font: 500 13px/1.4 inherit;
  color: var(--signal-dark);
}
button {
  width: 100%;
  margin-top: 16px;
  font: 500 15px/1 inherit;
  padding: 14px 16px;
  background: var(--signal);
  color: var(--paper);
  border: 1px solid var(--signal);
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 120ms ease, transform 120ms ease;
  letter-spacing: 0.005em;
}
button:hover { background: var(--signal-dark); border-color: var(--signal-dark); }
button:active { transform: translateY(0.5px); }
.notice {
  margin-top: 8px;
  padding: 14px 16px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: rgba(244, 225, 203, 0.35);
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink-soft);
}
.footer {
  margin-top: 56px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  font: 500 11px/1.5 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--graphite);
  display: flex;
  flex-wrap: wrap;
  gap: 14px 22px;
  justify-content: space-between;
}
.footer a { color: inherit; text-decoration: none; border-bottom: 1px dotted rgba(135, 105, 89, 0.6); }
.footer a:hover { color: var(--signal); border-bottom-color: var(--signal); }
@media (max-width: 480px) {
  .frame { padding: 24px 20px 40px; }
  h1 { font-size: 32px; }
  .card { margin-top: 8vh; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();

const SHELL = (title: string, body: string, status: number, kicker?: string): Response =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${ogBlock(genericCard('', 'Shared document'))}
<meta name="robots" content="noindex, nofollow">
${FONTS_LINK}
<style>${STYLES}</style>
</head>
<body>
<div class="frame">
  <main class="card">
    ${kicker ? `<p class="kicker">${escapeHtml(kicker)}</p>` : ''}
    ${body}
  </main>
  <footer class="footer">
    <a href="/privacy">Privacy</a>
    <a href="${SOURCE_URL}" rel="noopener">Source · AGPL-3.0</a>
  </footer>
</div>
</body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Explicit no-cache. Without this, 410 (expired) and 404 (not
        // found) are heuristically cacheable per RFC 7234 — browsers
        // AND Cloudflare's edge cache them by default. When the sender
        // extends an expiry or unrevokes a share, the recipient hits
        // their own cached error page and concludes "still expired".
        // Same reasoning applies to the gate forms —
        // a stale cached form would carry an old CSRF posture and
        // confuse error-state rendering. no-store covers both.
        'Cache-Control': 'private, no-store, max-age=0',
        // STRICT-ORIGIN, AND NEVER no-referrer. Item E of the verified-gate
        // brief, and the reason is the outage of 21 September 2026: a page
        // served `Referrer-Policy: no-referrer` posts with a literal
        // `Origin: null`, which refused every real sign-in. These pages are
        // sandboxed into an opaque origin, so they post with `Origin: null`
        // whatever this header says — but naming the safe policy here is what
        // stops somebody "tightening" it to no-referrer later and rediscovering
        // that morning. Nothing on these pages needs a full referrer, and
        // strict-origin sends none at all when the destination is not HTTPS.
        'Referrer-Policy': 'strict-origin',
      },
    },
  );

// Common footer for all error shells. The fix is almost always on the
// sender's side, so the recipient is pointed there.
const ERROR_FOOTER = `
<div style="margin-top:32px;padding-top:24px;border-top:1px dashed var(--line);">
  <p style="margin:0 0 14px 0;font-size:13.5px;line-height:1.55;color:var(--graphite);">
    Need a fresh link? Reply to the person who sent this to you — they can
    update or re-send in a few seconds.
  </p>
</div>
`.trim();

export const notFound = (): Response =>
  SHELL(
    'Share not found',
    `<h1>This link doesn't open anything.</h1>
     <p class="lede">It may have been deleted, or it never existed. The person who sent it to you can confirm — and re-share if needed.</p>
     ${ERROR_FOOTER}`,
    404,
    'No record',
  );

export const revoked = (): Response =>
  SHELL(
    'Access revoked',
    `<h1>The sender turned this link off.</h1>
     <p class="lede">It's a pause, not a delete — the sender can switch it back on at any time. If you still need to read the document, reply to them.</p>
     ${ERROR_FOOTER}`,
    403,
    'Revoked by sender',
  );

export const expired = (): Response =>
  SHELL(
    'Link expired',
    `<h1>This link's window has closed.</h1>
     <p class="lede">The sender set an expiry on this share and it's past. Ask them to extend the expiry or send a fresh link — either takes a second.</p>
     ${ERROR_FOOTER}`,
    410,
    'Past expiry',
  );

export const sourceUnreachable = (): Response =>
  SHELL(
    'Document unavailable',
    `<h1>The document didn't load.</h1>
     <p class="lede">The sender's source didn't respond just now. Try again in a moment — it usually clears up on its own. If it doesn't, reach out to them directly.</p>
     ${ERROR_FOOTER}`,
    502,
    'Source error',
  );

/**
 * The privacy notice at /privacy: what a link records, for whom, and how to
 * get it removed. EU recipients are owed this before they are tracked, which
 * is why every gate and every served document links here.
 */
export const privacyPage = (opts: { brand: string; contact: string | null }): Response => {
  const brand = escapeHtml(opts.brand);
  const contact = opts.contact
    ? /^https?:\/\//i.test(opts.contact)
      ? `<a href="${escapeHtml(opts.contact)}" rel="noopener">${escapeHtml(opts.contact)}</a>`
      : /@/.test(opts.contact)
        ? `<a href="mailto:${escapeHtml(opts.contact)}">${escapeHtml(opts.contact)}</a>`
        : escapeHtml(opts.contact)
    : 'the person who sent you the link';
  return SHELL(
    'Privacy',
    `<h1>What this link records.</h1>
     <p class="lede">Links on this site are sent by the ${brand} team (Somnia). When you open one, the sender learns that it was read and how. This page says exactly what is kept.</p>
     <p class="lede"><strong>About you.</strong> Your email address if the link asked for one, otherwise a random identifier bound to this document; when you first and last opened it and how many times; your browser's identification string; the page that linked you here; your country and city (from the network, not your device); device type, operating system and browser.</p>
     <p class="lede"><strong>About each visit.</strong> Which version of the document you saw, when the visit started and last reported, the seconds you were actively reading, how far you scrolled, the time spent on each section or slide, and any attached files you downloaded.</p>
     <p class="lede"><strong>What is not recorded.</strong> Your IP address, cursor movements, keystrokes, screenshots or a replay of your visit. Link previews (Slack, Telegram, LinkedIn and similar) are not counted as reads.</p>
     <p class="lede"><strong>Who sees it.</strong> The ${brand} team member who sent the link, in an internal dashboard. It is not sold, not shared with advertisers and not used for marketing. The sender may get one alert, by email or Telegram, when you first start reading.</p>
     <p class="lede"><strong>How long.</strong> Until the sender deletes the document. To have your records removed sooner, or to ask what is held about you, contact ${contact}.</p>
     <p class="lede"><strong>Opting out.</strong> Add <code>?optout=1</code> to any link on this site and confirm; documents then open with no tracking in this browser.</p>`,
    200,
    'Privacy',
  );
};

// The privacy notice, linked under every gate so a recipient can see what is
// recorded before they type anything.
const privacyLink = (): string =>
  `<p class="report">This link is tracked. <a href="/privacy">What the sender sees</a></p>`;

export const passwordForm = (slug: string, error?: string): Response =>
  SHELL(
    error ? 'Incorrect password' : 'Enter password',
    `<h1>Locked.</h1>
     <p class="lede">Enter the password the sender shared with you to continue.</p>
     <form method="POST" action="/r/${escapeHtml(slug)}/auth" novalidate>
       <input
         type="password"
         name="password"
         placeholder="Password"
         autocomplete="current-password"
         required
         autofocus
         ${error ? 'class="invalid" aria-invalid="true"' : ''}
       />
       <div class="error" role="alert" aria-live="polite">${error ? escapeHtml(error) : ''}</div>
       <button type="submit">Continue</button>
     </form>
     ${privacyLink()}`,
    error ? 401 : 200,
    'Password required',
  );

// The read-tracking opt-out confirmation. `?optout=1|0` used to change the
// preference on the spot, which made a plain link — or the shared document's
// own script navigating its own tab — enough to flip it. So the GET now only
// asks, and this page's form is what writes: one button, POSTing back to the
// same address with a short-lived HMAC the GET minted (see auth.ts).
export const optOutConfirm = (
  slug: string,
  optout: '1' | '0',
  token: string,
  status = 200,
): Response =>
  SHELL(
    optout === '1' ? 'Turn off read tracking' : 'Turn read tracking back on',
    `<h1>${
      optout === '1'
        ? 'Turn off read tracking for links on this site in this browser?'
        : 'Turn read tracking back on?'
    }</h1>
     <p class="lede">${
       optout === '1'
         ? 'The sender will no longer see that you opened this document, how long you read, or which sections you spent time on. The document itself opens exactly as before. This applies to every link on this site you open in this browser.'
         : 'The sender will see that you opened their document, how long you read, and which sections you spent time on — the same as any link on this site. You can turn it off again at any time.'
     }</p>
     ${status === 200 ? '' : '<div class="error" role="alert">That confirmation expired. Press the button to confirm again.</div>'}
     <form method="POST" action="/r/${escapeHtml(slug)}">
       <input type="hidden" name="optout" value="${optout}">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <button type="submit">${optout === '1' ? 'Turn read tracking off' : 'Turn read tracking on'}</button>
     </form>`,
    status,
    'Read tracking',
  );

// `token` is present only on a link that asks for a verified address. It is
// signed over the challenge cookie this browser was just given, and the post is
// refused without it — see isOwnGatePost and issueGateToken in auth.ts for why
// the cookie alone was not a defence.
export const emailGateForm = (slug: string, error?: string, token?: string): Response =>
  SHELL(
    error ? 'Email error' : 'Enter your email',
    `<h1>View this document.</h1>
     <p class="lede">Enter your email to continue.</p>
     <form method="POST" action="/r/${escapeHtml(slug)}/email" novalidate>
       ${token ? `<input type="hidden" name="t" value="${escapeHtml(token)}">` : ''}
       <input
         type="email"
         name="email"
         placeholder="you@example.com"
         autocomplete="email"
         required
         autofocus
         ${error ? 'class="invalid" aria-invalid="true"' : ''}
       />
       <div class="error" role="alert" aria-live="polite">${error ? escapeHtml(error) : ''}</div>
       <p class="lede">Reading activity on this document is shared with the sender. <a href="/privacy">What is recorded</a></p>
       <button type="submit">Continue</button>
     </form>
     ${privacyLink()}`,
    error ? 401 : 200,
    'Email required',
  );

// THE SECOND STEP OF THE VERIFIED E-MAIL GATE, and the most carefully worded
// page in this file.
//
// IT IS THE SAME PAGE FOR EVERY OUTCOME, and that is the whole design. A
// permitted address, a non-permitted address, an address over its limit, a
// mail provider that refused us and a mail provider that never answered all
// end here, with this status and these words. There is no longer a
// send-failure page, because a page that only ever appeared on the permitted
// path was itself the answer to "is this address on the list?".
//
// WHICH IS WHY THE COPY CARRIES THE FAILURE CASE. A reader whose code is
// never coming — because our provider refused it — would otherwise sit staring
// at a form waiting for a message that will not arrive. "It can take a minute
// to arrive. If nothing comes, check the address and ask for another code"
// tells that person what to do without telling anybody anything: it is equally
// true and equally unremarkable for somebody who mistyped their address,
// somebody who is not on the list at all, and somebody whose code is simply
// slow.
//
// IT IS THE SAME PAGE FOR AN ADDRESS THE LINK PERMITS AND ONE IT DOES NOT.
// That is decision 2 of the brief and it is the whole anti-enumeration
// property: somebody who holds the link must not be able to use the gate to
// discover who is on the allow-list. Same words, same status code, same
// form — the only difference in the world is that a permitted address also
// receives a message, and that difference is in a mailbox we are not showing.
//
// So the sentence is conditional on purpose: "If that address can open this
// document, we have sent it a code." It promises nothing about an address we
// will not discuss, and it is honest to the person it is really for, who did
// get the code and is about to type it.
//
// THE FIELD. `one-time-code` is what lets iOS and Android offer the code from
// the notification, which is the difference between typing six digits and
// tapping once. `inputmode="numeric"` puts a phone on the number pad without
// making the field a `type="number"`, which would bring a spinner, strip
// leading zeroes and break paste. Six characters, `autofocus`, and nothing
// that interferes with pasting — a reader who copies the code out of their
// mail client lands on this field with it already in the clipboard.
//
// NO JAVASCRIPT, like every other page here. The form posts and the server
// answers; there is nothing to go wrong in a locked-down browser.
//
// The address travels in a hidden field rather than a second cookie. It is not
// a thing to protect: the code in the database is bound to the address, the
// link and the browser's challenge together, so a reader who edits this field
// is asking about a code that does not exist and is told the code is wrong.
export const verifyCodeForm = (
  slug: string,
  email: string,
  token: string,
  error?: string,
  status = 200,
): Response =>
  SHELL(
    error ? 'Check your code' : 'Enter your code',
    `<h1>Check your email.</h1>
     <p class="lede">If that address can open this document, we have sent it a six-digit code. It works for ten minutes. It can take a minute to arrive. If nothing comes, check the address and ask for another code.</p>
     <form method="POST" action="/r/${escapeHtml(slug)}/verify" novalidate>
       <input type="hidden" name="email" value="${escapeHtml(email)}">
       <input type="hidden" name="t" value="${escapeHtml(token)}">
       <label for="code">Six-digit code</label>
       <input
         id="code"
         type="text"
         name="code"
         inputmode="numeric"
         autocomplete="one-time-code"
         maxlength="6"
         placeholder="000000"
         style="letter-spacing:0.38em;font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace"
         required
         autofocus
         ${error ? 'class="invalid" aria-invalid="true"' : ''}
       />
       <div class="error" role="alert" aria-live="polite">${error ? escapeHtml(error) : ''}</div>
       <button type="submit">Open the document</button>
     </form>
     <p class="report"><a href="/r/${escapeHtml(slug)}">Use a different address</a></p>
     ${privacyLink()}`,
    status,
    'Code required',
  );
