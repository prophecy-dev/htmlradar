import { afterEach, describe, expect, it } from 'vitest';
import { geoFromRequest, injectTracker } from '../src/inject.js';
import type { Share } from '../src/store.js';

// HTMLRewriter is a Cloudflare-Workers global. Vitest runs in Node where
// it doesn't exist. We don't need to exercise the rewriter's mutation
// logic — the unit tests below assert what `injectTracker` PRODUCES via
// its snippet functions, which are pure strings. The few tests that
// require an actual transform happen at the Playwright level in
// packages/app/e2e/. So we mock HTMLRewriter just enough to let
// injectTracker assemble its snippet strings, capture them, and pass
// through the body unchanged.
// Which structural anchors the source doc "has". Real HTMLRewriter only
// fires an element handler when that tag physically exists in the stream —
// a fragment upload with no <head>/<body> fires neither. Tests flip these
// to exercise the document-end fallback; afterEach resets to a normal doc.
let mockPresence = { head: true, body: true };

let lastRewriter: FakeHTMLRewriter | null = null;
class FakeHTMLRewriter {
  handlers: Record<string, { element(el: FakeElement): void }> = {};
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastRewriter = this;
  }
  private docHandler: { end(end: FakeDocEnd): void } | null = null;
  private appended: { head: string[]; body: string[]; doc: string[] } = {
    head: [],
    body: [],
    doc: [],
  };
  on(selector: string, handler: { element(el: FakeElement): void }): this {
    this.handlers[selector] = handler;
    return this;
  }
  onDocument(handler: { end(end: FakeDocEnd): void }): this {
    this.docHandler = handler;
    return this;
  }
  transform(res: Response): Response {
    const stash = this.appended;
    if (mockPresence.head && this.handlers['head']) {
      this.handlers['head'].element(new FakeElement(stash.head));
    }
    if (mockPresence.body && this.handlers['body']) {
      this.handlers['body'].element(new FakeElement(stash.body));
    }
    // Document end ALWAYS fires, exactly like the real rewriter.
    if (this.docHandler) this.docHandler.end(new FakeDocEnd(stash.doc));
    const head = mockPresence.head ? `<head>${stash.head.join('')}</head>` : '';
    const body = mockPresence.body ? `<body>__BODY__${stash.body.join('')}</body>` : '__BODY__';
    // Doc-end appends land after the document, mirroring end.append().
    const synthetic = `<html>${head}${body}</html>${stash.doc.join('')}`;
    return new Response(synthetic, { status: res.status, headers: res.headers });
  }
}
class FakeElement {
  constructor(private appended: string[]) {}
  append(html: string, _opts: { html: true }): void {
    this.appended.push(html);
  }
}
class FakeDocEnd {
  constructor(private appended: string[]) {}
  append(html: string, _opts: { html: true }): void {
    this.appended.push(html);
  }
}
(globalThis as unknown as { HTMLRewriter: typeof FakeHTMLRewriter }).HTMLRewriter =
  FakeHTMLRewriter;

afterEach(() => {
  mockPresence = { head: true, body: true };
});

function reqWith(cf: Record<string, unknown> | undefined, ua: string): Request {
  const r = new Request('https://htmlradar.com/r/x', {
    headers: ua ? { 'user-agent': ua } : {},
  });
  if (cf) (r as { cf?: Record<string, unknown> }).cf = cf;
  return r;
}

describe('geoFromRequest', () => {
  it('extracts country + city from Cloudflare request.cf', () => {
    const r = reqWith({ country: 'US', city: 'San Francisco' }, '');
    const geo = geoFromRequest(r);
    expect(geo?.country).toBe('US');
    expect(geo?.city).toBe('San Francisco');
  });

  it('buckets UA strings into desktop/macOS/Safari', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    const geo = geoFromRequest(reqWith(undefined, ua));
    expect(geo?.deviceType).toBe('desktop');
    expect(geo?.os).toBe('macOS');
    expect(geo?.browser).toBe('Safari');
  });

  it('buckets a mobile Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
    const geo = geoFromRequest(reqWith(undefined, ua));
    expect(geo?.deviceType).toBe('mobile');
    expect(geo?.os).toBe('Android');
    expect(geo?.browser).toBe('Chrome');
  });

  it('survives an empty UA without throwing', () => {
    const geo = geoFromRequest(reqWith(undefined, ''));
    expect(geo).toEqual({});
  });
});

// --- Download/screenshot guard injection ----------------------------------

function makeShare(overrides: Partial<Share> = {}): Share {
  return {
    id: 'share-1',
    document_id: 'doc-1',
    owner_id: 'owner-1',
    slug: 'abc123',
    recipient_label: null,
    require_email: false,
    require_password: false,
    allowed_email_domains: null,
    allowed_emails: null,
    lock_deck: true,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  } as Share;
}

const BASE = {
  trackingEnabled: true,
  trackerUrl: '/v1/tracker.abc123def456.js',
  endpoint: 'https://docs.example',
};

function inject(opts: { lockDeck: boolean; email?: string; recipientLabel?: string | null }) {
  const res = injectTracker(
    new Response('<!doctype html><html><head></head><body></body></html>'),
    {
      share: makeShare({
        lock_deck: opts.lockDeck,
        ...(opts.recipientLabel !== undefined ? { recipient_label: opts.recipientLabel } : {}),
      }),
      ...BASE,
      ...(opts.email ? { email: opts.email } : {}),
    },
  );
  return res.text();
}

describe('download/screenshot guard injection (lock_deck semantic)', () => {
  it('injects the guard when lock_deck = true (default share posture)', async () => {
    const html = await inject({ lockDeck: true });
    expect(html).toContain('htmlradar-guard-style');
    expect(html).toContain('htmlradar-wm');
    expect(html).toContain('@media print');
    expect(html).toContain('contextmenu');
    expect(html).toContain('Printing of this document has been disabled');
  });

  it('does NOT inject the guard when lock_deck = false', async () => {
    const html = await inject({ lockDeck: false });
    expect(html).not.toContain('htmlradar-guard-style');
    expect(html).not.toContain('htmlradar-wm');
    expect(html).not.toContain('Printing of this document has been disabled');
  });

  it('uses the recipient email in the watermark when present', async () => {
    const html = await inject({ lockDeck: true, email: 'marc@example.com' });
    const count = (html.match(/marc@example\.com/g) ?? []).length;
    expect(count).toBeGreaterThan(20);
  });

  it('falls back to recipient_label when no email is present', async () => {
    const html = await inject({ lockDeck: true, recipientLabel: 'Marc — Series A' });
    expect(html).toContain('Marc — Series A');
  });

  it('falls back to a generic notice when neither email nor label is present', async () => {
    const html = await inject({ lockDeck: true, recipientLabel: null });
    expect(html).toContain('<span>Confidential</span>');
  });

  it('html-escapes the watermark identity so a label with HTML cannot break out', async () => {
    const html = await inject({
      lockDeck: true,
      recipientLabel: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not block keyboard input on form fields (allows recipient to type in sender forms)', async () => {
    const html = await inject({ lockDeck: true });
    expect(html).toContain("'INPUT'");
    expect(html).toContain("'TEXTAREA'");
    expect(html).toContain('isContentEditable');
  });

  it('guard sits BEFORE the tracked pill in body append order', async () => {
    const html = await inject({ lockDeck: true });
    const guardIdx = html.indexOf('htmlradar-guard-style');
    const pillIdx = html.indexOf('This link is tracked');
    expect(guardIdx).toBeGreaterThan(0);
    expect(pillIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(pillIdx);
  });
});

describe('attachments panel — corner pill UI', () => {
  function injectWithAttachments(args: {
    lockDeck: boolean;
    attachments: Array<{ id: string; filename: string; mime_type: string; size_bytes: number }>;
  }) {
    const res = injectTracker(
      new Response('<!doctype html><html><head></head><body></body></html>'),
      {
        share: makeShare({ lock_deck: args.lockDeck }),
        ...BASE,
        attachments: args.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
          document_id: 'doc-1',
          owner_id: 'owner-1',
          r2_key: 'k',
          created_at: '2026-05-18',
        })),
      },
    );
    return res.text();
  }

  const sample = [
    {
      id: 'a1',
      filename: 'Financials_v3.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1_800_000,
    },
    {
      id: 'a2',
      filename: 'Cap_table.xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: 84_000,
    },
  ];

  it('injects the pill + drawer when attachments are present (regardless of lock_deck)', async () => {
    const html = await injectWithAttachments({ lockDeck: true, attachments: sample });
    expect(html).toContain('hr-att-pill');
    expect(html).toContain('hr-att-drawer');
    expect(html).toContain('Files in this share');
    expect(html).toContain('Financials_v3.pdf');
    expect(html).toContain('Cap_table.xlsx');
  });

  it('also injects the panel when lock_deck = false (decoupled from deck-lock)', async () => {
    const html = await injectWithAttachments({ lockDeck: false, attachments: sample });
    expect(html).toContain('hr-att-pill');
  });

  it('renders the file count badge accurately', async () => {
    const html = await injectWithAttachments({ lockDeck: true, attachments: sample });
    expect(html).toContain('hr-att-pill-count">2');
    expect(html).toContain('2 attached');
  });

  it('does NOT inject pill or drawer when there are zero attachments', async () => {
    const html = await injectWithAttachments({ lockDeck: true, attachments: [] });
    expect(html).not.toContain('hr-att-pill');
    expect(html).not.toContain('hr-att-drawer');
  });

  it('download links route to /r/{slug}/m/{attachment_id}', async () => {
    const html = await injectWithAttachments({ lockDeck: true, attachments: sample });
    expect(html).toContain('/r/abc123/m/a1');
    expect(html).toContain('/r/abc123/m/a2');
  });

  it('escapes filenames so a malicious attachment name cannot inject markup', async () => {
    const html = await injectWithAttachments({
      lockDeck: true,
      attachments: [
        {
          id: 'evil',
          filename: '<script>alert(1)</script>.pdf',
          mime_type: 'application/pdf',
          size_bytes: 100,
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>.pdf');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.pdf');
  });
});

describe('document response headers', () => {
  // form-action 'none' is the credential-harvesting defence: a sign-in page
  // uploaded as a document cannot post what a visitor types.
  it('forbids every form submission and every framer', async () => {
    const res = injectTracker(new Response('<html><head></head><body></body></html>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
    });
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toMatch(/^sandbox allow-scripts allow-forms allow-popups allow-downloads;/);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    // Not no-referrer: the tracker records the referral source.
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('the tracker tag', () => {
  it('points at the proxy endpoint with the slug, and carries no Supabase key', async () => {
    const html = await inject({ lockDeck: false });
    expect(html).toContain('src="/v1/tracker.abc123def456.js"');
    expect(html).toContain('data-endpoint="https://docs.example"');
    expect(html).toContain('data-share-slug="abc123"');
    expect(html).not.toMatch(/supabase|anon-key/i);
  });
});

describe('the unfurl card on a served document', () => {
  const card = {
    title: 'Hivemarket — AI sales deck',
    description: 'Per-slide read tracking',
    image: 'https://docs.example/r/abc123/og-image',
    url: 'https://docs.example/r/abc123',
    siteName: 'Hivemarket',
  };

  it('puts the share card in <head>', async () => {
    const res = injectTracker(new Response('<html><head></head><body></body></html>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
      og: card,
    });
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Hivemarket — AI sales deck">');
    expect(html).toContain('<meta property="og:description" content="Per-slide read tracking">');
    expect(html).toContain(
      '<meta property="og:image" content="https://docs.example/r/abc123/og-image">',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('omits og:image when the document has none', async () => {
    const res = injectTracker(new Response('<html><head></head><body></body></html>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
      og: { ...card, image: null },
    });
    const html = await res.text();
    expect(html).toContain('og:title');
    expect(html).not.toContain('og:image');
  });

  it("removes the document's own og:/twitter: tags so they cannot compete", () => {
    injectTracker(new Response('<html><head></head><body></body></html>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
      og: card,
    });
    const handlers = lastRewriter!.handlers;
    let removed = 0;
    const el = { remove: () => removed++ };
    handlers['meta[property^="og:"]']!.element(el as unknown as FakeElement);
    handlers['meta[name^="twitter:"]']!.element(el as unknown as FakeElement);
    expect(removed).toBe(2);
  });
});

// Regression guard for the 2026-07-08 incident: an HTML fragment with no
// <head>/<body> fired no element handler and the tracker was silently dropped.
describe('fragment / headless document fallback', () => {
  it('still injects the tracker when the upload has no <head> or <body>', async () => {
    mockPresence = { head: false, body: false };
    const res = injectTracker(new Response('<div class="wrap">just a fragment</div>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
    });
    const html = await res.text();
    expect(html).toContain('/v1/tracker.abc123def456.js');
    expect(html).toContain('HTMLRadarConfig');
  });

  it('injects the tracker exactly once when <head> exists (no double-inject)', async () => {
    const res = injectTracker(
      new Response('<!doctype html><html><head></head><body></body></html>'),
      { share: makeShare({ lock_deck: false }), ...BASE },
    );
    const html = await res.text();
    expect((html.match(/HTMLRadarConfig/g) ?? []).length).toBe(1);
  });

  it('still injects the tracked pill + lock guard on a headless doc', async () => {
    mockPresence = { head: false, body: false };
    const res = injectTracker(new Response('<div>frag</div>'), {
      share: makeShare({ lock_deck: true }),
      ...BASE,
    });
    const html = await res.text();
    expect(html).toContain('This link is tracked');
    expect(html).toContain('htmlradar-guard-style');
  });
});

describe('the comment box switch', () => {
  it('is in the injected config only when the caller asks for it', async () => {
    const withBox = await (
      await injectTracker(new Response('<html><head></head><body></body></html>'), {
        share: makeShare({ require_email: true, verify_email: true }),
        ...BASE,
        email: 'buyer@acme.test',
        commentProof: '1790000000.abc123',
      })
    ).text();
    expect(withBox).toContain('"comments":{"enabled":true,"proof":"1790000000.abc123"}');

    // The same verified reader on a load where the proxy did not turn it on
    // (opted out, owner preview) gets a document with nothing to comment in.
    const without = await (
      await injectTracker(new Response('<html><head></head><body></body></html>'), {
        share: makeShare({ require_email: true, verify_email: true }),
        ...BASE,
        email: 'buyer@acme.test',
      })
    ).text();
    expect(without).not.toContain('comments');
  });
});

describe('the tracked pill', () => {
  it('replaces the Powered-by badge and links the privacy notice', async () => {
    const html = await inject({ lockDeck: false });
    expect(html).toContain('This link is tracked · privacy');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain('Powered by');
    expect(html).not.toContain('htmlradar.com');
  });

  it('is absent, with the tracker, when tracking is off (owner preview, opted out)', async () => {
    const res = injectTracker(new Response('<html><head></head><body></body></html>'), {
      share: makeShare({ lock_deck: false }),
      ...BASE,
      trackingEnabled: false,
    });
    const html = await res.text();
    expect(html).not.toContain('HTMLRadarConfig');
    expect(html).not.toContain('This link is tracked');
  });
});
