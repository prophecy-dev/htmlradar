'use client';

import type { ReactNode } from 'react';

// Ends the dashboard session (the cookie from /api/auth/session). The Privy
// session in this browser stays; /login uses it to sign straight back in.
export function SignOutButton({
  className = 'text-ink-soft hover:text-signal-dark',
  children = 'Sign out',
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await fetch('/api/auth/session', { method: 'DELETE' });
        window.location.assign('/login');
      }}
    >
      {children}
    </button>
  );
}
