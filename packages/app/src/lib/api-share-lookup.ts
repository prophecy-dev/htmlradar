// Finding one of the caller's own shares from whatever they typed: the id, the
// slug, or the whole link. One place, so the activity and revoke routes cannot
// disagree about what counts as the same share.

import { getShare, getShareBySlug } from '@htmlradar/db/owner';
import type { ShareRow } from '@htmlradar/db';
import { SHARE_SLUG_PATTERN } from './share-slug';
import { db } from './cf';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Any host is accepted in front of /r/{slug}: the host is never used to find
// anything, and the slug is only looked up inside the caller's own shares.
const LINK = /^(?:(?:https?:\/\/)?[a-z0-9.-]+(?::\d+)?)?\/r\/([^/?#]+)\/?(?:[?#].*)?$/i;

/** The slug in what the caller passed, or null. */
export function slugOf(raw: string): string | null {
  const candidate = (LINK.exec(raw.trim())?.[1] ?? raw.trim()).toLowerCase();
  return SHARE_SLUG_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The caller's share, by id, slug or link — or null. Null covers "no such
 * share", "malformed" and "somebody else's" alike.
 */
export async function findOwnedShare(userId: string, idOrSlug: string): Promise<ShareRow | null> {
  const raw = idOrSlug.trim();
  if (UUID.test(raw)) return getShare(db(), userId, raw.toLowerCase());
  const slug = slugOf(raw);
  return slug ? getShareBySlug(db(), userId, slug) : null;
}
