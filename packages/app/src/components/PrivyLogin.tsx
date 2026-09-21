'use client';

// Privy e-mail login for the dashboard. Once Privy has signed the user in, the
// identity token goes to /api/auth/session, which checks the address and sets
// our session cookie. Anyone refused there is signed out of Privy again, so
// they can try another address.

import { PrivyProvider, useIdentityToken, useLogin, usePrivy } from '@privy-io/react-auth';
import { useEffect, useRef, useState } from 'react';

export default function PrivyLogin({
  appId,
  next,
  signout,
}: {
  appId: string;
  next: string;
  signout: boolean;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } },
        appearance: { theme: 'light', showWalletLoginFirst: false },
      }}
    >
      <LoginFlow next={next} signout={signout} />
    </PrivyProvider>
  );
}

// How long to wait for Privy's identity token once signed in. It never comes
// when "Return user data in an identity token" is off in the Privy dashboard.
const TOKEN_WAIT_MS = 8000;

function LoginFlow({ next, signout }: { next: string; signout: boolean }) {
  const { ready, authenticated, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { login } = useLogin();
  const [error, setError] = useState<string | null>(null);
  // After Sign out, end the Privy session before anything signs back in.
  const [signingOut, setSigningOut] = useState(signout);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!signingOut || !ready) return;
    void (async () => {
      try {
        if (authenticated) await logout();
      } finally {
        window.history.replaceState(null, '', '/login');
        setSigningOut(false);
      }
    })();
  }, [signingOut, ready, authenticated, logout]);

  useEffect(() => {
    if (signingOut || !ready || !authenticated || identityToken) return;
    const t = setTimeout(() => {
      setError('Privy signed you in but sent no identity token. Sign-in is misconfigured.');
      void logout();
    }, TOKEN_WAIT_MS);
    return () => clearTimeout(t);
  }, [signingOut, ready, authenticated, identityToken, logout]);

  useEffect(() => {
    if (signingOut || !ready || !authenticated || !identityToken) return;
    if (sent.current === identityToken) return;
    sent.current = identityToken;
    void (async () => {
      let message = 'Sign-in failed. Try again.';
      try {
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
        if (body.error === 'email_not_allowed') {
          message = `${body.email ?? 'That address'} is not a Somnia staff address.`;
        } else if (body.error === 'not_configured') {
          message = 'Sign-in is not configured on this deployment.';
        }
      } catch {
        // network error: the generic message
      }
      setError(message);
      sent.current = null;
      await logout();
    })();
  }, [signingOut, ready, authenticated, identityToken, next, logout]);

  const busy = !ready || signingOut || authenticated;
  return (
    <div className="mt-8">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError(null);
          login({ loginMethods: ['email'] });
        }}
        className="rounded-md bg-ink px-5 py-2.5 text-sm text-paper hover:bg-signal-dark disabled:opacity-50"
      >
        {signingOut ? 'Signing out…' : authenticated ? 'Signing in…' : 'Sign in with e-mail'}
      </button>
      {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
    </div>
  );
}
