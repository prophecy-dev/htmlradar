import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The verified e-mail gate, through the worker's own fetch handler.
//
// WHAT THIS FILE PROVES AND WHAT IT DOES NOT. The database is where the limits
// and the attempt counter really live, and schema/tests/055_*_test.sql proves
// them against real Postgres with real concurrency. What cannot be proved
// there is the half that decides what a READER sees: that a permitted and a
// non-permitted address get the identical screen, that an ordinary e-mail
// cookie cannot satisfy a link that requires verification, that the
// attachments and the frame honour the same rule, and that a failed send never
// opens the document. That is this file.
//
// The two RPCs are replaced by a small model that behaves the way the real SQL
// does — ten minutes, single use, five attempts, bound to (link, address,
// browser). It is a model, so it cannot prove the SQL; it is here so the
// worker's branches can be driven through every outcome the SQL can return.

const base = {
  id: 'share-1',
  document_id: 'doc-1',
  owner_id: 'owner-1',
  slug: 'acme-proposal',
  recipient_label: null,
  require_email: true,
  require_password: false,
  verify_email: true,
  allowed_email_domains: null,
  allowed_emails: ['buyer@acme.test'],
  lock_deck: false,
  expires_at: null,
  revoked_at: null,
  owner_display_name: 'Dana Sender',
  owner_email: 'dana@example.test',
  document_title: 'The Proposal',
  document_og_description: null,
  document_og_image_r2_key: null,
};

let share = { ...base };

const doc = {
  id: 'doc-1',
  owner_id: 'owner-1',
  title: 'The Proposal',
  source_type: 'url',
  source_url: 'https://example.test/deck.html',
  r2_key: null,
  current_version: 1,
  deleted_at: null,
};

// --- the model of schema/055's two functions -------------------------------

interface Row {
  shareId: string;
  email: string;
  codeHash: string;
  challenge: string;
  countsTowardAddress: boolean;
  created: number;
  expires: number;
  attempts: number;
  used: boolean;
}
let rows: Row[] = [];
// Every issue, whether or not a message followed. What the enumeration tests
// count, because the point is that the database work is the same either way.
let issued: Array<{ email: string; allowedByModel: boolean }> = [];

const issueVerificationCode = vi.fn(
  async (
    _env: unknown,
    p: {
      shareId: string;
      email: string;
      codeHash: string;
      challenge: string;
      permitted: boolean;
    },
  ) => {
    issued.push({ email: p.email, allowedByModel: p.permitted });
    // Mirrors schema/055 after Astra's finding 5: an address the link does not
    // permit is recorded (the network ceiling counts it) but spends none of
    // that address's own budget.
    const counts = rows.filter((r) => r.countsTowardAddress);
    const perLink = counts.filter(
      (r) => r.shareId === p.shareId && r.email === p.email && r.created > Date.now() - 900_000,
    ).length;
    const perAddress = counts.filter((r) => r.email === p.email).length;
    if (p.permitted && (perLink >= 3 || perAddress >= 5)) return 'rate_limited';
    // One live code per browser: the previous one stops being live.
    for (const r of rows) {
      if (r.shareId === p.shareId && r.email === p.email && r.challenge === p.challenge) {
        r.expires = 0;
      }
    }
    rows.push({
      ...p,
      countsTowardAddress: p.permitted,
      created: Date.now(),
      expires: Date.now() + 600_000,
      attempts: 0,
      used: false,
    });
    return 'ok';
  },
);

const checkVerificationCode = vi.fn(
  async (
    _env: unknown,
    p: { shareId: string; email: string; codeHash: string; challenge: string },
  ) => {
    const row = [...rows]
      .reverse()
      .find(
        (r) =>
          r.shareId === p.shareId &&
          r.email === p.email &&
          r.challenge === p.challenge &&
          !r.used &&
          r.expires > Date.now() &&
          r.attempts < 5,
      );
    if (!row) return 'bad';
    row.attempts += 1;
    if (row.codeHash !== p.codeHash) return 'bad';
    row.used = true;
    return 'ok';
  },
);

vi.mock('../src/store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/store.js')>('../src/store.js');
  return {
    ...actual,
    getShareBySlug: vi.fn(async () => share),
    getDocument: vi.fn(async () => doc),
    listAttachmentsForDocument: vi.fn(async () => []),
    getAttachment: vi.fn(async () => ({
      id: 'att-1',
      document_id: 'doc-1',
      owner_id: 'owner-1',
      filename: 'terms.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10,
      r2_key: 'k',
      created_at: '2026-01-01',
    })),
    logAttachmentDownload: vi.fn(async () => undefined),
    getViewerIdByShareEmail: vi.fn(async () => null),
    verifySharePassword: vi.fn(async () => 'ok'),
    issueVerificationCode: (...a: unknown[]) =>
      (issueVerificationCode as unknown as (...x: unknown[]) => unknown)(...a),
    checkVerificationCode: (...a: unknown[]) =>
      (checkVerificationCode as unknown as (...x: unknown[]) => unknown)(...a),
  };
});

// The provider boundary. Every message the worker tries to send lands here,
// which is also how the golden journey reads a code without an inbox.
const sent: Array<{ to: string; code: string; host: string; title: string }> = [];
let sendSucceeds = true;
// A provider that never answers, which is the case a timeout is made of. The
// promise is held until the test releases it, so "the reader did not wait for
// it" is a fact about the clock rather than an assumption.
let sendHangs = false;
let release: (() => void) | null = null;
function releaseHang(): void {
  release?.();
  release = null;
}
vi.mock('../src/mail.js', async () => ({
  ...(await vi.importActual<typeof import('../src/mail.js')>('../src/mail.js')),
  sendVerificationCode: vi.fn(
    async (_env: unknown, m: { to: string; code: string; host: string; documentTitle: string }) => {
      if (sendHangs) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return false;
      }
      if (!sendSucceeds) return false;
      sent.push({ to: m.to, code: m.code, host: m.host, title: m.documentTitle });
      return true;
    },
  ),
}));

vi.mock('../src/inject.js', async () => {
  const actual = await vi.importActual<typeof import('../src/inject.js')>('../src/inject.js');
  return {
    ...actual,
    injectTracker: vi.fn(
      async () =>
        new Response('<html><body><h1>Deck</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    ),
  };
});

vi.mock('../src/fetch-html.js', () => ({
  fetchDocumentHtml: vi.fn(async () => new Response('<html><body>Deck</body></html>')),
}));

const env = {
  SESSION_SECRET: 'test-session-secret',
  // The floor is proved once, in its own test; every other assertion here
  // would otherwise pay 1.2 seconds for nothing. See gateFloorMs in index.ts.
  GATE_FLOOR_MS: '0',
  // Present so a refused send reads as the provider's refusal; the send
  // itself is the mocked sendVerificationCode above.
  EMAIL: { send: async () => ({}) },
  DOCS_BUCKET: { get: async () => ({ body: null }) },
} as unknown as import('../src/env.js').Env;

// waitUntil has to really run here, because the send now happens inside it.
// A ctx that throws the promise away would make every assertion about what was
// mailed vacuously true — the exact shape of test that certifies a broken send
// path as working.
const pending: Array<Promise<unknown>> = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => pending.push(p),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Let everything the handler deferred finish, as the runtime would. */
async function settle(): Promise<void> {
  while (pending.length) await pending.shift();
}

const HOST = 'https://docs.example';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const worker = (await import('../src/index.js')).default;
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), env, ctx);
  await settle();
  return res;
}

/** What our own sandboxed gate page sends: `Origin: null`, plus its cookies. */
function rawPost(path: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { Origin: 'null' };
  if (cookie) headers['Cookie'] = cookie;
  return call(path, { method: 'POST', body, headers });
}

/**
 * Merge cookie strings the way a browser's jar does: one value per name, the
 * newest winning. Naively concatenating them produces two copies of a name,
 * which the worker's single-copy reads correctly refuse — so a test that
 * concatenated would be testing the shadowing defence rather than the gate.
 */
function mergeJar(...parts: Array<string | undefined>): string {
  const byName = new Map<string, string>();
  for (const part of parts) {
    if (!part) continue;
    for (const pair of part.split('; ')) {
      const name = pair.slice(0, pair.indexOf('='));
      if (name) byName.set(name, pair);
    }
  }
  return [...byName.values()].join('; ');
}

/**
 * Everything about a response that is allowed to differ between two readers,
 * blanked so the rest can be compared byte for byte.
 *
 * Only two things vary legitimately: the address the reader typed, which is
 * echoed into the hidden field, and the signature in the form token, which is
 * a fresh HMAC over a fresh challenge every time. Nothing else may differ —
 * not a word, not a status, not a header — so everything else is compared as
 * it stands, including the headers, which the first version of this test did
 * not look at at all (Astra's note).
 */
function shape(body: string, address: string): string {
  return body
    .split(address)
    .join('<ADDRESS>')
    .replace(/name="t" value="[^"]+"/g, 'name="t" value="<TOKEN>"');
}

function headerShape(res: Response): string {
  return [...res.headers.entries()]
    .filter(([name]) => name !== 'set-cookie')
    .map(([name, value]) => `${name}: ${value}`)
    .sort()
    .join('\n');
}

/** The hidden signed field a rendered gate form carries. */
function tokenOf(html: string): string {
  return /name="t" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

// The token and cookies the LAST rendered gate page handed this browser. A
// real reader's second post carries what their first answer gave them, and
// these two hold that for the helper below.
let lastToken = '';
let lastJar = '';

/**
 * A browser's whole move: land on the page that mints the challenge and the
 * signed field, then post the form it rendered, carrying both.
 *
 * Every ordinary test goes through this, so they exercise the same handshake a
 * reader does. A post built by hand is now a FORGED post, and the tests that
 * want one build it by hand deliberately.
 */
async function post(
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const slug = path.split('/')[2]!;
  let jarForPost = cookie ?? '';
  let token = fields['t'] ?? '';

  if (path.endsWith('/email')) {
    // The address form comes from the document route.
    const page = await call(`/r/${slug}`, cookie ? { headers: { Cookie: cookie } } : {});
    token = tokenOf(await page.clone().text());
    jarForPost = mergeJar(cookie, jar(page));
  } else if (!token) {
    // The code form was rendered by whatever the address step answered.
    token = lastToken;
    jarForPost = cookie ?? lastJar;
  }

  const res = await rawPost(path, { ...fields, t: token }, jarForPost || undefined);
  const body = await res.clone().text();
  const next = tokenOf(body);
  if (next) lastToken = next;
  const setCookies = jar(res);
  lastJar = mergeJar(jarForPost, setCookies);
  return res;
}

/** Every Set-Cookie on a response, as `name=value` pairs the next request can send. */
function jar(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

function challengeOf(res: Response): string {
  const c = res.headers.getSetCookie().find((s) => s.startsWith('__Host-hr_vc='));
  return c ? c.split(';')[0]!.split('=')[1]! : '';
}

/**
 * The whole permitted journey, ending in a browser that holds the verified
 * cookie. Used by the tests that need a reader already inside.
 */
async function admit(email = 'buyer@acme.test'): Promise<string> {
  await post('/r/acme-proposal/email', { email });
  const code = sent[sent.length - 1]!.code;
  const step2 = await post('/r/acme-proposal/verify', { email, code });
  return mergeJar(jar(step2));
}

beforeEach(() => {
  share = { ...base };
  rows = [];
  issued = [];
  sent.length = 0;
  sendSucceeds = true;
  pending.length = 0;
  lastToken = '';
  lastJar = '';
  sendHangs = false;
  release = null;
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('the option only exists behind the e-mail gate', () => {
  it('serves the ordinary gate when verification is off', async () => {
    share.verify_email = false;
    const res = await call('/r/acme-proposal');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Enter your email');
  });

  it('answers not-found on the code route when the link asks for no code', async () => {
    share.verify_email = false;
    const res = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code: '123456' });
    expect(res.status).toBe(404);
  });
});

describe('C — a permitted and a non-permitted address are indistinguishable', () => {
  it('returns the identical screen, status, wording and headers', async () => {
    const yes = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const no = await post('/r/acme-proposal/email', { email: 'stranger@elsewhere.test' });
    expect(yes.status).toBe(no.status);
    expect(yes.status).toBe(200);
    const a = shape(await yes.text(), 'buyer@acme.test');
    const b = shape(await no.text(), 'stranger@elsewhere.test');
    expect(a).toBe(b);
    expect(headerShape(yes)).toBe(headerShape(no));
    // And the cookie SHAPE matches too — a challenge is set for both, so the
    // presence of one is not itself the tell.
    const names = (r: Response) =>
      r.headers
        .getSetCookie()
        .map((c) => c.slice(0, c.indexOf('=')))
        .sort();
    expect(names(yes)).toEqual(names(no));
    expect(a).toContain('If that address can open this document, we have sent it a six-digit code');
  });

  it('is still the identical screen once the address has exhausted its budget', async () => {
    // Astra's note: the first version of this test never compared the
    // over-limit case, which is the one an attacker can reach on purpose.
    for (let i = 0; i < 4; i++) await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    for (let i = 0; i < 4; i++) {
      await post('/r/acme-proposal/email', { email: 'stranger@elsewhere.test' });
    }
    const yes = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const no = await post('/r/acme-proposal/email', { email: 'stranger@elsewhere.test' });
    expect(yes.status).toBe(no.status);
    expect(shape(await yes.text(), 'buyer@acme.test')).toBe(
      shape(await no.text(), 'stranger@elsewhere.test'),
    );
    expect(headerShape(yes)).toBe(headerShape(no));
  });

  it('does the same database work for both, and mails only the permitted one', async () => {
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    await post('/r/acme-proposal/email', { email: 'stranger@elsewhere.test' });
    expect(issued).toHaveLength(2);
    expect(sent.map((s) => s.to)).toEqual(['buyer@acme.test']);
  });

  it('never sends to an address the link does not permit, on any list shape', async () => {
    share.allowed_emails = null;
    share.allowed_email_domains = ['acme.test'];
    await post('/r/acme-proposal/email', { email: 'anyone@acme.test' });
    await post('/r/acme-proposal/email', { email: 'anyone@other.test' });
    expect(sent.map((s) => s.to)).toEqual(['anyone@acme.test']);
  });
});

describe('B — every way of being wrong is the same refusal', () => {
  it('refuses a wrong code, and says one thing', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const res = await post(
      '/r/acme-proposal/verify',
      { email: 'buyer@acme.test', code: '000001' },
      jar(step1),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('That code is not right');
  });

  it('refuses a used code the second time', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const cookie = jar(step1);
    const code = sent[0]!.code;
    const first = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code }, cookie);
    expect(first.status).toBe(303);
    const again = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code }, cookie);
    expect(again.status).toBe(401);
  });

  it('refuses an expired code', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const cookie = jar(step1);
    const code = sent[0]!.code;
    for (const r of rows) r.expires = Date.now() - 1;
    const res = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code }, cookie);
    expect(res.status).toBe(401);
  });

  it('refuses a code submitted for a different address', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const res = await post(
      '/r/acme-proposal/verify',
      { email: 'someone@acme.test', code: sent[0]!.code },
      jar(step1),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a code in a browser that did not ask for it — the shoulder-surf case', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const code = sent[0]!.code;
    // Second browser: it has watched the code but holds no challenge of its
    // own, and the one it invents does not match.
    const other = '__Host-hr_vc=' + 'f'.repeat(32);
    const res = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code }, other);
    expect(res.status).toBe(401);
    expect(challengeOf(step1)).not.toBe('f'.repeat(32));
  });

  it('refuses a submission carrying no challenge cookie at all', async () => {
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    // Built by hand, with the real code and the real token but no cookie: this
    // is what a submission from a browser that never saw the form looks like.
    const res = await rawPost('/r/acme-proposal/verify', {
      email: 'buyer@acme.test',
      code: sent[0]!.code,
      t: lastToken,
    });
    expect(await res.text()).toContain('That form expired');
    expect(rows.some((r) => r.used)).toBe(false);
  });
});

describe('A — guessing', () => {
  it('burns the code after five wrong attempts, and the right one no longer works', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const cookie = jar(step1);
    const code = sent[0]!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await post(
        '/r/acme-proposal/verify',
        { email: 'buyer@acme.test', code: wrong },
        cookie,
      );
      expect(res.status).toBe(401);
    }
    const right = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code }, cookie);
    expect(right.status).toBe(401);
  });

  it('a new code does not revive the burnt one, and one browser holds one live code', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const cookie = jar(step1);
    const first = sent[0]!.code;
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' }, cookie);
    const second = sent[1]!.code;
    expect(rows.filter((r) => r.expires > Date.now())).toHaveLength(1);
    const stale = await post(
      '/r/acme-proposal/verify',
      { email: 'buyer@acme.test', code: first },
      cookie,
    );
    expect(stale.status).toBe(401);
    const fresh = await post(
      '/r/acme-proposal/verify',
      { email: 'buyer@acme.test', code: second },
      cookie,
    );
    expect(fresh.status).toBe(303);
  });
});

describe('D — the limits, and the neutral screen over them', () => {
  it('shows the SAME screen, word for word, when the address is over its limit', async () => {
    // It used to carry an extra "try again in a few minutes" line, and that
    // line became a leak the moment a non-permitted address stopped consuming
    // its own budget (Astra, finding 5): only a permitted address could ever
    // reach it, so the line itself answered the one question this gate must
    // not answer. Decision 5d — the over-limit reply is the same neutral page
    // as everything else.
    const first = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const firstBody = shape(await first.text(), 'buyer@acme.test');
    for (let i = 0; i < 3; i++) await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const over = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    expect(over.status).toBe(first.status);
    expect(shape(await over.text(), 'buyer@acme.test')).toBe(firstBody);
    expect(firstBody).toContain('we have sent it a six-digit code');
    expect(firstBody).not.toContain('Try again in a few minutes');
  });

  it('sends nothing once the limit is reached', async () => {
    for (let i = 0; i < 6; i++) await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    expect(sent.length).toBeLessThanOrEqual(3);
  });

  it('does not overwrite a live challenge when a request is refused', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const cookie = jar(step1);
    const code = sent[0]!.code;
    for (let i = 0; i < 5; i++)
      await post('/r/acme-proposal/email', { email: 'buyer@acme.test' }, cookie);
    // The reader's browser still holds the challenge it was given, so their
    // own code is still theirs to spend once the limit clears.
    expect(challengeOf(step1)).toHaveLength(32);
    expect(typeof code).toBe('string');
  });
});

describe('F and E — the cookies and the forged post', () => {
  it('mints the challenge as a __Host- cookie with SameSite=None', async () => {
    const res = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const c = res.headers.getSetCookie().find((s) => s.startsWith('__Host-hr_vc='))!;
    expect(c).toMatch(/Path=\/;/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    // The gate pages are sandboxed into an opaque origin, so the browser calls
    // a post back to this very host cross-site. Lax would never arrive.
    expect(c).toContain('SameSite=None');
    expect(c).not.toMatch(/Domain=/i);
  });

  it('mints the verified cookie under a __Host- name scoped to the slug', async () => {
    const step1 = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const res = await post(
      '/r/acme-proposal/verify',
      { email: 'buyer@acme.test', code: sent[0]!.code },
      jar(step1),
    );
    const c = res.headers.getSetCookie().find((s) => s.startsWith('__Host-hr_v_acme-proposal='))!;
    expect(c).toBeDefined();
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).not.toMatch(/Domain=/i);
  });

  it('trusts neither copy when the verified cookie is shadowed', async () => {
    const cookie = await admit();
    const planted = `${cookie}; __Host-hr_v_acme-proposal=forged.forged.9999999999.forged`;
    const res = await call('/r/acme-proposal', { headers: { Cookie: planted } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Enter your email');
  });

  it('a forged request-code post cannot mint a code (Astra, finding 2)', async () => {
    // The attacker's own sandboxed frame sends `Origin: null` and the
    // victim's browser attaches the SameSite=None challenge automatically, so
    // the cookie arrives. What the attacker cannot produce is a token signed
    // over THAT challenge — theirs was signed over their own.
    const victimPage = await call('/r/acme-proposal');
    const victimJar = jar(victimPage);
    const attackerToken = await (
      await import('../src/auth.js')
    ).issueGateToken('email', 'acme-proposal', 'a'.repeat(32), '', env.SESSION_SECRET);

    const forged = await rawPost(
      '/r/acme-proposal/email',
      { email: 'attacker@acme.test', t: attackerToken },
      victimJar,
    );
    expect(await forged.text()).toContain('That form expired');
    // Nothing was spent and nothing was sent.
    expect(sent).toHaveLength(0);
    expect(issued).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('a forged submit-code post cannot spend a code', async () => {
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const code = sent[0]!.code;
    const attackerToken = await (
      await import('../src/auth.js')
    ).issueGateToken(
      'code',
      'acme-proposal',
      'a'.repeat(32),
      'buyer@acme.test',
      env.SESSION_SECRET,
    );
    const forged = await rawPost(
      '/r/acme-proposal/verify',
      { email: 'buyer@acme.test', code, t: attackerToken },
      lastJar,
    );
    expect(await forged.text()).toContain('That form expired');
    expect(forged.headers.getSetCookie().some((c) => c.startsWith('__Host-hr_v_'))).toBe(false);
    // The code is untouched, so the real reader can still use it.
    const real = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code });
    expect(real.status).toBe(303);
  });

  it('forged wrong guesses cannot burn the victim’s pending code', async () => {
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const code = sent[0]!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    const attackerToken = await (
      await import('../src/auth.js')
    ).issueGateToken(
      'code',
      'acme-proposal',
      'a'.repeat(32),
      'buyer@acme.test',
      env.SESSION_SECRET,
    );
    for (let i = 0; i < 6; i++) {
      await rawPost(
        '/r/acme-proposal/verify',
        { email: 'buyer@acme.test', code: wrong, t: attackerToken },
        lastJar,
      );
    }
    // Not one attempt was counted, because a forged post never reaches the
    // database at all.
    expect(rows[0]!.attempts).toBe(0);
    const real = await post('/r/acme-proposal/verify', { email: 'buyer@acme.test', code });
    expect(real.status).toBe(303);
  });

  it('refuses both gate posts from another origin', async () => {
    const body = new URLSearchParams({ email: 'buyer@acme.test' });
    const forged = await call('/r/acme-proposal/email', {
      method: 'POST',
      body,
      headers: { Origin: 'https://evil.test' },
    });
    expect(await forged.text()).toContain('didn&#39;t come from this page');
    expect(sent).toHaveLength(0);

    const noOrigin = await call('/r/acme-proposal/verify', {
      method: 'POST',
      body: new URLSearchParams({ email: 'buyer@acme.test', code: '123456' }),
    });
    expect(await noOrigin.text()).toContain('didn&#39;t come from this page');
  });

  it('serves the gate pages with strict-origin and never no-referrer', async () => {
    const res = await call('/r/acme-proposal');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
  });
});

describe('H — every path behind the gate honours it', () => {
  it('opens the document once the code has come back', async () => {
    const cookie = await admit();
    const res = await call('/r/acme-proposal', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Deck');
  });

  it('refuses an ordinary e-mail cookie, which is decision 6', async () => {
    // Earn a real e-mail cookie with the option off, then turn it on: the
    // reader who was already past the gate must verify at their next open.
    share.verify_email = false;
    const gate = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const emailCookie = jar(gate);
    expect(emailCookie).toContain('htmlradar_email_acme-proposal=');
    share.verify_email = true;
    const res = await call('/r/acme-proposal', { headers: { Cookie: emailCookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Enter your email');
  });

  it('refuses an attachment to an unverified reader and allows it to a verified one', async () => {
    share.verify_email = false;
    const gate = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const emailCookie = jar(gate);
    share.verify_email = true;
    const refused = await call('/r/acme-proposal/m/aaaaaaaa-0000-0000-0000-000000000000', {
      headers: { Cookie: emailCookie },
    });
    expect(refused.status).toBe(404);

    const cookie = await admit();
    const allowed = await call('/r/acme-proposal/m/aaaaaaaa-0000-0000-0000-000000000000', {
      headers: { Cookie: cookie },
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses the frame route to an unverified reader', async () => {
    const res = await call('/r/acme-proposal/frame', {
      headers: { 'Sec-Fetch-Dest': 'iframe' },
    });
    // The wrapper is off, so the route is not-found either way; what matters
    // is that it is never the document.
    expect(res.status).toBe(404);
  });

  it('re-checks the allow-list on every open, so a tightened list locks a verified reader out', async () => {
    const cookie = await admit();
    share.allowed_emails = ['someone-else@acme.test'];
    const res = await call('/r/acme-proposal', { headers: { Cookie: cookie } });
    expect(await res.text()).toContain('no longer shared with your address');
  });
});

describe('G and K — the message, and a send that fails', () => {
  it('names the host the reader is on, the document and the sender', async () => {
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    expect(sent[0]!.host).toBe('docs.example');
    expect(sent[0]!.title).toBe('The Proposal');
  });

  it('answers the same page whether the provider accepts, refuses or hangs', async () => {
    const ok = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const okBody = shape(await ok.text(), 'buyer@acme.test');

    // A provider that says no.
    share.allowed_emails = ['buyer@acme.test'];
    rows.length = 0;
    sendSucceeds = false;
    const refused = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    expect(refused.status).toBe(ok.status);
    expect(shape(await refused.text(), 'buyer@acme.test')).toBe(okBody);

    // A provider that never answers. The reader must not wait for it and must
    // not be told about it, so the page is the same and it is not late.
    rows.length = 0;
    sendHangs = true;
    // Driven through the worker directly rather than the helper, because the
    // helper drains waitUntil and this send is deliberately never going to
    // settle until the test releases it.
    const worker = (await import('../src/index.js')).default;
    const page = await worker.fetch(new Request(`${HOST}/r/acme-proposal`), env, ctx);
    const token = tokenOf(await page.clone().text());
    const started = Date.now();
    const hung = await worker.fetch(
      new Request(`${HOST}/r/acme-proposal/email`, {
        method: 'POST',
        body: new URLSearchParams({ email: 'buyer@acme.test', t: token }),
        headers: { Origin: 'null', Cookie: jar(page) },
      }),
      env,
      ctx,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hung.status).toBe(ok.status);
    expect(shape(await hung.text(), 'buyer@acme.test')).toBe(okBody);
    // Astra's note: prove the send was actually handed to waitUntil rather
    // than assuming it, or "it did not block" would also be true of a send
    // that never happened.
    expect(pending.length + sent.length).toBeGreaterThan(0);
    releaseHang();
    await settle();
    sendHangs = false;
  });

  it('never opens the document on a refused send, and issues no cookie', async () => {
    sendSucceeds = false;
    const res = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const body = await res.text();
    expect(body).not.toMatch(/at \w+ \(|Error:|stack/i);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-hr_v_'))).toBe(false);
    // And the only thing that opens the document is still a correct code,
    // which a reader who never received one cannot produce.
    const doc = await call('/r/acme-proposal', { headers: { Cookie: jar(res) } });
    expect(await doc.text()).toContain('Enter your email');
  });

  it('records a refused send with a reason, where nobody at the gate can see it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendSucceeds = false;
    await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const failures = logged.mock.calls.filter((c) => c[0] === 'verification code not sent');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('provider_refused');
    // Never the address: the worker's log is not where a third party's
    // identity belongs.
    expect(JSON.stringify(failures[0])).not.toContain('buyer@');
    logged.mockRestore();
  });
});

describe('I — the neighbouring flows are untouched', () => {
  it('lets the owner preview without any of this', async () => {
    const { default: worker } = await import('../src/index.js');
    const { issueOwnerPreviewToken } = await import('../src/auth.js');
    const token = await issueOwnerPreviewToken('acme-proposal', env.SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`${HOST}/r/acme-proposal?owner_preview=${token}`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Deck');
    expect(sent).toHaveLength(0);
  });

  it('still asks for the password first on a link that has both', async () => {
    share.require_password = true;
    const res = await call('/r/acme-proposal');
    expect(await res.text()).toContain('Locked.');
  });

  it('leaves the opt-out question reachable on a verified link', async () => {
    const res = await call('/r/acme-proposal?optout=1');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Turn off read tracking');
  });
});

describe('C — the timing floor itself', () => {
  it('holds both answers to the same point on the clock', async () => {
    const floored = { ...env, GATE_FLOOR_MS: '400' } as typeof env;
    const worker = (await import('../src/index.js')).default;
    const submit = async (email: string) => {
      // The handshake first, so the post is a real one; only the post itself
      // is timed.
      const page = await worker.fetch(new Request(`${HOST}/r/acme-proposal`), floored, ctx);
      const token = tokenOf(await page.clone().text());
      const cookie = jar(page);
      const started = Date.now();
      await worker.fetch(
        new Request(`${HOST}/r/acme-proposal/email`, {
          method: 'POST',
          body: new URLSearchParams({ email, t: token }),
          headers: { Origin: 'null', Cookie: cookie },
        }),
        floored,
        ctx,
      );
      return Date.now() - started;
    };
    // The permitted address is the one that pays for a send; without the floor
    // it would be the slower of the two by exactly that.
    const permitted = await submit('buyer@acme.test');
    const refused = await submit('stranger@elsewhere.test');
    expect(permitted).toBeGreaterThanOrEqual(395);
    expect(refused).toBeGreaterThanOrEqual(395);
  });
});

describe('L — the code field on a phone', () => {
  it('offers the one-time code and the number pad, and does not fight paste', async () => {
    const res = await post('/r/acme-proposal/email', { email: 'buyer@acme.test' });
    const body = await res.text();
    expect(body).toContain('autocomplete="one-time-code"');
    expect(body).toContain('inputmode="numeric"');
    expect(body).toContain('maxlength="6"');
    // type="number" would bring a spinner, strip a leading zero and break
    // pasting; it must never appear on this field.
    expect(body).not.toContain('type="number"');
    expect(body).toContain('<label for="code">');
    // No script at all: the gate pages carry none, and this one must not be
    // the first.
    expect(body).not.toContain('<script');
  });
});
