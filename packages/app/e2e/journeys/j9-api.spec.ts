// Journey 9 — the public API, which is the only part of the product with
// callers we cannot see.
//
// A browser journey fails loudly when a page changes. The API fails quietly:
// a renamed field keeps answering 200 and breaks every integration at once,
// including the connector in claude.ai. So this journey walks the four calls
// an integration actually makes and compares their SHAPES — every key and
// the type of its value — against a stored file.
//
// Values are deliberately not compared. An id and a slug differ every run;
// the shape does not, and the shape is the contract.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_KEY, BASE, JOURNEY_EMAIL, cleanupDocuments, journeyTitle, record } from './lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHAPES = path.join(__dirname, 'api-shapes.json');
const title = journeyTitle('j9');

/** Every key, with the type of its value in place of the value. Arrays keep
 *  the shape of their first element, because a list of ten objects with the
 *  same shape tells us nothing a list of one does not. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, shapeOf(v)]),
    );
  }
  return typeof value;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

test.afterAll(async () => {
  await cleanupDocuments([title]);
});

test('J9 API: create, activity, replace and revoke keep their shapes', async () => {
  test.skip(!JOURNEY_EMAIL || !API_KEY, 'journey account or API key not set');

  const shapes: Record<string, unknown> = {};

  const created = await api('POST', '/api/v1/shares', {
    title,
    require_email: false,
    recipient_label: 'golden j9',
    html: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>
      <section><h2>One</h2><p>First.</p></section></body></html>`,
  });
  expect(created.status, 'creating a link did not answer 201').toBe(201);
  shapes['POST /api/v1/shares'] = shapeOf(created.json);
  const share = created.json as { share_id: string; document_id: string };
  const documentId = share.document_id;

  try {
    const activity = await api('GET', `/api/v1/shares/${share.share_id}/activity`);
    expect(activity.status, 'reading activity did not answer 200').toBe(200);
    shapes['GET /api/v1/shares/{id}/activity'] = shapeOf(activity.json);
    // No browser has opened this link, so the honest answer is "not opened".
    // Which also means `viewers` is empty here and the shape of a viewer
    // entry — the richest part of this API — is not captured by the snapshot
    // above. J3 covers it, on a share that has a real reader.
    expect((activity.json as { opened: boolean }).opened, 'an unopened link reports as opened').toBe(
      false,
    );

    const replaced = await api('POST', `/api/v1/documents/${documentId}/replace`, {
      html: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>
        <section><h2>Two</h2><p>Replaced.</p></section></body></html>`,
    });
    expect(replaced.status, 'replacing the document did not answer 200').toBe(200);
    shapes['POST /api/v1/documents/{id}/replace'] = shapeOf(replaced.json);
    // The promise of the endpoint: links already sent keep working.
    expect((replaced.json as { links_unchanged: boolean }).links_unchanged).toBe(true);
  } finally {
    const revoked = await api('POST', `/api/v1/shares/${share.share_id}/revoke`, {});
    expect(revoked.status, 'revoking did not answer 200').toBe(200);
    shapes['POST /api/v1/shares/{id}/revoke'] = shapeOf(revoked.json);
  }

  // First run writes the file; every run after compares against it. A
  // deliberate API change means reviewing the diff to this file and
  // committing it, which is the point — it cannot happen by accident.
  if (!existsSync(SHAPES)) {
    writeFileSync(SHAPES, `${JSON.stringify(shapes, null, 2)}\n`);
    test.info().annotations.push({ type: 'note', description: `wrote first API snapshot to ${SHAPES}` });
  } else {
    expect(
      shapes,
      'the public API changed shape — if that was intended, review and commit e2e/journeys/api-shapes.json',
    ).toEqual(JSON.parse(readFileSync(SHAPES, 'utf8')));
  }

  record('j9', { db: {}, screen: {}, api: shapes });
});
