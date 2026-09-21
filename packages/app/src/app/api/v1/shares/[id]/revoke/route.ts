// POST /api/v1/shares/{id}/revoke — switch a link off, or back on.
// Body: { "revoked": true | false } (default true). {id} is the share id, its
// slug, or the whole link. There is no delete: revoking is reversible.

import type { NextRequest } from 'next/server';
import { getShare, revokeShare, toggleShareRevoked } from '@htmlradar/db/owner';
import {
  authenticateApiKey,
  CHEAP_MAX,
  json,
  notFound,
  readJsonObject,
  validationError,
} from '@/lib/api-auth';
import { findOwnedShare } from '@/lib/api-share-lookup';
import { db } from '@/lib/cf';
import { shareUrl } from '@/lib/share-url';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateApiKey(req, { name: 'revoke', max: CHEAP_MAX, write: true });
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  let revoked = true;
  if (req.headers.get('content-type')?.includes('json')) {
    const parsed = await readJsonObject(req);
    if ('error' in parsed) return parsed.error;
    const value = parsed.body['revoked'];
    if (value !== undefined && typeof value !== 'boolean') {
      return validationError('"revoked" must be a boolean.');
    }
    revoked = value ?? true;
  }

  const share = await findOwnedShare(caller.userId, decodeURIComponent(params.id));
  if (!share) return notFound();

  const d = db();
  if (revoked && !share.revoked_at) await revokeShare(d, caller.userId, share.id);
  if (!revoked && share.revoked_at) await toggleShareRevoked(d, caller.userId, share.id);
  const after = await getShare(d, caller.userId, share.id);

  return json({
    share_id: share.id,
    url: shareUrl(share.slug),
    revoked: !!after?.revoked_at,
    revoked_at: after?.revoked_at ?? null,
  });
}
