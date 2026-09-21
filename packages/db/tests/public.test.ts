import { beforeEach, describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from './d1-fake.js';
import { DOC, OWNER, seedOwnerAndDoc, seedShare } from './seed.js';
import {
  RpcFailure,
  checkEmailVerificationCode,
  checkSharePassword,
  getShareBySlug,
  issueEmailVerificationCode,
  recordNotification,
  startSession,
  updateSession,
  type StartSessionInput,
} from '../src/public.js';
import { hashSharePassword } from '../src/password.js';

let db: ReturnType<typeof fakeD1>;

beforeEach(() => {
  db = fakeD1();
  seedOwnerAndDoc(db as FakeD1, { telegram: '12345' });
});

const start = (slug: string, over: Partial<StartSessionInput> = {}) =>
  startSession(db, {
    p_share_slug: slug,
    p_email: null,
    p_fingerprint: 'fp-1',
    p_referrer: 'https://t.me/',
    p_user_agent: 'Mozilla/5.0',
    p_country_code: 'DE',
    p_city: 'Berlin',
    p_device_type: 'desktop',
    ...over,
  });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof RpcFailure ? e.code : String(e);
  }
}

describe('getShareBySlug', () => {
  it('joins the owner and document, converting booleans and arrays', async () => {
    seedShare(db, { slug: 'acme', require_email: true, allowed_email_domains: ['acme.com'] });
    const s = await getShareBySlug(db, 'acme');
    expect(s?.owner_email).toBe(OWNER.email);
    expect(s?.document_title).toBe(DOC.title);
    expect(s?.document_og_description).toBe('Per-slide read tracking');
    expect(s?.require_email).toBe(true);
    expect(s?.verify_email).toBe(false);
    expect(s?.allowed_email_domains).toEqual(['acme.com']);
    expect(await getShareBySlug(db, 'nope')).toBeNull();
  });
});

describe('checkSharePassword', () => {
  it('accepts the right password, refuses the wrong one, then rate-limits', async () => {
    seedShare(db, { slug: 'pw', password_hash: await hashSharePassword('open sesame') });
    expect(await checkSharePassword(db, 'pw', 'open sesame')).toBe('ok');
    expect(await checkSharePassword(db, 'pw', 'nope')).toBe('bad');
    for (let i = 0; i < 3; i++) await checkSharePassword(db, 'pw', 'nope');
    expect(await checkSharePassword(db, 'pw', 'open sesame')).toBe('rate_limited');
  });
});

describe('verified e-mail codes', () => {
  const base = { email: 'Reader@Acme.com', ipHash: 'ip1', permitted: true };

  beforeEach(() => {
    seedShare(db, { slug: 'v', require_email: true, verify_email: true });
    seedShare(db, { slug: 'plain', require_email: true });
  });

  it('issues, then accepts the right code exactly once', async () => {
    const shareId = 'share-v';
    expect(
      await issueEmailVerificationCode(db, {
        ...base,
        shareId,
        codeHash: 'a'.repeat(64),
        challenge: 'c1',
      }),
    ).toBe('ok');
    const args = { shareId, email: 'reader@acme.com', challenge: 'c1' };
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: 'b'.repeat(64) })).toBe('bad');
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: 'a'.repeat(64) })).toBe('ok');
    // Used up.
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: 'a'.repeat(64) })).toBe('bad');
    expect(db.rows(`SELECT email FROM share_email_verifications`)).toEqual([
      { email: 'reader@acme.com' },
    ]);
  });

  it('burns a code after five wrong guesses', async () => {
    const shareId = 'share-v';
    await issueEmailVerificationCode(db, {
      ...base,
      shareId,
      codeHash: 'a'.repeat(64),
      challenge: 'c1',
    });
    const args = { shareId, email: base.email, challenge: 'c1' };
    for (let i = 0; i < 5; i++)
      await checkEmailVerificationCode(db, { ...args, codeHash: 'f'.repeat(64) });
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: 'a'.repeat(64) })).toBe('bad');
  });

  it('a second code on the same challenge retires the first (the old UNIQUE bug)', async () => {
    const shareId = 'share-v';
    await issueEmailVerificationCode(db, {
      ...base,
      shareId,
      codeHash: '1'.repeat(64),
      challenge: 'c1',
    });
    await issueEmailVerificationCode(db, {
      ...base,
      shareId,
      codeHash: '2'.repeat(64),
      challenge: 'c1',
    });
    const args = { shareId, email: base.email, challenge: 'c1' };
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: '1'.repeat(64) })).toBe('bad');
    expect(await checkEmailVerificationCode(db, { ...args, codeHash: '2'.repeat(64) })).toBe('ok');
  });

  it('a code is bound to its challenge', async () => {
    await issueEmailVerificationCode(db, {
      ...base,
      shareId: 'share-v',
      codeHash: 'a'.repeat(64),
      challenge: 'c1',
    });
    expect(
      await checkEmailVerificationCode(db, {
        shareId: 'share-v',
        email: base.email,
        challenge: 'other',
        codeHash: 'a'.repeat(64),
      }),
    ).toBe('bad');
  });

  it('limits a link+address to three codes per 15 minutes', async () => {
    const shareId = 'share-v';
    for (let i = 0; i < 3; i++) {
      expect(
        await issueEmailVerificationCode(db, {
          ...base,
          shareId,
          codeHash: 'a'.repeat(64),
          challenge: `c${i}`,
        }),
      ).toBe('ok');
    }
    expect(
      await issueEmailVerificationCode(db, {
        ...base,
        shareId,
        codeHash: 'a'.repeat(64),
        challenge: 'c9',
      }),
    ).toBe('rate_limited');
  });

  it('a refused address does not spend its own budget', async () => {
    const shareId = 'share-v';
    for (let i = 0; i < 5; i++) {
      await issueEmailVerificationCode(db, {
        ...base,
        permitted: false,
        ipHash: `ip${i}`,
        shareId,
        codeHash: 'a'.repeat(64),
        challenge: `c${i}`,
      });
    }
    expect(
      await issueEmailVerificationCode(db, {
        ...base,
        shareId,
        codeHash: 'a'.repeat(64),
        challenge: 'real',
      }),
    ).toBe('ok');
  });

  it('refuses on a share without the verified gate', async () => {
    expect(
      await issueEmailVerificationCode(db, {
        ...base,
        shareId: 'share-plain',
        codeHash: 'a'.repeat(64),
        challenge: 'c',
      }),
    ).toBe('not_enabled');
    expect(
      await issueEmailVerificationCode(db, {
        ...base,
        shareId: 'missing',
        codeHash: 'a'.repeat(64),
        challenge: 'c',
      }),
    ).toBe('no_share');
  });
});

describe('startSession', () => {
  it('opens a session for a fingerprinted reader and counts return visits', async () => {
    seedShare(db, { slug: 'open' });
    const a = await start('open');
    expect(a.document_id).toBe(DOC.id);
    expect(a.document_version).toBe(1);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    await start('open');
    const viewers = db.rows(`SELECT visit_count, country_code FROM viewers`);
    expect(viewers).toEqual([{ visit_count: 2, country_code: 'DE' }]);
    expect(db.rows(`SELECT count(*) AS n FROM sessions`)).toEqual([{ n: 2 }]);
  });

  it('keeps the P-codes the tracker maps to messages', async () => {
    seedShare(db, { slug: 'gated', require_email: true, allowed_email_domains: ['acme.com'] });
    seedShare(db, { slug: 'revoked', revoked_at: '2026-01-01T00:00:00Z' });
    seedShare(db, { slug: 'expired', expires_at: '2020-01-01T00:00:00Z' });
    expect(await code(start('missing'))).toBe('P0002');
    expect(await code(start('revoked'))).toBe('P0003');
    expect(await code(start('expired'))).toBe('P0004');
    expect(await code(start('gated'))).toBe('P0005');
    expect(await code(start('gated', { p_email: 'not-an-email' }))).toBe('P0006');
    expect(await code(start('gated', { p_email: 'x@other.com' }))).toBe('P0007');
    expect(await code(start('gated', { p_email: 'x@acme.com' }))).toBe('ok');
  });

  it('refuses a deleted document with P0008', async () => {
    seedShare(db, { slug: 'open' });
    db.rows(`UPDATE documents SET deleted_at = '2026-01-01T00:00:00Z'`);
    expect(await code(start('open'))).toBe('P0008');
  });

  it('matches e-mail viewers case-insensitively and marks the owner internal', async () => {
    seedShare(db, { slug: 'gated', require_email: true });
    await start('gated', { p_email: 'Reader@Acme.com' });
    await start('gated', { p_email: 'reader@acme.com', p_fingerprint: 'fp-2' });
    await start('gated', { p_email: OWNER.email.toUpperCase() });
    expect(db.rows(`SELECT email, visit_count, is_internal FROM viewers ORDER BY email`)).toEqual([
      { email: 'reader@acme.com', visit_count: 2, is_internal: 0 },
      { email: OWNER.email, visit_count: 1, is_internal: 1 },
    ]);
  });

  it('an address on allowed_emails is tracked even when its domain is not listed', async () => {
    seedShare(db, {
      slug: 'mixed',
      require_email: true,
      allowed_email_domains: ['somnia.network'],
      allowed_emails: ['VC@fund.com'],
    });
    expect(await code(start('mixed', { p_email: 'vc@FUND.com' }))).toBe('ok');
    expect(await code(start('mixed', { p_email: 'ann@somnia.network' }))).toBe('ok');
    expect(await code(start('mixed', { p_email: 'x@fund.com' }))).toBe('P0007');
  });

  it('rate-limits one identity to five starts a minute', async () => {
    seedShare(db, { slug: 'open' });
    for (let i = 0; i < 5; i++) await start('open');
    expect(await code(start('open'))).toBe('P0001');
    expect(await code(start('open', { p_fingerprint: 'fp-other' }))).toBe('ok');
  });
});

describe('updateSession and the first-read alert', () => {
  const upd = (sid: string, token: string, over: Record<string, unknown> = {}) =>
    updateSession(db, {
      p_session_id: sid,
      p_token: token,
      p_active_seconds: 0,
      p_max_scroll: 0,
      p_sections: [],
      ...over,
    });

  it('refuses a wrong token', async () => {
    seedShare(db, { slug: 'open' });
    const s = await start('open');
    expect(await code(upd(s.session_id, 'f'.repeat(64)))).toBe('P0010');
  });

  it('never lowers the figures and upserts per-slide time', async () => {
    seedShare(db, { slug: 'open' });
    const s = await start('open');
    await upd(s.session_id, s.token, {
      p_active_seconds: 40,
      p_max_scroll: 0.6,
      p_sections: [
        { section_id: 'slide-1', section_title: 'Why', time_seconds: 12, ordinal: 0 },
        { section_id: 'slide-2', section_title: 'Product', time_seconds: 20, ordinal: 1 },
      ],
    });
    await upd(s.session_id, s.token, {
      p_active_seconds: 10,
      p_max_scroll: 0.2,
      p_sections: [
        { section_id: 'slide-1', time_seconds: 5 },
        { section_id: 'slide-3', time_seconds: 3 },
      ],
    });
    expect(db.rows(`SELECT active_time_seconds, max_scroll_depth FROM sessions`)).toEqual([
      { active_time_seconds: 40, max_scroll_depth: 0.6 },
    ]);
    expect(
      db.rows(
        `SELECT section_id, section_title, time_seconds FROM section_events ORDER BY section_id`,
      ),
    ).toEqual([
      { section_id: 'slide-1', section_title: 'Why', time_seconds: 12 },
      { section_id: 'slide-2', section_title: 'Product', time_seconds: 20 },
      { section_id: 'slide-3', section_title: null, time_seconds: 3 },
    ]);
  });

  it('no alert on an evidence-free heartbeat, one on the first evidence, none after', async () => {
    seedShare(db, { slug: 'open' });
    const s = await start('open');
    expect((await upd(s.session_id, s.token)).alert).toBeNull();
    const first = await upd(s.session_id, s.token, { p_active_seconds: 8 });
    expect(first.alert).toMatchObject({
      ownerEmail: OWNER.email,
      telegramChatId: '12345',
      documentTitle: DOC.title,
      slug: 'open',
      viewerCountry: 'DE',
      viewerCity: 'Berlin',
    });
    expect((await upd(s.session_id, s.token, { p_active_seconds: 30 })).alert).toBeNull();
    expect(db.rows(`SELECT notification_sent_at IS NOT NULL AS sent FROM sessions`)).toEqual([
      { sent: 1 },
    ]);
  });

  it('section dwell alone counts as evidence (container-scrolled decks)', async () => {
    seedShare(db, { slug: 'open' });
    const s = await start('open');
    const r = await upd(s.session_id, s.token, {
      p_sections: [{ section_id: 'slide-1', time_seconds: 4 }],
    });
    expect(r.alert).not.toBeNull();
  });

  it('a returning reader on the same document is not announced twice', async () => {
    seedShare(db, { slug: 'a' });
    seedShare(db, { slug: 'b' });
    const s1 = await start('a');
    expect((await upd(s1.session_id, s1.token, { p_active_seconds: 5 })).alert).not.toBeNull();
    // Same fingerprint, the other link to the same document.
    const s2 = await start('b');
    expect((await upd(s2.session_id, s2.token, { p_active_seconds: 5 })).alert).toBeNull();
    expect(db.rows(`SELECT status, error_message FROM notifications_log`)).toEqual([
      { status: 'skipped', error_message: 'repeat open by same recipient on this document' },
    ]);
  });

  it('two sessions of one reader reporting at once announce once (review, 21 Sep)', async () => {
    seedShare(db, { slug: 'a' });
    const s1 = await start('a');
    const s2 = await start('a');
    const [r1, r2] = await Promise.all([
      upd(s1.session_id, s1.token, { p_active_seconds: 5 }),
      upd(s2.session_id, s2.token, { p_active_seconds: 5 }),
    ]);
    expect([r1.alert, r2.alert].filter(Boolean)).toHaveLength(1);
  });

  it('skips when the share has alerts off, and for the owner reading their own link', async () => {
    seedShare(db, { slug: 'quiet', notify_first_open: false });
    seedShare(db, { slug: 'gated', require_email: true });
    const q = await start('quiet');
    expect((await upd(q.session_id, q.token, { p_active_seconds: 5 })).alert).toBeNull();
    const o = await start('gated', { p_email: OWNER.email });
    expect((await upd(o.session_id, o.token, { p_active_seconds: 5 })).alert).toBeNull();
    expect(
      db.rows(`SELECT error_message FROM notifications_log ORDER BY created_at, error_message`),
    ).toEqual([
      { error_message: 'first-open alert disabled on this share' },
      { error_message: 'viewer marked internal' },
    ]);
  });

  it('recordNotification writes a log row', async () => {
    seedShare(db, { slug: 'open' });
    const s = await start('open');
    await recordNotification(db, s.session_id, 'telegram', '12345', 'delivered');
    expect(db.rows(`SELECT kind, channel, email_to, status FROM notifications_log`)).toEqual([
      { kind: 'first_read', channel: 'telegram', email_to: '12345', status: 'delivered' },
    ]);
  });
});
