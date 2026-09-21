'use client';

// Privy (and the wallet libraries it pulls in) only ever runs in the browser.
// Loading it with ssr: false keeps it out of the Worker bundle.

import dynamic from 'next/dynamic';

const PrivyLogin = dynamic(() => import('./PrivyLogin'), {
  ssr: false,
  loading: () => <div className="mt-8 h-10" />,
});

export function LoginClient(props: { appId: string; next: string }) {
  return <PrivyLogin {...props} />;
}
