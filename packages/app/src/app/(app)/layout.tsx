import type { ReactNode } from 'react';
import { NavBar } from '@/components/NavBar';
import { TimezoneSync } from '@/components/TimezoneSync';

// The middleware refuses anyone Cloudflare Access did not sign in. Pages that
// need the user object call `requireUser()` themselves.
//
// TimezoneSync runs once on mount and writes the browser's IANA timezone
// to profiles.timezone, which first-read alerts use for local times.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <NavBar app />
      <TimezoneSync />
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </>
  );
}
