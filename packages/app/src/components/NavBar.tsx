// App header. Everyone who sees it is signed in (Privy e-mail, lib/access.ts).

import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { Logo } from './Logo';
import { SignOutButton } from './SignOutButton';

export async function NavBar(_props: { app?: boolean } = {}) {
  const user = await getCurrentUser();
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-paper/85 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Logo href="/docs" />
        <nav className="flex items-center gap-7 text-sm">
          <Link href="/docs" className="text-ink-soft hover:text-signal-dark">
            Documents
          </Link>
          <Link href="/new" className="text-ink-soft hover:text-signal-dark">
            New
          </Link>
          <Link href="/convert" className="text-ink-soft hover:text-signal-dark">
            PDF → HTML
          </Link>
          <Link href="/settings" className="text-graphite hover:text-signal-dark">
            {user?.email ?? 'Settings'}
          </Link>
          <SignOutButton />
        </nav>
      </div>
    </header>
  );
}
