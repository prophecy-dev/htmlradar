export default function Forbidden() {
  return (
    <div className="mx-auto max-w-xl px-6 py-24">
      <h1 className="font-serif text-[32px] text-ink">Not signed in.</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
        HTMLRadar here is for Somnia staff and sits behind Cloudflare Access. Open it through the
        company sign-in, with an allowed e-mail address.
      </p>
    </div>
  );
}
