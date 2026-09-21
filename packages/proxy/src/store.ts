// The worker's data access: @htmlradar/db's recipient functions on the D1
// binding. Same names the Supabase helpers had, so the handlers read the same.
//
// A D1 failure becomes UpstreamError, which the fetch handler turns into the
// "try again" page rather than a "this link doesn't exist" 404 — a database
// blip must never look like a deleted share. RpcFailure (a P-code the tracker
// understands) passes through untouched.

import * as db from '@htmlradar/db/public';
import type { Env } from './env.js';

export class UpstreamError extends Error {}

export type Share = db.PublicShare;
export type Document = db.PublicDocument;
export type Attachment = db.Attachment;
export type FirstReadAlert = db.FirstReadAlert;
export { RpcFailure } from '@htmlradar/db/public';

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof db.RpcFailure) throw err;
    throw new UpstreamError(err instanceof Error ? err.message : String(err));
  }
}

export const getShareBySlug = (env: Env, slug: string): Promise<Share | null> =>
  guard(db.getShareBySlug(env.DB, slug));

export const getDocument = (env: Env, id: string): Promise<Document | null> =>
  guard(db.getDocument(env.DB, id));

export const getAttachment = (env: Env, id: string): Promise<Attachment | null> =>
  guard(db.getAttachment(env.DB, id));

export const listAttachmentsForDocument = (env: Env, documentId: string): Promise<Attachment[]> =>
  guard(db.listAttachmentsForDocument(env.DB, documentId));

export const getViewerIdByShareEmail = (
  env: Env,
  shareId: string,
  email: string,
): Promise<string | null> => guard(db.getViewerIdByShareEmail(env.DB, shareId, email));

export const logAttachmentDownload = (
  env: Env,
  p: Parameters<typeof db.logAttachmentDownload>[1],
): Promise<void> => guard(db.logAttachmentDownload(env.DB, p));

export const verifySharePassword = (
  env: Env,
  slug: string,
  password: string,
): Promise<'ok' | 'bad' | 'rate_limited'> => guard(db.checkSharePassword(env.DB, slug, password));

export const issueVerificationCode = (
  env: Env,
  p: Parameters<typeof db.issueEmailVerificationCode>[1],
): ReturnType<typeof db.issueEmailVerificationCode> =>
  guard(db.issueEmailVerificationCode(env.DB, p));

/** Every way of failing is 'bad', a database error included (see handleVerifySubmit). */
export async function checkVerificationCode(
  env: Env,
  p: Parameters<typeof db.checkEmailVerificationCode>[1],
): Promise<'ok' | 'bad'> {
  try {
    return await db.checkEmailVerificationCode(env.DB, p);
  } catch {
    return 'bad';
  }
}

export const startSession = (
  env: Env,
  input: db.StartSessionInput,
): Promise<db.StartSessionResult> => guard(db.startSession(env.DB, input));

export const updateSession = (
  env: Env,
  input: db.UpdateSessionInput,
): Promise<db.UpdateSessionResult> => guard(db.updateSession(env.DB, input));

export const recordNotification = (
  env: Env,
  ...args: Parameters<typeof db.recordNotification> extends [unknown, ...infer R] ? R : never
): Promise<void> => guard(db.recordNotification(env.DB, ...args));
