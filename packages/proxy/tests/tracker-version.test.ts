import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM build script, no types, imported for its two pure helpers.
import {
  TRACKER_FILE,
  VERSION_FILE,
  trackerVersion,
  versionModule,
} from '../scripts/tracker-version.mjs';

// The address the tracker is served at carries a version derived from the
// tracker's own bytes. Two properties make that address safe to cache forever,
// and both are checked here.
describe('the tracker version is derived from the bundle, never hand-written', () => {
  it('gives different bytes a different address, and identical bytes the same one', () => {
    const before = trackerVersion('/* tracker */');
    const after = trackerVersion('/* tracker, with the returning-reader fix */');
    expect(after).not.toBe(before);
    expect(trackerVersion('/* tracker */')).toBe(before);
    // Fits the route's version segment, /^[a-z0-9]+$/.
    expect(before).toMatch(/^[a-f0-9]{12}$/);
  });

  // The generated module is committed so typecheck and these tests run without
  // a build step; wrangler regenerates it before every deploy. This is what
  // stops the committed copy going stale after a tracker change — without it,
  // a new script would ship at the old address and the cache skew this whole
  // change exists to kill would be back.
  it('is committed in step with the tracker bundle the app serves', () => {
    const expected = versionModule(trackerVersion(readFileSync(TRACKER_FILE)));
    expect(readFileSync(VERSION_FILE, 'utf8')).toBe(expected);
  });
});
