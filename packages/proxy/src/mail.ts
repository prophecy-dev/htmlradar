// The one e-mail this worker sends: the verified e-mail gate's code.
//
// PLAIN, AND WITH NO LINK THAT OPENS THE DOCUMENT (decision 3 and 8 of
// docs/workstreams/security/VERIFIED-EMAIL-GATE-BRIEF-2026-09-21.md). That is
// not a style preference, it is the lesson of 21 September 2026: corporate
// mail security opens every link in a message before the human does, and a
// Microsoft Defender scanner spent three of one customer's sign-in links
// thirteen to sixteen seconds after each was sent. A six-digit number a person
// types cannot be spent by a machine that follows links, and the machine that
// renders this message finds nothing in it to follow.
//
// No tracking pixel and no marketing, for the same reason the gate pages carry
// no third-party anything: this message goes to somebody who has no
// relationship with us and did not ask to hear from us.
//
// The HOST the reader is on is named in the body (item G), because a customer's
// own domain and a handle host are both addresses the reader may be looking at,
// and a code that names the wrong one reads like a phishing attempt.

import type { Env } from './env.js';
import { escapeHtml } from './escape.js';

const RESEND_DEFAULT_URL = 'https://api.resend.com/emails';

// The address the product already sends everything else from — the value of the
// `resend_from` Vault secret the first-open e-mail, the onboarding e-mail and
// the abuse notice all read (schema/049, 048, 037).
//
// It is a DEFAULT rather than a required secret so that the gate needs exactly
// one new credential and not two. A deploy that forgets RESEND_FROM sends from
// the right address anyway; a deploy that forgets RESEND_API_KEY cannot send at
// all, which is why that one is checked and refused in the workflow rather than
// defaulted here. Overriding it is for a self-hosted install or a change of
// sending address, and `wrangler secret put RESEND_FROM` is all that takes.
const RESEND_DEFAULT_FROM = 'HTMLRadar <hello@htmlradar.com>';

export interface CodeMail {
  to: string;
  code: string;
  documentTitle: string;
  /** The owner's display name, or their address, exactly as the product shows it elsewhere. */
  sender: string;
  /** The hostname this reader is on. */
  host: string;
}

/**
 * Sends the code. Returns true only when the provider accepted the message.
 *
 * Every failure is false and nothing else: no throw, and no distinction
 * between "no credential configured", "the provider said no" and "the request
 * never arrived". The reader is never told about any of them — since the send
 * was decoupled from the reply, they always see the same neutral page — and
 * the caller records the reason where the people who can fix it will see it.
 */
export async function sendVerificationCode(env: Env, mail: CodeMail): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;

  const subject = `Your code for ${mail.documentTitle}`;
  const body = {
    from: env.RESEND_FROM ?? RESEND_DEFAULT_FROM,
    to: [mail.to],
    subject,
    text: plainText(mail),
    html: html(mail, subject),
  };

  try {
    const res = await fetch(env.RESEND_API_URL ?? RESEND_DEFAULT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Both parts say the same thing in the same order, so a client that shows
// either one shows the whole message. The code is on its own line with nothing
// beside it, which is what makes it selectable on a phone.
const plainText = (m: CodeMail): string =>
  [
    `${m.sender} shared "${m.documentTitle}" with you on ${m.host}.`,
    '',
    'Your code is:',
    '',
    m.code,
    '',
    'It works for ten minutes, once.',
    '',
    'If you were not expecting this, ignore it. Nothing opens without the code.',
  ].join('\n');

const html = (m: CodeMail, subject: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#FBF1E8;font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,'Segoe UI',Roboto,sans-serif;color:#1F1108;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FBF1E8;">
  <tr><td align="center" style="padding:48px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="420" style="max-width:420px;">
      <tr><td style="padding:0 8px 28px 8px;">
        <span style="font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#5A1521;font-weight:600;">HTML<span style="color:#7A1F2E;font-style:italic;font-weight:500;">Radar</span></span>
      </td></tr>
      <tr><td style="padding:0 8px 20px 8px;font-size:15px;line-height:1.55;color:#3A2818;">
        ${escapeHtml(m.sender)} shared &ldquo;${escapeHtml(m.documentTitle)}&rdquo; with you on ${escapeHtml(m.host)}.
      </td></tr>
      <tr><td style="padding:0 8px 20px 8px;">
        <div style="font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:34px;letter-spacing:0.22em;color:#1F1108;font-weight:600;">${escapeHtml(m.code)}</div>
      </td></tr>
      <tr><td style="padding:0 8px 24px 8px;font-size:14px;line-height:1.55;color:#3A2818;">
        It works for ten minutes, once.
      </td></tr>
      <tr><td style="padding:20px 8px 0 8px;border-top:1px solid #E8D5BD;font-size:13px;line-height:1.55;color:#876959;">
        If you were not expecting this, ignore it. Nothing opens without the code.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
