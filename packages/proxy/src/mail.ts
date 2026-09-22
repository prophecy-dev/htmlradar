// Outgoing messages: the verified gate's code, and the two alerts to the
// sender — the first read, and a comment a verified reader left (e-mail, plus
// Telegram when the sender has a chat id and the bot token is set). E-mail
// goes through the Cloudflare Email Service binding `EMAIL`.
//
// THE CODE MESSAGE CARRIES NO LINK THAT OPENS THE DOCUMENT. Corporate mail
// scanners open every link in a message before the human does; a six-digit
// number a person types cannot be spent by a machine that follows links.
// No tracking pixel and no marketing in anything sent to a recipient.

import type { Env } from './env.js';
import type { CommentAlert, FirstReadAlert } from './store.js';
import { recordNotification } from './store.js';
import { escapeHtml } from './escape.js';

const DEFAULT_FROM = 'docs@hive.land';
export const brandOf = (env: Env): string => env.BRAND_NAME || 'Hivemarket';

interface Outgoing {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** True only when the binding accepted the message. Never throws. */
export async function sendMail(env: Env, m: Outgoing): Promise<boolean> {
  if (!env.EMAIL) return false;
  try {
    await env.EMAIL.send({
      to: m.to,
      from: { email: env.MAIL_FROM || DEFAULT_FROM, name: brandOf(env) },
      subject: m.subject,
      html: m.html,
      text: m.text,
    });
    return true;
  } catch (err) {
    console.error('mail send failed', err instanceof Error ? err.message : err);
    return false;
  }
}

// ---------------------------------------------------------------- the code

export interface CodeMail {
  to: string;
  code: string;
  documentTitle: string;
  /** The owner's display name, or their address. */
  sender: string;
  /** The hostname this reader is on. */
  host: string;
}

export async function sendVerificationCode(env: Env, mail: CodeMail): Promise<boolean> {
  const subject = `Your code for ${mail.documentTitle}`;
  return sendMail(env, {
    to: mail.to,
    subject,
    text: codeText(mail),
    html: layout(
      subject,
      `<p style="${P}">${escapeHtml(mail.sender)} shared &ldquo;${escapeHtml(mail.documentTitle)}&rdquo; with you on ${escapeHtml(mail.host)}.</p>
       <div style="font-family:ui-monospace,Menlo,monospace;font-size:34px;letter-spacing:0.22em;font-weight:600;margin:0 0 20px;">${escapeHtml(mail.code)}</div>
       <p style="${P}">It works for ten minutes, once.</p>
       <p style="${MUTED}">If you were not expecting this, ignore it. Nothing opens without the code.</p>`,
    ),
  });
}

// Both parts say the same thing in the same order. The code is on its own line
// with nothing beside it, which is what makes it selectable on a phone.
const codeText = (m: CodeMail): string =>
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

// ---------------------------------------------------------------- first read

/** Who read it, in one line: "anna@acme.com (Berlin, DE · desktop)". */
export function readerLine(a: FirstReadAlert): string {
  const who = a.viewerEmail ?? a.recipientLabel ?? 'Someone with the link';
  const where = [a.viewerCity, a.viewerCountry].filter(Boolean).join(', ');
  const extra = [where, a.viewerDevice].filter(Boolean).join(' · ');
  return extra ? `${who} (${extra})` : who;
}

/** Where the sender goes to see the whole picture. Null when no dashboard is configured. */
const dashboardLink = (env: Env, documentId: string): string | null =>
  env.APP_ORIGIN ? `${env.APP_ORIGIN.replace(/\/+$/, '')}/docs/${documentId}` : null;

export function firstReadMessage(env: Env, a: FirstReadAlert): Outgoing & { telegram: string } {
  const who = readerLine(a);
  const label = a.recipientLabel && a.viewerEmail ? ` — link for ${a.recipientLabel}` : '';
  const dashboard = dashboardLink(env, a.documentId);
  const subject = `${a.viewerEmail ?? a.recipientLabel ?? 'Someone'} is reading ${a.documentTitle}`;
  const text = [
    `${who} started reading "${a.documentTitle}"${label}.`,
    a.referrer ? `Came from: ${a.referrer}` : '',
    '',
    dashboard ? `Time per slide and return visits: ${dashboard}` : '',
  ]
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
  const html = layout(
    subject,
    `<p style="${P}"><strong>${escapeHtml(who)}</strong> started reading &ldquo;${escapeHtml(a.documentTitle)}&rdquo;${escapeHtml(label)}.</p>
     ${a.referrer ? `<p style="${MUTED}">Came from: ${escapeHtml(a.referrer)}</p>` : ''}
     ${dashboard ? `<p style="${P}"><a href="${escapeHtml(dashboard)}" style="color:#7A1F2E;">Time per slide and return visits &rarr;</a></p>` : ''}
     <p style="${MUTED}">Sent once per reader per document. Turn it off per link in the dashboard.</p>`,
  );
  const telegram = [`📖 ${who} started reading "${a.documentTitle}"${label}.`, dashboard ?? '']
    .filter(Boolean)
    .join('\n');
  return { to: a.ownerEmail, subject, text, html, telegram };
}

export async function sendTelegram(env: Env, chatId: string, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sends one alert to the sender on every configured channel and logs each
 * attempt to notifications_log under `kind`. Runs inside ctx.waitUntil; never
 * throws. E-mail is attempted even while Email Sending is off on the account —
 * the binding is absent, the send is logged 'failed' with the reason, and
 * Telegram is what actually reaches the sender today.
 */
async function sendOwnerAlert(
  env: Env,
  alert: {
    sessionId: string;
    ownerEmail: string;
    telegramChatId: string | null;
  },
  kind: 'first_read' | 'comment',
  msg: Outgoing & { telegram: string },
): Promise<void> {
  const jobs: Promise<void>[] = [
    (async () => {
      const ok = await sendMail(env, msg);
      await recordNotification(
        env,
        alert.sessionId,
        'email',
        alert.ownerEmail,
        ok ? 'delivered' : 'failed',
        ok ? null : env.EMAIL ? 'send refused' : 'no EMAIL binding',
        kind,
      );
    })(),
  ];
  if (alert.telegramChatId && env.TELEGRAM_BOT_TOKEN) {
    const chatId = alert.telegramChatId;
    jobs.push(
      (async () => {
        const ok = await sendTelegram(env, chatId, msg.telegram);
        await recordNotification(
          env,
          alert.sessionId,
          'telegram',
          chatId,
          ok ? 'delivered' : 'failed',
          ok ? null : 'telegram refused',
          kind,
        );
      })(),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.error(`${kind} alert log failed`, r.reason);
  }
}

export const sendFirstReadAlert = (env: Env, alert: FirstReadAlert): Promise<void> =>
  sendOwnerAlert(env, alert, 'first_read', firstReadMessage(env, alert));

// ---------------------------------------------------------------- a comment

/** Enough of a note to answer from the phone; the rest is one click away. */
const COMMENT_PREVIEW_CHARS = 400;

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

export function commentMessage(env: Env, c: CommentAlert): Outgoing & { telegram: string } {
  // The section is what makes a comment actionable — "the pricing slide" is a
  // different message from "the deck" — so it leads wherever there is one.
  const about = c.sectionTitle ? `on ${c.sectionTitle}` : 'on the whole document';
  const dashboard = dashboardLink(env, c.documentId);
  const body = truncate(c.body, COMMENT_PREVIEW_CHARS);
  const subject = `${c.viewerEmail} commented on ${c.documentTitle}`;
  const text = [
    `${c.viewerEmail} left a comment ${about} in "${c.documentTitle}".`,
    '',
    body,
    '',
    dashboard ? `Every comment on this document: ${dashboard}` : '',
  ]
    .join('\n')
    .trim();
  const html = layout(
    subject,
    `<p style="${P}"><strong>${escapeHtml(c.viewerEmail)}</strong> left a comment ${escapeHtml(about)} in &ldquo;${escapeHtml(c.documentTitle)}&rdquo;.</p>
     <blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #E8D5BD;font-size:15px;line-height:1.55;color:#3A2818;white-space:pre-wrap;">${escapeHtml(body)}</blockquote>
     ${dashboard ? `<p style="${P}"><a href="${escapeHtml(dashboard)}" style="color:#7A1F2E;">Every comment on this document &rarr;</a></p>` : ''}
     <p style="${MUTED}">Only readers who confirmed this address with a code can comment.</p>`,
  );
  const telegram = [
    `💬 ${c.viewerEmail} commented ${about} in "${c.documentTitle}":`,
    body,
    dashboard ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  return { to: c.ownerEmail, subject, text, html, telegram };
}

export const sendCommentAlert = (env: Env, alert: CommentAlert): Promise<void> =>
  sendOwnerAlert(env, alert, 'comment', commentMessage(env, alert));

// ---------------------------------------------------------------- layout

const P = 'margin:0 0 16px;font-size:15px;line-height:1.55;color:#3A2818;';
const MUTED =
  'margin:20px 0 0;padding-top:16px;border-top:1px solid #E8D5BD;font-size:13px;line-height:1.55;color:#876959;';

const layout = (title: string, inner: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#FBF1E8;font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,'Segoe UI',Roboto,sans-serif;color:#1F1108;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FBF1E8;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="440" style="max-width:440px;">
      <tr><td style="padding:0 8px;">${inner}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
