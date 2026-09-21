'use server';

// Server Action for creating a new document. Extracted into its own
// module so the form can be a Client Component with interactive toggle
// state, while keeping the action server-side.
//
// The write itself lives in lib/create-document.ts, shared with
// POST /api/v1/shares so the two paths cannot drift. What stays here is the
// form's own business: reading FormData, validating what the owner typed,
// and turning a failure into a message on /new.

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentUser, requireUser } from '@/lib/auth';
import { db } from '@/lib/cf';
import { isHtmlFile, validateSourceUrl } from '@/lib/html-source';
import type { HandoffUploadResult } from '@/lib/staged-handoff';
import { createDocumentForUser, MAX_UPLOAD_BYTES } from '@/lib/create-document';

export async function createDocument(formData: FormData) {
  const user = await requireUser();

  const sourceType = formData.get('source_type') as 'upload' | 'url';
  const title = String(formData.get('title') ?? '').trim() || 'Untitled document';

  // Redirects stay at top level: redirect() throws internally and must not be
  // swallowed by this catch.
  let docId: string | null = null;
  let errorMessage: string | null = null;
  try {
    if (sourceType === 'url') {
      const sourceUrl = String(formData.get('source_url') ?? '').trim();
      const urlError = validateSourceUrl(sourceUrl);
      if (urlError) throw new Error(urlError);
      docId = await createDocumentForUser(db(), user.id, title, {
        type: 'url',
        url: sourceUrl,
      });
    } else {
      const file = formData.get('file') as File | null;
      if (!file || file.size === 0) throw new Error('No file uploaded');
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('File exceeds 30 MB');
      if (!isHtmlFile(file.name, file.type)) {
        throw new Error('Only HTML files are supported. Rename your export to .html and retry.');
      }
      docId = await createDocumentForUser(db(), user.id, title, {
        type: 'upload',
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name || null,
      });
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : 'Upload failed.';
    console.error('[new] document create failed', e);
  }

  if (errorMessage || !docId) {
    redirect(`/new?upload_error=${encodeURIComponent(errorMessage ?? 'Upload failed.')}`);
  }

  revalidatePath('/docs');
  redirect(`/docs/${docId}`);
}

// The tools need a structured outcome: redirect() throws, and cannot tell a
// browser whether to retain its file after an uncertain network response.
export async function createStagedDocument(formData: FormData): Promise<HandoffUploadResult> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, reason: 'auth' };
    const file = formData.get('file');
    const creationId = formData.get('creation_id');
    if (
      !(file instanceof File) ||
      !file.size ||
      file.size > MAX_UPLOAD_BYTES ||
      !isHtmlFile(file.name, file.type) ||
      typeof creationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creationId)
    ) {
      return { ok: false, reason: 'invalid_file' };
    }
    const title =
      String(formData.get('title') ?? '')
        .trim()
        .slice(0, 120) || 'Untitled document';
    const documentId = await createDocumentForUser(
      db(),
      user.id,
      title,
      {
        type: 'upload',
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
      },
      creationId,
    );
    // No revalidatePath here (under next-on-pages it crashed the post-action
    // re-render of the calling page). /docs reads fresh on every request, so
    // there is nothing to revalidate.
    return { ok: true, documentId };
  } catch (e) {
    console.error('[new] staged create failed', e);
    return { ok: false, reason: 'upload_failed' };
  }
}
