import type { Metadata } from 'next';
import { NavBar } from '@/components/NavBar';
import { createStagedDocument } from '@/app/(app)/new/actions';
import { ConvertPanel } from './ConvertPanel';

export const metadata: Metadata = { title: 'PDF deck to HTML' };

// Behind the dashboard sign-in like every other page, so the visitor is always
// signed in: the converted deck can go straight to a tracked link.
export default async function ConvertPage({
  searchParams,
}: {
  searchParams: Promise<{ resume?: string }>;
}) {
  const resumeToken = (await searchParams).resume ?? null;
  return (
    <>
      <NavBar />
      <main className="mx-auto max-w-[880px] px-4 pb-16 pt-12 md:pb-20">
        <h1 className="text-letterpress font-serif text-[40px] font-normal leading-[1.05] tracking-tightest text-ink md:text-[48px]">
          Turn a PDF deck into an HTML page.
        </h1>
        <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-ink-soft">
          Converts a landscape PDF (2–60 pages, up to 30 MB) into one HTML page, each slide an
          image, with a table of contents. Conversion runs in your browser. Download the file, or
          turn it straight into a tracked document.
        </p>
        <ConvertPanel action={createStagedDocument} resumeToken={resumeToken} signedIn />
      </main>
    </>
  );
}
