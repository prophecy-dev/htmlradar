'use server';

// (app) layout-level server actions. Currently:
//   - syncTimezoneAction: write the user's IANA timezone to
//     profiles.timezone so first-read alerts render times in their local time.

import { updateProfile } from '@htmlradar/db/owner';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/cf';

// IANA timezone names are well-formed (Area/City, sometimes nested).
const IANA_TZ_REGEX = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/;

export async function syncTimezoneAction(timezone: string): Promise<void> {
  if (typeof timezone !== 'string') return;
  const tz = timezone.trim();
  if (!tz || tz.length > 64 || !IANA_TZ_REGEX.test(tz)) return;

  const user = await requireUser();
  if (user.timezone === tz) return;
  await updateProfile(db(), user.id, { timezone: tz });
}
