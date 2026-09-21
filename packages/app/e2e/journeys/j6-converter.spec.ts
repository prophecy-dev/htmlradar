// Journey 6 — the front door for the nine sign-ups in sixteen who arrive
// holding a PDF and never upload anything.
//
// A person who is not signed in converts a deck on /convert, asks for a
// tracked link, is sent through sign-in, and comes back to find the
// converted document waiting in their account. The hand-off in the middle —
// the file parked in the browser's own storage across a sign-in round trip —
// is the fragile part and the reason this journey exists.
//
// THE FIXTURE PDF is generated here rather than committed. pdf-lib is
// already a dev dependency of this package (it is what the PDF tests use),
// so no new dependency was added; the file is two landscape pages with a
// line of text on each and lands in the operating system's temporary
// directory, so nothing is left in the repository or in the worktree.

import { test, expect, type BrowserContext } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BASE, JOURNEY_EMAIL, RUN_ID, cleanupDocumentIds, record, rest, signIn } from './lib';

let pdfPath = '';
let context: BrowserContext;
let documentId = '';

test.beforeAll(async () => {
  test.skip(!JOURNEY_EMAIL, 'GOLDEN_JOURNEY_EMAIL (or JOURNEY_EMAIL) is not set');

  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // 720 × 405 is 16:9. The converter accepts landscape decks of 2 to 60
  // pages; two is the smallest deck that is still a deck.
  for (const line of ['Golden journey slide one', 'Golden journey slide two']) {
    const page = pdf.addPage([720, 405]);
    page.drawText(line, { x: 48, y: 320, size: 36, font });
    page.drawText('A generated fixture for the golden journeys.', {
      x: 48,
      y: 260,
      size: 18,
      font,
    });
  }
  pdfPath = path.join(
    mkdtempSync(path.join(tmpdir(), 'golden-')),
    `golden journey j6 ${RUN_ID}.pdf`,
  );
  writeFileSync(pdfPath, await pdf.save());
});

test.afterAll(async () => {
  // By id: the converter names the document after the file, so the title
  // prefix the other journeys clean up by never reaches this one.
  await cleanupDocumentIds([documentId].filter(Boolean));
  await context?.close();
});

test('J6 converter: a PDF becomes a document in an account, through sign-in', async ({
  browser,
}) => {
  // Signed out, because that is who lands on /convert.
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/convert`);

  await page.locator('input[aria-label="Choose a PDF deck"]').setInputFiles(pdfPath);
  await expect(
    page.getByRole('heading', { name: /your html file is ready/i }),
    'the PDF did not convert',
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(/2 slides/),
    'the two-page deck did not make two slides',
  ).toBeVisible();

  // The hand-off. This parks the converted HTML in the browser and sends the
  // person to sign in with a token that names the waiting file.
  await page.getByRole('button', { name: /get a tracked link/i }).click();
  await page.waitForURL(/\/sign-in\?next=/, { timeout: 60_000 });
  const next = new URL(page.url()).searchParams.get('next') ?? '';
  expect(next, 'sign-in was not told to come back to the converter').toMatch(/^\/convert\?resume=/);

  // Sign in the way the e-mail link does, in the SAME browser — the staged
  // file lives in this browser's storage and nowhere else, so a fresh
  // context here would lose it, which is exactly the bug this guards.
  // Waiting on /docs rather than on /convert: the converter only passes
  // through that address on its way to the finished document.
  const signedIn = await signIn(context, JOURNEY_EMAIL, next, /\/docs\/[0-9a-f-]{36}/);
  documentId = signedIn.url().match(/\/docs\/([0-9a-f-]{36})/)?.[1] ?? '';
  expect(documentId, 'the staged deck never became a document').toBeTruthy();

  const documents = await rest<{ id: string; title: string; source_type: string }>(
    `/documents?id=eq.${documentId}&select=id,title,source_type,deleted_at`,
  );
  expect(documents.length, 'no document row for the converted deck').toBe(1);
  expect(documents[0]!.source_type, 'the converted deck was not stored as an upload').toBe(
    'upload',
  );

  // And it is in the list the person actually looks at.
  await signedIn.goto(`${BASE}/docs`);
  await expect(
    signedIn.getByText(documents[0]!.title, { exact: false }).first(),
    'the converted deck is not in the account',
  ).toBeVisible({ timeout: 30_000 });

  record('j6', {
    db: { documents: 1, source_type: 'upload' },
    screen: { slides: 2, reached_sign_in: true, document_listed: true },
  });
});
