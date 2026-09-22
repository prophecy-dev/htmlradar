// Comments from verified readers: who may leave one, and what the owner reads
// back. The gate is the whole feature, so most of this file is about refusals.

import { beforeEach, describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from './d1-fake.js';
import { DOC, OWNER, seedOwnerAndDoc, seedShare } from './seed.js';
import {
  RpcFailure,
  addComment,
  checkEmailVerificationCode,
  issueEmailVerificationCode,
  startSession,
  type AddCommentInput,
} from '../src/public.js';
import { listComments } from '../src/owner.js';

const READER = 'Reader@Acme.com';
const CODE = 'a'.repeat(64);

let db: ReturnType<typeof fakeD1>;

beforeEach(() => {
  db = fakeD1();
  seedOwnerAndDoc(db as FakeD1, { telegram: '4242' });
});

/** A reading session on a link of the given kind, with no verification done. */
async function reading(
  slug: string,
  opts: { verify_email?: boolean; revoked_at?: string } = {},
): Promise<{ session_id: string; token: string; share_id: string }> {
  const shareId = seedShare(db, { slug, require_email: true, ...opts });
  const s = await startSession(db, {
    p_share_slug: slug,
    p_email: READER,
    p_fingerprint: null,
    p_referrer: null,
    p_user_agent: null,
  });
  return { ...s, share_id: shareId };
}

/** The same, through the real code flow, so the reader is verified on THIS link. */
async function verifiedReading(
  slug = 'v',
): Promise<{ session_id: string; token: string; share_id: string }> {
  const shareId = seedShare(db, { slug, require_email: true, verify_email: true });
  const args = { shareId, email: READER, codeHash: CODE, challenge: 'c1' };
  await issueEmailVerificationCode(db, { ...args, ipHash: null, permitted: true });
  await checkEmailVerificationCode(db, args);
  const s = await startSession(db, {
    p_share_slug: slug,
    p_email: READER,
    p_fingerprint: null,
    p_referrer: null,
    p_user_agent: null,
  });
  return { ...s, share_id: shareId };
}

const comment = (over: Partial<AddCommentInput> & { p_session_id: string; p_token: string }) =>
  addComment(db, {
    p_section_id: null,
    p_section_title: null,
    p_body: 'The pricing page is the one I need to show my board.',
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

describe('addComment', () => {
  it('stores a verified reader’s note and hands back what the owner is told', async () => {
    const s = await verifiedReading();
    const r = await comment({
      p_session_id: s.session_id,
      p_token: s.token,
      p_section_id: 'why-now',
      p_section_title: 'Why now',
    });
    expect(r.ok).toBe(true);
    expect(r.alert).toMatchObject({
      ownerEmail: OWNER.email,
      telegramChatId: '4242',
      documentId: DOC.id,
      documentTitle: DOC.title,
      slug: 'v',
      viewerEmail: 'reader@acme.com',
      sectionTitle: 'Why now',
    });
    expect(
      db.rows(
        `SELECT document_id, share_id, section_id, section_title, body FROM document_comments`,
      ),
    ).toEqual([
      {
        document_id: DOC.id,
        share_id: s.share_id,
        section_id: 'why-now',
        section_title: 'Why now',
        body: 'The pricing page is the one I need to show my board.',
      },
    ]);
  });

  it('takes a comment on the whole document, with no section on it', async () => {
    const s = await verifiedReading();
    await comment({ p_session_id: s.session_id, p_token: s.token });
    expect(db.rows(`SELECT section_id, section_title FROM document_comments`)).toEqual([
      { section_id: null, section_title: null },
    ]);
  });

  it('refuses a wrong token, and an unknown session, as invalid', async () => {
    const s = await verifiedReading();
    expect(await code(comment({ p_session_id: s.session_id, p_token: 'f'.repeat(64) }))).toBe(
      'P0010',
    );
    expect(await code(comment({ p_session_id: 'no-such-session', p_token: s.token }))).toBe(
      'P0010',
    );
    expect(db.rows(`SELECT count(*) AS n FROM document_comments`)).toEqual([{ n: 0 }]);
  });

  it('refuses a reader on a verified link who has not proved their address', async () => {
    const s = await reading('unproved', { verify_email: true });
    expect(await code(comment({ p_session_id: s.session_id, p_token: s.token }))).toBe('P0012');
  });

  it('refuses a reader whose code was proved on a sibling link of the same document', async () => {
    await verifiedReading('other');
    const s = await reading('this-one', { verify_email: true });
    expect(await code(comment({ p_session_id: s.session_id, p_token: s.token }))).toBe('P0012');
  });

  it('refuses on a link that never asks for a code', async () => {
    const s = await reading('plain');
    expect(await code(comment({ p_session_id: s.session_id, p_token: s.token }))).toBe('P0011');
  });

  it('refuses once the sender revokes the link mid-read', async () => {
    const s = await verifiedReading();
    db.rows(
      `UPDATE document_shares SET revoked_at = '2026-09-22T12:00:00.000Z' WHERE id = ?`,
      s.share_id,
    );
    expect(await code(comment({ p_session_id: s.session_id, p_token: s.token }))).toBe('P0003');
  });

  it('refuses an empty body, and one that is only whitespace', async () => {
    const s = await verifiedReading();
    const args = { p_session_id: s.session_id, p_token: s.token };
    expect(await code(comment({ ...args, p_body: '' }))).toBe('P0013');
    expect(await code(comment({ ...args, p_body: '   \n  ' }))).toBe('P0013');
  });

  it('trims a body past the ceiling instead of losing the whole note', async () => {
    const s = await verifiedReading();
    await comment({ p_session_id: s.session_id, p_token: s.token, p_body: 'x'.repeat(2500) });
    expect(db.rows(`SELECT length(body) AS n FROM document_comments`)).toEqual([{ n: 2000 }]);
  });

  it('rate-limits one session to five comments in ten minutes', async () => {
    const s = await verifiedReading();
    const args = { p_session_id: s.session_id, p_token: s.token };
    for (let i = 0; i < 5; i++) await comment(args);
    expect(await code(comment(args))).toBe('P0001');
    expect(db.rows(`SELECT count(*) AS n FROM document_comments`)).toEqual([{ n: 5 }]);
  });
});

describe('listComments', () => {
  it('gives the owner every comment newest first, with the reader’s address', async () => {
    const s = await verifiedReading();
    await comment({ p_session_id: s.session_id, p_token: s.token, p_body: 'First.' });
    await comment({
      p_session_id: s.session_id,
      p_token: s.token,
      p_section_title: 'Pricing',
      p_body: 'Second.',
    });
    // Both land in the same millisecond here; the order is what the index
    // promises, so give them distinct times rather than testing the tie.
    db.rows(
      `UPDATE document_comments SET created_at = '2026-09-22T09:00:00.000Z' WHERE body = 'First.'`,
    );
    db.rows(
      `UPDATE document_comments SET created_at = '2026-09-22T11:00:00.000Z' WHERE body = 'Second.'`,
    );

    const rows = await listComments(db, OWNER.id, { documentId: DOC.id });
    expect(rows.map((r) => [r.body, r.section_title, r.viewer_email])).toEqual([
      ['Second.', 'Pricing', 'reader@acme.com'],
      ['First.', null, 'reader@acme.com'],
    ]);
    expect(rows[0]?.read_at).toBeNull();
  });

  it('is scoped to the owner, and to one link when asked', async () => {
    const s = await verifiedReading('v');
    await comment({ p_session_id: s.session_id, p_token: s.token });
    expect(await listComments(db, 'someone-else', { documentId: DOC.id })).toEqual([]);
    expect(await listComments(db, OWNER.id, { shareId: s.share_id })).toHaveLength(1);
    expect(await listComments(db, OWNER.id, { shareId: 'share-other' })).toEqual([]);
  });

  it('drops out with the document the moment it is deleted', async () => {
    const s = await verifiedReading();
    await comment({ p_session_id: s.session_id, p_token: s.token });
    db.rows(`UPDATE documents SET deleted_at = '2026-09-22T12:00:00.000Z'`);
    expect(await listComments(db, OWNER.id, { documentId: DOC.id })).toEqual([]);
  });
});
