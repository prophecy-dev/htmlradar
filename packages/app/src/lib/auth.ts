import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureProfile } from '@htmlradar/db/owner';
import type { Profile } from '@htmlradar/db';
import { SESSION_COOKIE, resolveAccessEmail } from './access';
import { db, envVar } from './cf';

/** The signed-in user's profile, created on first visit, or null. */
export async function getCurrentUser(): Promise<Profile | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const result = await resolveAccessEmail(cookie, envVar);
  if (!result.ok) return null;
  return ensureProfile(db(), result.email);
}

/** Same, for pages and actions that cannot run without a user. */
export async function requireUser(): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}
