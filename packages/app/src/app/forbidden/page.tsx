import { SignOutButton } from '@/components/SignOutButton';

export default function Forbidden() {
  return (
    <div className="mx-auto max-w-xl px-6 py-24">
      <h1 className="font-serif text-[32px] text-ink">Not allowed.</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
        HTMLRadar here is for Somnia staff. Sign in with your Somnia e-mail address.
      </p>
      <div className="mt-8 text-sm">
        <SignOutButton />
      </div>
    </div>
  );
}
