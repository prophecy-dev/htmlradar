// "Link preview" on /docs/[id]: the card Slack, Telegram, LinkedIn and
// iMessage show when a share URL is pasted. The proxy serves these values to
// unfurl bots (and never counts those fetches as reads). A plain server form:
// nothing here needs client state.

export function LinkPreviewForm({
  documentId,
  title,
  description,
  hasImage,
  action,
}: {
  documentId: string;
  title: string;
  description: string | null;
  hasImage: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="rounded-2xl border border-line bg-paper px-5 py-5">
      <h2 className="font-serif text-[18px] text-ink">Link preview</h2>
      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-soft">
        What chat apps and email clients show when someone pastes one of this document’s links.
        Applies to every share link of this document.
      </p>
      <form action={action} className="mt-4 grid gap-4" encType="multipart/form-data">
        <input type="hidden" name="document_id" value={documentId} />
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-ink">Title</span>
          <input
            name="title"
            defaultValue={title}
            maxLength={200}
            className="rounded-md border border-line bg-paper px-3 py-2 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-signal"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-ink">Description</span>
          <textarea
            name="og_description"
            defaultValue={description ?? ''}
            maxLength={300}
            rows={2}
            placeholder="One line on why the recipient should open it."
            className="rounded-md border border-line bg-paper px-3 py-2 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-signal"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-ink">
            Image {hasImage ? '(one is set — upload to replace)' : ''}
          </span>
          <input
            type="file"
            name="og_image"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="text-[13px] text-ink-soft"
          />
          <span className="text-[12px] text-graphite">
            1200×630 works everywhere. PNG, JPEG, WebP or GIF, under 5 MB.
          </span>
        </label>
        {hasImage && (
          <label className="flex items-center gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" name="remove_og_image" />
            Remove the current image
          </label>
        )}
        <div>
          <button
            type="submit"
            className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90"
          >
            Save link preview
          </button>
        </div>
      </form>
    </section>
  );
}
