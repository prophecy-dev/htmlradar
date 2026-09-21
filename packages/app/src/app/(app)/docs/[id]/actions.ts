'use server';

// Server Actions for the document detail page. Every read and write goes
// through packages/db/src/owner.ts, which scopes each query to the signed-in
// owner, so an id guessed from another owner's page finds nothing.

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  OwnerError,
  createShare,
  deleteAttachment,
  deleteShare,
  getDocument,
  getShare,
  insertAttachment,
  listAttachments,
  recordNewVersion,
  softDeleteDocument,
  toggleShareRevoked,
  updateDocumentPreview,
  updateShare,
  setViewerInternal,
} from '@htmlradar/db/owner';
import { requireUser } from '@/lib/auth';
import { db, envVar } from '@/lib/cf';
import { verifiedGateEnabled } from '@/lib/verified-gate';
import { issueOwnerDocPreviewToken, issueOwnerPreviewToken } from '@/lib/preview-token';
import {
  deleteR2Object,
  ogImageKey,
  r2Key,
  uploadAttachment,
  uploadHtml,
  uploadObject,
} from '@/lib/r2';
import {
  MAX_ATTACHMENTS_PER_DOC,
  MAX_TOTAL_BYTES_PER_DOC,
  isValidationError,
  r2KeyForAttachment,
  validateFile,
} from '@/lib/attachments';
import { describeSlugError, validateShareSlug } from '@/lib/share-slug';
import { SHARE_BASE, shareUrl } from '@/lib/share-url';

// Shared parse for the two allowlist textareas. Both accept comma- and
// newline-separated input (people paste lists from spreadsheets); blank → null.
function parseAllowlists(formData: FormData): {
  domains: string[] | null;
  emails: string[] | null;
} {
  const split = (raw: string): string[] =>
    raw
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  const domainList = split(String(formData.get('allowed_domains') ?? ''));
  const emailList = split(String(formData.get('allowed_emails') ?? ''));
  return {
    domains: domainList.length > 0 ? domainList : null,
    emails: emailList.length > 0 ? emailList : null,
  };
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof OwnerError) return describeSlugError(e.code) ?? e.message ?? fallback;
  return e instanceof Error ? e.message : fallback;
}

// Returned when share creation fails for a reason the owner can fix. The form
// stays on screen with every field still filled in.
export type CreateShareError = { error: string; field?: 'slug' };

/**
 * Verification is stored only when the e-mail gate is on, the owner asked for
 * it, and this deploy can send a code (verifiedGateEnabled). A link that asks
 * for a code nobody can be sent is a link no reader can open.
 */
function wantsVerification(formData: FormData): boolean {
  return (
    verifiedGateEnabled() &&
    formData.get('require_email') === 'on' &&
    formData.get('verify_email') === 'on'
  );
}

/**
 * The same question for an EDIT, where "absent" must mean "leave it as it is":
 * with the capability off the form shows no control, and reading that silence
 * as false would strip verification from a link that had it.
 */
function verificationEdit(formData: FormData): boolean | null {
  return verifiedGateEnabled() ? wantsVerification(formData) : null;
}

function readExpiry(formData: FormData): string | null {
  const raw = String(formData.get('expires_at') ?? '').trim();
  return raw ? new Date(raw).toISOString() : null;
}

export async function createShareFormAction(formData: FormData): Promise<CreateShareError | void> {
  const user = await requireUser();
  const documentId = String(formData.get('document_id'));

  // redirect() throws internally, so every redirect sits outside the try.
  let slug: string | null = null;
  let errorMessage: string | null = null;
  let errorField: CreateShareError['field'];
  try {
    const requirePassword = formData.get('require_password') === 'on';
    const password = String(formData.get('password') ?? '');
    if (requirePassword && password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }

    // Blank = generate one. createShare repeats every check; this one only
    // gives the form a field-level message before touching the database.
    const chosenSlug =
      String(formData.get('slug') ?? '')
        .trim()
        .toLowerCase() || null;
    if (chosenSlug) {
      const problem = validateShareSlug(chosenSlug);
      if (problem) {
        errorField = 'slug';
        throw new Error(problem);
      }
    }

    const expiresAt = readExpiry(formData);
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      throw new Error(
        'Expiry must be in the future. Pick a later time, or leave it blank for no expiry.',
      );
    }

    const { domains, emails } = parseAllowlists(formData);
    const share = await createShare(db(), user.id, documentId, {
      slug: chosenSlug,
      recipient_label: String(formData.get('recipient_label') ?? '') || null,
      require_email: formData.get('require_email') === 'on',
      verify_email: wantsVerification(formData),
      require_password: requirePassword,
      password: requirePassword ? password : null,
      allowed_email_domains: domains,
      allowed_emails: emails,
      expires_at: expiresAt,
      lock_deck: formData.get('lock_deck') === 'on',
      notify_first_open: formData.get('notify_first_open') === 'on',
    });
    slug = share.slug;
    revalidatePath(`/docs/${documentId}`);
  } catch (e) {
    if (e instanceof OwnerError && e.code.startsWith('slug_')) errorField = 'slug';
    errorMessage = errorText(e, 'Failed to create the share.');
  }

  if (errorMessage) {
    return errorField ? { error: errorMessage, field: errorField } : { error: errorMessage };
  }
  if (slug) redirect(`/dashboard/${slug}?just_created=1`);
  redirect(`/docs/${documentId}`);
}

// One switch flips a share between active and revoked.
export async function toggleShareAction(formData: FormData) {
  const user = await requireUser();
  const shareId = String(formData.get('share_id'));
  const docId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    await toggleShareRevoked(db(), user.id, shareId);
    revalidatePath(`/docs/${docId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to update the share.');
  }

  if (errorMessage) {
    redirect(`/docs/${docId}?share_error=${encodeURIComponent(errorMessage)}`);
  }
}

// Permanently delete a share — except a link whose address the owner chose,
// which is revoked instead so the address can never be handed to another
// document. Requires the typed confirmation the client modal asks for.
export async function deleteShareAction(formData: FormData) {
  const user = await requireUser();
  const shareId = String(formData.get('share_id'));
  const docId = String(formData.get('document_id'));
  const confirmation = String(formData.get('confirmation') ?? '');

  let errorMessage: string | null = null;
  let outcome: 'deleted' | 'revoked' = 'deleted';
  try {
    if (confirmation.trim().toUpperCase() !== 'DELETE') {
      throw new Error('Type DELETE to confirm — we need the exact word.');
    }
    outcome = await deleteShare(db(), user.id, shareId);
    revalidatePath(`/docs/${docId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to delete the share.');
  }

  if (errorMessage) {
    redirect(`/docs/${docId}?share_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect(
    outcome === 'revoked' ? `/docs/${docId}?share_kept=1` : `/docs/${docId}?share_deleted=1`,
  );
}

// Edit an existing share's settings. An empty password keeps the stored hash.
export async function editShareAction(formData: FormData) {
  const user = await requireUser();
  const shareId = String(formData.get('share_id'));
  const documentId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    const requirePassword = formData.get('require_password') === 'on';
    const password = String(formData.get('password') ?? '');
    if (requirePassword && password.length > 0 && password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    const { domains, emails } = parseAllowlists(formData);

    await updateShare(db(), user.id, shareId, {
      recipient_label: String(formData.get('recipient_label') ?? '') || null,
      require_email: formData.get('require_email') === 'on',
      verify_email: verificationEdit(formData),
      require_password: requirePassword,
      password: requirePassword && password.length > 0 ? password : null,
      allowed_email_domains: domains,
      allowed_emails: emails,
      expires_at: readExpiry(formData),
      lock_deck: formData.get('lock_deck') === 'on',
      notify_first_open: formData.get('notify_first_open') === 'on',
    });
    revalidatePath(`/docs/${documentId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to update the share.');
  }

  if (errorMessage) {
    redirect(
      `/docs/${documentId}?share_error=${encodeURIComponent(errorMessage)}&edited=${shareId}`,
    );
  }
  redirect(`/docs/${documentId}?edited=${shareId}`);
}

function sessionSecret(): string {
  const secret = envVar('SESSION_SECRET');
  if (!secret) {
    throw new Error(
      'Preview is unavailable — SESSION_SECRET is not set on the app. It must match the proxy worker’s secret.',
    );
  }
  return secret;
}

// "Preview as you": a short-lived owner-preview token bound to the slug. The
// proxy verifies the HMAC and skips every recipient gate. Returns the URL for
// the client to open, because /r/* is the worker's, not a Next.js route.
export async function previewShareAction(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const shareId = String(formData.get('share_id'));
  try {
    const share = await getShare(db(), user.id, shareId);
    if (!share) throw new Error('Share not found.');
    const token = await issueOwnerPreviewToken(share.slug, sessionSecret());
    return { ok: true, url: `${shareUrl(share.slug)}?owner_preview=${encodeURIComponent(token)}` };
  } catch (e) {
    return { ok: false, error: errorText(e, 'Failed to start preview.') };
  }
}

// ------------------------------------------------------------ attachments

// Upload one or more supporting files. Caps: 25 MB per file, 20 files and
// 100 MB per document. INSERT-then-upload, rolling back the row if R2 fails.
export async function uploadAttachmentsAction(formData: FormData) {
  const user = await requireUser();
  const documentId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    const d = db();
    const doc = await getDocument(d, user.id, documentId);
    if (!doc) throw new Error('Document not found.');

    const existing = await listAttachments(d, user.id, documentId);
    const existingBytes = existing.reduce((acc, row) => acc + Number(row.size_bytes ?? 0), 0);

    const files = formData.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) throw new Error('No files selected.');
    if (existing.length + files.length > MAX_ATTACHMENTS_PER_DOC) {
      throw new Error(
        `Limit ${MAX_ATTACHMENTS_PER_DOC} files per document — you have ${existing.length}, attempted ${files.length}.`,
      );
    }

    // Validate the whole batch before any I/O.
    const validated: { file: File; filename: string; mimeType: string; size: number }[] = [];
    let addedBytes = 0;
    for (const f of files) {
      const v = validateFile(f);
      if (isValidationError(v)) throw new Error(`${v.filename}: ${v.reason}`);
      addedBytes += v.size;
      validated.push({ file: f, filename: v.filename, mimeType: v.mimeType, size: v.size });
    }
    if (existingBytes + addedBytes > MAX_TOTAL_BYTES_PER_DOC) {
      throw new Error(
        `Total size would exceed ${Math.round(MAX_TOTAL_BYTES_PER_DOC / 1024 / 1024)} MB.`,
      );
    }

    for (const v of validated) {
      const attachmentId = crypto.randomUUID();
      const key = r2KeyForAttachment(user.id, documentId, attachmentId, v.filename);
      await insertAttachment(d, {
        id: attachmentId,
        document_id: documentId,
        owner_id: user.id,
        filename: v.filename,
        mime_type: v.mimeType,
        size_bytes: v.size,
        r2_key: key,
        created_at: new Date().toISOString(),
      });
      try {
        await uploadAttachment(key, new Uint8Array(await v.file.arrayBuffer()), v.mimeType);
      } catch (uploadErr) {
        await deleteAttachment(d, user.id, attachmentId);
        throw uploadErr;
      }
    }
    revalidatePath(`/docs/${documentId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to upload attachments.');
  }

  if (errorMessage) {
    redirect(`/docs/${documentId}?attachment_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect(`/docs/${documentId}`);
}

// Row first, then the object: an orphan object is harmless, a row pointing at
// a missing file is a broken download link.
export async function deleteAttachmentAction(formData: FormData) {
  const user = await requireUser();
  const attachmentId = String(formData.get('attachment_id'));
  const documentId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    const removed = await deleteAttachment(db(), user.id, attachmentId);
    if (!removed) throw new Error('Attachment not found.');
    try {
      await deleteR2Object(removed.r2_key);
    } catch (e) {
      console.warn('[attachments] R2 orphan', removed.r2_key, e);
    }
    revalidatePath(`/docs/${documentId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to delete attachment.');
  }

  if (errorMessage) {
    redirect(`/docs/${documentId}?attachment_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect(`/docs/${documentId}`);
}

// ------------------------------------------------------------ document

// The owner's pre-share preview, bound to the document id rather than a share.
export async function previewDocumentAction(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const documentId = String(formData.get('document_id'));
  try {
    const doc = await getDocument(db(), user.id, documentId);
    if (!doc) throw new Error('Document not found.');
    if (doc.source_type !== 'upload') {
      throw new Error(
        'Preview is only available for uploaded HTML — URL-source docs open their source directly.',
      );
    }
    if (!doc.r2_key) {
      throw new Error('This document is missing its uploaded file. Re-upload the HTML to fix.');
    }
    const token = await issueOwnerDocPreviewToken(doc.id, sessionSecret());
    return {
      ok: true,
      url: `${SHARE_BASE}/r/_doc/${doc.id}?owner_doc_preview=${encodeURIComponent(token)}`,
    };
  } catch (e) {
    return { ok: false, error: errorText(e, 'Failed to start document preview.') };
  }
}

export async function deleteDocumentAction(formData: FormData) {
  const user = await requireUser();
  const docId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    await softDeleteDocument(db(), user.id, docId);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to delete the document.');
  }

  if (errorMessage) {
    redirect(`/docs/${docId}?delete_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect('/docs');
}

// Replace the HTML of an uploaded document with a new version. Every share
// link keeps working and serves the new version on its next open. Old R2
// objects stay (cheap, and a recovery path).
const MAX_REPLACE_BYTES = 30 * 1024 * 1024;

export async function replaceDocumentAction(formData: FormData) {
  const user = await requireUser();
  const documentId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    const d = db();
    const doc = await getDocument(d, user.id, documentId);
    if (!doc) throw new Error('Document not found.');
    if (doc.source_type !== 'upload') {
      throw new Error('URL-source documents update at their source; nothing to replace here.');
    }

    const file = formData.get('file') as File | null;
    if (!file || file.size === 0) throw new Error('No file uploaded.');
    if (file.size > MAX_REPLACE_BYTES) throw new Error('File exceeds the 30 MB limit.');
    if (file.type && !file.type.includes('html')) {
      throw new Error('Only HTML files can replace a document.');
    }

    // Upload first: if it fails the document still points at the old version.
    const nextVersion = (doc.current_version ?? 0) + 1;
    const newKey = r2Key(user.id, doc.id, nextVersion);
    await uploadHtml(newKey, new Uint8Array(await file.arrayBuffer()));
    await recordNewVersion(d, user.id, doc.id, {
      version: nextVersion,
      r2_key: newKey,
      source_type: 'upload',
      source_url: null,
      filename: file.name || null,
      bytes: file.size,
      bumpDocument: true,
    });
    revalidatePath(`/docs/${doc.id}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to replace the document.');
  }

  if (errorMessage) {
    redirect(`/docs/${documentId}?replace_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect(`/docs/${documentId}?replaced=1`);
}

// The link preview a chat app shows when the share URL is pasted (og:title,
// og:description, og:image). The proxy serves these to unfurl bots; the
// image lives in R2 at og/{owner}/{doc}/{uuid}.{ext}.
const OG_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_OG_IMAGE_BYTES = 5 * 1024 * 1024;

export async function updateLinkPreviewAction(formData: FormData) {
  const user = await requireUser();
  const documentId = String(formData.get('document_id'));

  let errorMessage: string | null = null;
  try {
    const d = db();
    const doc = await getDocument(d, user.id, documentId);
    if (!doc) throw new Error('Document not found.');

    const title = String(formData.get('title') ?? '').trim();
    const description = String(formData.get('og_description') ?? '').trim();
    if (description.length > 300) throw new Error('Keep the description under 300 characters.');

    let ogKey: string | null | undefined;
    const image = formData.get('og_image');
    if (image instanceof File && image.size > 0) {
      const ext = OG_IMAGE_TYPES[image.type];
      if (!ext) throw new Error('The preview image must be PNG, JPEG, WebP or GIF.');
      if (image.size > MAX_OG_IMAGE_BYTES) throw new Error('The preview image must be under 5 MB.');
      ogKey = ogImageKey(user.id, doc.id, ext);
      await uploadObject(ogKey, new Uint8Array(await image.arrayBuffer()), image.type);
    } else if (formData.get('remove_og_image') === 'on') {
      ogKey = null;
    }

    await updateDocumentPreview(d, user.id, doc.id, {
      ...(title ? { title } : {}),
      og_description: description || null,
      ...(ogKey !== undefined ? { og_image_r2_key: ogKey } : {}),
    });

    // The old image is unreachable once the row points elsewhere.
    if (ogKey !== undefined && doc.og_image_r2_key && doc.og_image_r2_key !== ogKey) {
      try {
        await deleteR2Object(doc.og_image_r2_key);
      } catch (e) {
        console.warn('[og] R2 orphan', doc.og_image_r2_key, e);
      }
    }
    revalidatePath(`/docs/${doc.id}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to update the link preview.');
  }

  if (errorMessage) {
    redirect(`/docs/${documentId}?preview_error=${encodeURIComponent(errorMessage)}`);
  }
  redirect(`/docs/${documentId}?preview_saved=1`);
}

// Hide/unhide viewers from the dashboard. A merged viewer row can back several
// DB viewers, so each is set to the same definite target.
export async function toggleViewerInternalAction(formData: FormData) {
  const user = await requireUser();
  const viewerIds = formData.getAll('viewer_id').map(String).filter(Boolean);
  const documentId = String(formData.get('document_id'));
  const targetRaw = formData.get('internal_target');
  const target = targetRaw === null ? null : String(targetRaw) === 'true';

  let errorMessage: string | null = null;
  try {
    const d = db();
    for (const viewerId of viewerIds) await setViewerInternal(d, user.id, viewerId, target);
    revalidatePath(`/docs/${documentId}`);
  } catch (e) {
    errorMessage = errorText(e, 'Failed to update the viewer.');
  }

  if (errorMessage) {
    redirect(`/docs/${documentId}?hide_error=${encodeURIComponent(errorMessage)}`);
  }
  // Redirect to the same URL so the client never shows stale data.
  redirect(`/docs/${documentId}`);
}
