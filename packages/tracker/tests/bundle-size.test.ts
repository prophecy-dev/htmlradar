// @vitest-environment node
//
// (esbuild needs a real TextEncoder; jsdom's is not the one it checks for.)
//
// Failure list item M: the tracker runs inside someone else's document, so
// its weight is a promise, not a detail. The reading-time change cost 176
// bytes gzipped (8,569 → 8,745), well inside the 1.5 KB ceiling agreed for
// it. The ceiling is absolute rather than a delta so it keeps holding after
// this change has landed.
//
// Raised once since, for reader comments (2026-09-22): the affordance under
// each heading, the box at the end of the deck and the styles of their shadow
// roots cost 1,417 gzipped bytes, 9,023 → 10,440. Paid deliberately — it is
// the only part of the tracker a reader is meant to use — and the headroom
// above it is back to 1 KB, so the next change is held to the same discipline.

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CEILING_BYTES = 10_440 + 1_024;

describe('bundle size', () => {
  it('stays under the gzipped ceiling', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2020',
      minify: true,
      define: { __VERSION__: '"test"' },
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]!.contents;
    const gzipped = gzipSync(code).byteLength;
    expect(gzipped, `tracker is ${gzipped} gzipped bytes`).toBeLessThanOrEqual(CEILING_BYTES);
  }, 30_000);
});
