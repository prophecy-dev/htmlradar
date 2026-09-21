'use client';

// Privy e-mail login for the dashboard. Once Privy has signed the user in, the
// identity token goes to /api/auth/session, which checks the address and sets
// our session cookie. Anyone refused there is signed out of Privy again, so
// they can try another address.

import { PrivyProvider, useIdentityToken, useLogin, usePrivy } from '@privy-io/react-auth';
import { useEffect, useRef, useState } from 'react';

export function LoginClient({ appId, next }: { appId: string; next: string }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } },
        appearance: { theme: 'light', showWalletLoginFirst: false },
      }}
    >
      <LoginFlow next={next} />
    </PrivyProvider>
  );
}

function LoginFlow({ next }: { next: string }) {
  const { ready, authenticated, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { login } = useLogin();
  const [error, setError] = useState<string | null>(null);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated || !identityToken || sent.current === identityToken) return;
    sent.current = identityToken;
    void (async () => {
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityToken }),
      });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; email?: string };
      setError(
        body.error === 'email_not_allowed'
          ? `${body.email ?? 'That address'} is not a Somnia staff address.`
          : body.error === 'not_configured'
            ? 'Sign-in is not configured on this deployment.'
            : 'Sign-in failed. Try again.',
      );
      await logout();
    })();
  }, [ready, authenticated, identityToken, next, logout]);

  return (
    <div className="mt-8">
      <button
        type="button"
        disabled={!ready || authenticated}
        onClick={() => {
          setError(null);
          login({ loginMethods: ['email'] });
        }}
        className="rounded-md bg-ink px-5 py-2.5 text-sm text-paper hover:bg-signal-dark disabled:opacity-50"
      >
        {authenticated ? 'Signing in…' : 'Sign in with e-mail'}
      </button>
      {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
    </div>
  );
}
