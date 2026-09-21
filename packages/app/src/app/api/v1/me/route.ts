// GET /api/v1/me — the cheap "is this key good?" call. The MCP server hits it
// once at startup so a bad key fails at setup, not mid-send. Internal build:
// there are no plans or link caps, so free_links_cap is always null.

import type { NextRequest } from 'next/server';
import { countShares } from '@htmlradar/db/owner';
import { authenticateApiKey, json } from '@/lib/api-auth';
import { db } from '@/lib/cf';

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req, { name: 'me', max: 60 });
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  return json({
    user_id: caller.userId,
    email: caller.email,
    tier: 'internal',
    scope: caller.scope,
    free_links_used: await countShares(db(), caller.userId),
    free_links_cap: null,
  });
}
