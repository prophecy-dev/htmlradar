import { LoginClient } from '@/components/LoginClient';
import { allowedDomains } from '@/lib/access';
import { envVar } from '@/lib/cf';
import { safeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; signout?: string }>;
}) {
  const { next: rawNext, signout } = await searchParams;
  // Never land back on /login (it would sign in again, forever) or on an API route.
  const target = safeNext(rawNext);
  const next = /^\/(login|api)(\/|\?|$)/.test(target) ? '/docs' : target;
  const appId = envVar('PRIVY_APP_ID');
  const domains = allowedDomains(envVar)
    .split(',')
    .map((d) => d.trim().replace(/^@/, ''))
    .filter(Boolean);
  return (
    <div className="mx-auto max-w-md px-6 py-24">
      <h1 className="font-serif text-[32px] text-ink">Sign in</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
        HTMLRadar here is for Somnia staff. Sign in with your{' '}
        {domains.map((d) => `@${d}`).join(' or ')} Google account, or with that e-mail and a
        one-time code.
      </p>
      {appId ? (
        <LoginClient appId={appId} next={next} signout={signout === '1'} />
      ) : (
        <p className="mt-8 text-[14px] text-ink-soft">
          Sign-in is not configured (PRIVY_APP_ID is not set).
        </p>
      )}
    </div>
  );
}
