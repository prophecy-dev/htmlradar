// What the readers said, newest first, on the Analytics tab of /docs/[id].
//
// Every comment here was left by somebody who proved their address with a
// one-time code, which is what makes the address above it worth reading as a
// name. Nobody else can comment: a link without the verified gate shows no box
// at all (see addComment in packages/db/src/public.ts).
//
// The section is the sender's first question — "which slide is this about?" —
// so it sits with the address rather than inside the note. The heading is the
// snapshot taken when the comment was written, so it still says what the
// reader was looking at after the document has been replaced.
//
// Renders nothing at all when there are no comments. An empty state here would
// be a prompt to chase something the owner does not control.

import { SectionHead } from '@/components/doc-dashboard/SectionHead';
import { formatTimestamp } from '@/lib/format-timestamp';
import type { ReaderComment } from '@/lib/types';

export function ReaderComments({ comments }: { comments: ReaderComment[] }) {
  if (comments.length === 0) return null;
  return (
    <section>
      <SectionHead
        title="What they said."
        hint={`${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
      />
      <ul className="space-y-3">
        {comments.map((c) => {
          const when = formatTimestamp(c.created_at, 'auto');
          return (
            <li key={c.id} className="rounded-2xl border border-line bg-paper px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[14px] font-medium text-ink">
                  {c.viewer_email ?? 'A verified reader'}
                </span>
                <span
                  title={when.full}
                  className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-graphite"
                >
                  {when.display}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-graphite">
                {c.section_title ?? 'The whole document'}
              </div>
              {/* The reader's own line breaks are part of what they wrote. */}
              <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">
                {c.body}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
