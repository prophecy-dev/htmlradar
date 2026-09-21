import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain .mjs build script, no declarations
import {
  BUNDLE_FILE,
  TRACKER_FILE,
  bundleModule,
  servedSource,
} from '../scripts/tracker-bundle.mjs';

// src/tracker-bundle.ts is generated and committed. A tracker change that was
// not re-bundled would ship the old script at the old address, so a fresh
// build that no longer matches the committed file fails here. Skipped when the
// tracker has not been built in this checkout.
describe.skipIf(!existsSync(TRACKER_FILE))('the bundled tracker', () => {
  it('matches a fresh build of packages/tracker', () => {
    const fresh = bundleModule(servedSource(readFileSync(TRACKER_FILE, 'utf8')));
    expect(readFileSync(BUNDLE_FILE, 'utf8')).toBe(fresh);
  });
});
