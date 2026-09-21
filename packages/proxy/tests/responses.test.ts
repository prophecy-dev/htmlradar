import { describe, expect, it } from 'vitest';
import {
  notFound,
  revoked,
  expired,
  sourceUnreachable,
  emailGateForm,
  passwordForm,
  verifyCodeForm,
  privacyPage,
  withCard,
} from '../src/responses.js';

// Recipient-facing shells get rewritten relatively often (copy, colors,
// micro-affordances). These assertions lock in the Batch D contract so a
// future refactor can't silently drop the warm copy + "Reply to sender"
// affordance + the privacy link. They also guard against any
// HTTP code (403/404/410) accidentally leaking back into the visible
// body — the post-Batch-D rule is "no HTTP codes shown to recipients."

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

const HTTP_CODE_REGEX = /\b(401|403|404|410|418|500|502|503)\b/;

describe('recipient error shells (Batch D)', () => {
  describe('status codes preserved', () => {
    it('notFound returns 404', () => {
      expect(notFound().status).toBe(404);
    });
    it('revoked returns 403', () => {
      expect(revoked().status).toBe(403);
    });
    it('expired returns 410', () => {
      expect(expired().status).toBe(410);
    });
    it('sourceUnreachable returns 502', () => {
      expect(sourceUnreachable().status).toBe(502);
    });
  });

  describe('no HTTP codes in visible body', () => {
    it.each([
      ['notFound', notFound],
      ['revoked', revoked],
      ['expired', expired],
      ['sourceUnreachable', sourceUnreachable],
    ])('%s body has no HTTP status numbers', async (_name, fn) => {
      const body = await bodyOf(fn());
      // Strip <head> and any meta tags before matching — the body can
      // legitimately reference numeric IDs (font weights, RGB) we don't
      // care about. Look only at user-visible <main>/<h1>/<p> content.
      const visibleOnly = body.replace(/<head[\s\S]*?<\/head>/i, '');
      expect(visibleOnly).not.toMatch(HTTP_CODE_REGEX);
    });
  });

  describe('ERROR_FOOTER affordances on every error shell', () => {
    it.each([
      ['notFound', notFound],
      ['revoked', revoked],
      ['expired', expired],
      ['sourceUnreachable', sourceUnreachable],
    ])('%s includes "Reply to the person" cue', async (_name, fn) => {
      const body = await bodyOf(fn());
      expect(body).toContain('Reply to the person who sent this to you');
    });

    it.each([
      ['notFound', notFound],
      ['revoked', revoked],
      ['expired', expired],
      ['sourceUnreachable', sourceUnreachable],
    ])(
      '%s links the privacy notice and the source, and nothing of htmlradar.com',
      async (_name, fn) => {
        const body = await bodyOf(fn());
        expect(body).toContain('href="/privacy"');
        expect(body).toContain('https://github.com/prophecy-dev/htmlradar');
        expect(body).not.toContain('htmlradar.com');
        expect(body).not.toContain('What is HTMLRadar');
      },
    );
  });

  describe('warm-copy headlines (Batch D rewrite)', () => {
    it('notFound headline', async () => {
      expect(await bodyOf(notFound())).toContain("doesn't open anything");
    });
    it('revoked headline', async () => {
      expect(await bodyOf(revoked())).toContain('turned this link off');
    });
    it('expired headline', async () => {
      expect(await bodyOf(expired())).toContain("link's window has closed");
    });
    it('sourceUnreachable headline', async () => {
      expect(await bodyOf(sourceUnreachable())).toContain("document didn't load");
    });
  });

  describe('cache headers — error shells must not be edge-cached', () => {
    it.each([
      ['notFound', notFound],
      ['revoked', revoked],
      ['expired', expired],
      ['sourceUnreachable', sourceUnreachable],
    ])('%s sends no-store', (_name, fn) => {
      const cc = fn().headers.get('Cache-Control') ?? '';
      expect(cc).toMatch(/no-store/);
    });
  });

  describe('gate forms still work', () => {
    it('emailGateForm includes the POST target', async () => {
      expect(await bodyOf(emailGateForm('abc-123'))).toContain('action="/r/abc-123/email"');
    });
    it('passwordForm includes the POST target', async () => {
      expect(await bodyOf(passwordForm('xyz-789'))).toContain('action="/r/xyz-789/auth"');
    });
  });

  // Every gate links the privacy notice before the recipient types anything:
  // EU recipients are owed it before they are tracked.
  describe('the privacy link on every gate', () => {
    it.each([
      ['emailGateForm', () => emailGateForm('abc-123')],
      ['passwordForm', () => passwordForm('abc-123')],
      ['verifyCodeForm', () => verifyCodeForm('abc-123', 'a@b.co', 't')],
    ])('%s says the link is tracked and links /privacy', async (_name, fn) => {
      const body = await bodyOf(fn());
      expect(body).toContain('This link is tracked.');
      expect(body).toContain('<a href="/privacy">What the sender sees</a>');
      expect(body).not.toContain('/report');
    });
  });

  // The tracking disclosure belongs to the email gate alone: that is the one
  // screen where the recipient hands over an identity. The document itself is
  // built by fetch-html + inject and never passes through this module, so it
  // cannot pick the sentence up.
  describe('tracking disclosure on the email gate only', () => {
    const DISCLOSURE = 'Reading activity on this document is shared with the sender.';

    it('emailGateForm shows the disclosure and the privacy link', async () => {
      const body = await bodyOf(emailGateForm('abc-123'));
      expect(body).toContain(DISCLOSURE);
      expect(body).toContain('<a href="/privacy">What is recorded</a>');
    });

    it.each([
      ['passwordForm', () => passwordForm('xyz-789')],
      ['notFound', notFound],
      ['revoked', revoked],
      ['expired', expired],
      ['sourceUnreachable', sourceUnreachable],
    ])('%s does not show the disclosure', async (_name, fn) => {
      expect(await bodyOf(fn())).not.toContain(DISCLOSURE);
    });
  });
});

describe('the privacy notice', () => {
  it('names the sending team and says what is and is not recorded', async () => {
    const body = await bodyOf(privacyPage({ brand: 'Hivemarket', contact: null }));
    expect(body).toContain('sent by the Hivemarket team (Somnia)');
    for (const s of [
      'About you',
      'About each visit',
      'What is not recorded',
      'Who sees it',
      'How long',
      'Opting out',
    ]) {
      expect(body).toContain(s);
    }
    expect(body).toContain('Your IP address');
    expect(body).toContain('?optout=1');
  });

  it('points at the sender when no contact is configured', async () => {
    const body = await bodyOf(privacyPage({ brand: 'Hivemarket', contact: null }));
    expect(body).toContain('contact the person who sent you the link');
  });

  it('renders an address contact as mailto, a URL as a link, and escapes both', async () => {
    expect(await bodyOf(privacyPage({ brand: 'H', contact: 'privacy@hive.land' }))).toContain(
      '<a href="mailto:privacy@hive.land">privacy@hive.land</a>',
    );
    expect(
      await bodyOf(privacyPage({ brand: 'H', contact: 'https://hive.land/privacy' })),
    ).toContain('<a href="https://hive.land/privacy" rel="noopener">');
    const evil = await bodyOf(privacyPage({ brand: '<b>x</b>', contact: '<script>1</script>' }));
    expect(evil).not.toContain('<script>1</script>');
    expect(evil).not.toContain('<b>x</b>');
  });
});

describe('withCard', () => {
  const card = {
    title: 'Hivemarket — AI sales deck',
    description: 'Per-slide read tracking',
    image: null,
    url: 'https://docs.example/r/abc-123',
    siteName: 'Hivemarket',
  };

  it("swaps a gate's generic card for the share's, once, keeping status and headers", async () => {
    const before = emailGateForm('abc-123', 'bad email');
    const after = await withCard(before.clone(), card);
    expect(after.status).toBe(before.status);
    expect(after.headers.get('Cache-Control')).toBe(before.headers.get('Cache-Control'));
    const html = await after.text();
    expect(html).toContain('<meta property="og:title" content="Hivemarket — AI sales deck">');
    expect(html).toContain('<meta property="og:url" content="https://docs.example/r/abc-123">');
    expect((html.match(/property="og:title"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('og:image');
  });

  it('leaves a response without the markers alone', async () => {
    const res = await withCard(new Response('<p>plain</p>', { status: 418 }), card);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('<p>plain</p>');
  });
});
