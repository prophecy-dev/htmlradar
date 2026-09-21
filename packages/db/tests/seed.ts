// Minimal rows for tests: one sender, one uploaded document, and shares made
// to order.

import type { FakeD1 } from './d1-fake.js';

export const OWNER = { id: 'owner-1', email: 'sender@hive.land', display_name: 'Sam Sender' };
export const DOC = {
  id: 'doc-1',
  title: 'Hivemarket — AI sales deck',
  r2_key: 'docs/owner-1/doc-1.html',
};

export function seedOwnerAndDoc(db: FakeD1, opts: { telegram?: string } = {}): void {
  db.rows(
    `INSERT INTO profiles (id, email, display_name, telegram_chat_id) VALUES (?, ?, ?, ?)`,
    OWNER.id,
    OWNER.email,
    OWNER.display_name,
    opts.telegram ?? null,
  );
  db.rows(
    `INSERT INTO documents (id, owner_id, title, source_type, r2_key, og_description)
     VALUES (?, ?, ?, 'upload', ?, 'Per-slide read tracking')`,
    DOC.id,
    OWNER.id,
    DOC.title,
    DOC.r2_key,
  );
}

export interface ShareOpts {
  id?: string;
  slug: string;
  require_email?: boolean;
  verify_email?: boolean;
  password_hash?: string | null;
  allowed_email_domains?: string[] | null;
  allowed_emails?: string[] | null;
  notify_first_open?: boolean;
  revoked_at?: string | null;
  expires_at?: string | null;
  document_id?: string;
}

export function seedShare(db: FakeD1, o: ShareOpts): string {
  const id = o.id ?? `share-${o.slug}`;
  db.rows(
    `INSERT INTO document_shares
       (id, document_id, owner_id, slug, require_email, verify_email, require_password,
        password_hash, allowed_email_domains, allowed_emails, notify_first_open, revoked_at,
        expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    o.document_id ?? DOC.id,
    OWNER.id,
    o.slug,
    o.require_email ? 1 : 0,
    o.verify_email ? 1 : 0,
    o.password_hash ? 1 : 0,
    o.password_hash ?? null,
    o.allowed_email_domains ? JSON.stringify(o.allowed_email_domains) : null,
    o.allowed_emails ? JSON.stringify(o.allowed_emails) : null,
    o.notify_first_open === false ? 0 : 1,
    o.revoked_at ?? null,
    o.expires_at ?? null,
  );
  return id;
}
