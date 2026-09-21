'use client';

import type { ReactNode } from 'react';

// Ends the dashboard session (the cookie from /api/auth/session), then lets
// /login?signout=1 end the Privy session too; otherwise /login would sign the
// same person straight back in.
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
        window.location.assign('/login?signout=1');
      }}
    >
      {children}
    </button>
  );
}
