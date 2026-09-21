import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import type { FirstReadAlert } from '../src/store.js';

// What leaves the worker: the code message (Cloudflare Email Service binding)
// and the first-read alert (e-mail plus Telegram), with every attempt logged.

const recordNotification = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/store.js')>('../src/store.js');
  return { ...actual, recordNotification: (...a: unknown[]) => recordNotification(...a) };
});

const { sendVerificationCode, sendFirstReadAlert, firstReadMessage } =
  await import('../src/mail.js');

type Sent = {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
};

function emailBinding(fail = false) {
  const sent: Sent[] = [];
  return {
    sent,
    binding: {
      send: vi.fn(async (m: Sent) => {
        if (fail) throw new Error('E_SENDER_NOT_VERIFIED');
        sent.push(m);
        return { messageId: 'm1' };
      }),
    },
  };
}

const env = (over: Partial<Env> = {}): Env =>
  ({ MAIL_FROM: 'docs@hive.land', BRAND_NAME: 'Hivemarket', ...over }) as unknown as Env;

const mail = {
  to: 'buyer@example.test',
  code: '314159',
  documentTitle: 'The Q3 Proposal',
  sender: 'Dana Sender',
  host: 'docs.hive.land',
};

const alert: FirstReadAlert = {
  sessionId: 'sess-1',
  documentId: 'doc-1',
  ownerEmail: 'sam@hive.land',
  ownerName: 'Sam',
  ownerTimezone: 'UTC',
  telegramChatId: '4242',
  documentTitle: 'AI sales deck',
  slug: 'acme',
  recipientLabel: 'Acme — CTO',
  viewerEmail: 'cto@acme.com',
  viewerCountry: 'DE',
  viewerCity: 'Berlin',
  viewerDevice: 'desktop',
  referrer: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  recordNotification.mockClear();
});

describe('the verification code message', () => {
  it('goes through the EMAIL binding from MAIL_FROM, in html and text', async () => {
    const { sent, binding } = emailBinding();
    expect(await sendVerificationCode(env({ EMAIL: binding }), mail)).toBe(true);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe('buyer@example.test');
    expect(m.from).toEqual({ email: 'docs@hive.land', name: 'Hivemarket' });
    expect(m.subject).toContain('The Q3 Proposal');
    expect(m.text).toContain('314159');
    expect(m.html).toContain('314159');
    expect(m.text).toContain('Dana Sender');
    expect(m.text).toContain('docs.hive.land');
  });

  // Corporate mail security opens every link in a message before the human
  // does; a number a person types cannot be spent by a link-following scanner.
  it('carries no link and nothing that loads on open', async () => {
    const { sent, binding } = emailBinding();
    await sendVerificationCode(env({ EMAIL: binding }), mail);
    const m = sent[0]!;
    expect(m.text).not.toMatch(/https?:\/\//);
    expect(m.html).not.toMatch(/<a\b/i);
    expect(m.html).not.toMatch(/https?:\/\//);
    expect(m.html).not.toMatch(/<img\b/i);
  });

  it('escapes what it is given, so a document title cannot inject markup', async () => {
    const { sent, binding } = emailBinding();
    await sendVerificationCode(env({ EMAIL: binding }), {
      ...mail,
      documentTitle: '<img src=x onerror=1>',
    });
    expect(sent[0]!.html).not.toContain('<img src=x');
    expect(sent[0]!.html).toContain('&lt;img');
  });

  it('reports failure rather than throwing', async () => {
    expect(await sendVerificationCode(env(), mail)).toBe(false);
    const { binding } = emailBinding(true);
    expect(await sendVerificationCode(env({ EMAIL: binding }), mail)).toBe(false);
  });
});

describe('the first-read alert', () => {
  it('names the reader, where they are, the document and the link it was sent on', () => {
    const m = firstReadMessage(env({ APP_ORIGIN: 'https://radar.example' }), alert);
    expect(m.to).toBe('sam@hive.land');
    expect(m.subject).toBe('cto@acme.com is reading AI sales deck');
    expect(m.text).toContain('cto@acme.com (Berlin, DE · desktop)');
    expect(m.text).toContain('link for Acme — CTO');
    expect(m.text).toContain('https://radar.example/docs/doc-1');
    expect(m.html).toContain('https://radar.example/docs/doc-1');
    expect(m.telegram).toContain('cto@acme.com');
  });

  it('carries no dashboard link when APP_ORIGIN is unset', () => {
    const m = firstReadMessage(env(), alert);
    expect(m.text).not.toMatch(/https?:\/\//);
  });

  it('sends e-mail and Telegram, and logs each as delivered', async () => {
    const { sent, binding } = emailBinding();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await sendFirstReadAlert(env({ EMAIL: binding, TELEGRAM_BOT_TOKEN: 'bot-token' }), alert);

    expect(sent).toHaveLength(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.telegram.org/botbot-token/sendMessage');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.chat_id).toBe('4242');
    expect(body.text).toContain('AI sales deck');

    const logged = recordNotification.mock.calls.map((c) => [c[2], c[3], c[4]]);
    expect(logged).toEqual(
      expect.arrayContaining([
        ['email', 'sam@hive.land', 'delivered'],
        ['telegram', '4242', 'delivered'],
      ]),
    );
  });

  it('skips Telegram without a bot token or a chat id, and logs a failed send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { binding } = emailBinding(true);
    await sendFirstReadAlert(env({ EMAIL: binding }), alert);
    await sendFirstReadAlert(env({ EMAIL: binding, TELEGRAM_BOT_TOKEN: 't' }), {
      ...alert,
      telegramChatId: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordNotification.mock.calls.map((c) => [c[2], c[4]])).toEqual([
      ['email', 'failed'],
      ['email', 'failed'],
    ]);
  });
});
