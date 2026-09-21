import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendVerificationCode } from '../src/mail.js';
import type { Env } from '../src/env.js';

// The code message. Mocked away in verified-gate.test.ts, which is about what
// the READER sees; this is about what leaves the worker.
//
// The one rule worth a test of its own is decision 3: the message carries no
// link that opens the document, because corporate mail security opens every
// link in a message before the human does. A future edit that adds a helpful
// "open the document" button would sail through every other test in this
// package and quietly undo the reason the gate uses a number at all.

const env = (over: Partial<Env> = {}) =>
  ({
    RESEND_API_KEY: 'test-key',
    RESEND_FROM: 'HTMLRadar <hello@htmlradar.com>',
    ...over,
  }) as unknown as Env;

const mail = {
  to: 'buyer@example.test',
  code: '314159',
  documentTitle: 'The Q3 Proposal',
  sender: 'Dana Sender',
  host: 'decks.acme.test',
};

function capture(status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe('the verification code message', () => {
  it('carries no link at all', async () => {
    const spy = capture();
    await sendVerificationCode(env(), mail);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.text).not.toMatch(/https?:\/\//);
    expect(body.html).not.toMatch(/<a\b/i);
    expect(body.html).not.toMatch(/https?:\/\//);
    // And nothing that loads on open, which is the other half of "plain".
    expect(body.html).not.toMatch(/<img\b/i);
  });

  it('names the document, the sender and the host the reader is on', async () => {
    const spy = capture();
    await sendVerificationCode(env(), mail);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.subject).toContain('The Q3 Proposal');
    expect(body.text).toContain('Dana Sender');
    // Item G: a custom domain names itself, so the message does not read like
    // a forgery to somebody looking at decks.acme.test in their address bar.
    expect(body.text).toContain('decks.acme.test');
    expect(body.text).toContain('314159');
    expect(body.html).toContain('314159');
    expect(body.to).toEqual(['buyer@example.test']);
  });

  it('escapes what it is given, so a document title cannot inject markup', async () => {
    const spy = capture();
    await sendVerificationCode(env(), { ...mail, documentTitle: '<img src=x onerror=1>' });
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.html).not.toContain('<img src=x');
    expect(body.html).toContain('&lt;img');
  });

  it('falls back to the address the product already sends from', async () => {
    const spy = capture();
    // Only RESEND_API_KEY is genuinely required; forgetting RESEND_FROM must
    // send from the right place rather than not send at all.
    await sendVerificationCode(env({ RESEND_FROM: undefined }), mail);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.from).toBe('HTMLRadar <hello@htmlradar.com>');
  });

  it('reports failure rather than throwing', async () => {
    expect(await sendVerificationCode(env({ RESEND_API_KEY: undefined }), mail)).toBe(false);
    capture(429);
    expect(await sendVerificationCode(env(), mail)).toBe(false);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    expect(await sendVerificationCode(env(), mail)).toBe(false);
  });

  it('sends nowhere when there is no credential', async () => {
    const spy = capture();
    await sendVerificationCode(env({ RESEND_API_KEY: undefined }), mail);
    expect(spy).not.toHaveBeenCalled();
  });
});
