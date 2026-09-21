// R2 through the Pages binding (DOCS_BUCKET). Key layouts match the proxy,
// which reads the same bucket:
//   docs/{owner}/{doc}/v{n}.html                  document HTML
//   attachments/{owner}/{doc}/{att_id}-{filename} supporting files (lib/attachments)
//   og/{owner}/{doc}/{uuid}.{ext}                 link-preview image

import { docR2Key } from '@htmlradar/db/owner';
import { bucket } from './cf';

export const r2Key = docR2Key;

export function ogImageKey(ownerId: string, docId: string, ext: string): string {
  return `og/${ownerId}/${docId}/${crypto.randomUUID()}.${ext}`;
}

export async function uploadHtml(key: string, body: Uint8Array): Promise<void> {
  await bucket().put(key, body, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
}

export async function uploadObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await bucket().put(key, body, { httpMetadata: { contentType } });
}

export const uploadAttachment = uploadObject;

export async function deleteR2Object(key: string): Promise<void> {
  await bucket().delete(key);
}
