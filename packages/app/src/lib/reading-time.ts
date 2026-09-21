// What every screen says about reading time, in one place, so no two
// screens can describe the same number differently.
//
// The figure itself is always the session's active time: the seconds the
// document was visible and the reader showed a sign of presence within the
// last thirty. Section dwell describes the part of that time we can pin to
// a section; it is never the headline, because one small detected section
// used to make a real read look like nothing.

// The day the thirty-second allowance went live. Set this to the real
// release date before the change lands.
export const READING_TIME_RELEASE_DATE = '2026-09-21';

const releaseDay = new Date(`${READING_TIME_RELEASE_DATE}T00:00:00Z`).toLocaleDateString('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export const READING_TIME_LABEL = 'Estimated reading time';

export const READING_TIME_EXPLANATION =
  'We estimate reading time while the document is visible, allowing up to 30 seconds without interaction; this cannot confirm attention.';

export const READING_TIME_METHODOLOGY_NOTE = `Reading time is measured more accurately from ${releaseDay}; earlier visits were under-counted.`;

// True when any of these visits happened before the release, so the report
// can carry the note that explains why older numbers look smaller.
// ISO timestamps sort as text, so "2026-09-21T09:00:00Z" < "2026-09-21".
export function hasPreReleaseSessions(startedAt: Array<string | null | undefined>): boolean {
  return startedAt.some((t) => !!t && t < READING_TIME_RELEASE_DATE);
}
