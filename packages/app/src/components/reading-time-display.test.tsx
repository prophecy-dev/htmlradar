// Failure list item K: every screen shows the same reading time for the
// same visit, in the same words, and no screen calls it "tab-open".
//
// The two defects pinned here:
//   - the share report labelled average session active time "Avg tab-open",
//     which is not a quantity HTMLRadar collects;
//   - the per-viewer report showed the sum of section dwell instead, so one
//     tiny detected section (three seconds of a ninety-five-second read)
//     suppressed the real figure and the two screens disagreed.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ShareAnalytics } from './ShareAnalytics';
import { ViewerInsights } from '@/app/(app)/docs/[id]/ViewerInsights';
import {
  READING_TIME_EXPLANATION,
  READING_TIME_METHODOLOGY_NOTE,
  READING_TIME_RELEASE_DATE,
} from '@/lib/reading-time';
import type { SectionEvent, Session, Viewer } from '@/lib/types';

const AFTER_RELEASE = `${READING_TIME_RELEASE_DATE}T10:00:00.000Z`;
const BEFORE_RELEASE = '2026-09-01T10:00:00.000Z';
const READ_SECONDS = 95; // renders as "1m 35s" on every screen

const viewer: Viewer = {
  id: 'v1',
  share_id: 'sh1',
  email: 'reader@example.com',
  fingerprint: null,
  first_seen: AFTER_RELEASE,
  last_seen: AFTER_RELEASE,
  visit_count: 1,
  country_code: 'IN',
  city: null,
  device_type: 'desktop',
  os: null,
  browser: null,
  referrer: null,
  is_internal: false,
};

function session(startedAt: string): Session {
  return {
    id: 's1',
    share_id: 'sh1',
    viewer_id: 'v1',
    document_version: 1,
    started_at: startedAt,
    last_heartbeat_at: startedAt,
    active_time_seconds: READ_SECONDS,
    max_scroll_depth: 0.8,
    bounced: false,
  };
}

// One short section detected in a long read: the case that used to make
// the per-viewer report say three seconds.
const tinySection: SectionEvent = {
  id: 'e1',
  session_id: 's1',
  section_id: 'intro',
  section_title: 'Intro',
  depth: 1,
  ordinal: 0,
  time_seconds: 3,
  entered_at: AFTER_RELEASE,
};

const shareReport = (startedAt = AFTER_RELEASE) =>
  renderToStaticMarkup(
    <ShareAnalytics
      shareSlug="quick-glass"
      hostHandle={null}
      recipientLabel="Acme"
      viewers={[viewer]}
      sessions={[session(startedAt)]}
      sections={[]}
    />,
  );

const viewerReport = (startedAt = AFTER_RELEASE) =>
  renderToStaticMarkup(
    <ViewerInsights
      viewers={[viewer]}
      sessions={[session(startedAt)]}
      events={[tinySection]}
      documentId="d1"
      verifiedViewerIds={[]}
      toggleInternal={() => {}}
    />,
  );

describe('reading time reads the same on every screen', () => {
  it('shows the session’s active time on both reports', () => {
    expect(shareReport()).toContain('1m 35s');
    expect(viewerReport()).toContain('1m 35s');
  });

  it('is not suppressed by one small detected section', () => {
    const html = viewerReport();
    // Under the old fallback the viewer's row rendered the section total,
    // "3s", for a read of a minute and a half.
    expect(html).toContain('1m 35s');
    expect(html).not.toMatch(/>\s*3s\s*</);
  });

  it('never calls the figure tab-open', () => {
    for (const html of [shareReport(), viewerReport()]) {
      expect(html).not.toContain('tab-open');
      expect(html).not.toContain('tab: ');
      expect(html).not.toContain('Total time the tab was open');
    }
  });

  it('explains itself without anyone hovering', () => {
    for (const html of [shareReport(), viewerReport()]) {
      expect(html).toContain(READING_TIME_EXPLANATION);
      // In the page, not hidden in a title attribute.
      expect(html).not.toContain(`title="${READING_TIME_EXPLANATION}`);
    }
  });

  it('carries the dated note only where visits predate the release', () => {
    expect(shareReport(BEFORE_RELEASE)).toContain(READING_TIME_METHODOLOGY_NOTE);
    expect(viewerReport(BEFORE_RELEASE)).toContain(READING_TIME_METHODOLOGY_NOTE);
    expect(shareReport()).not.toContain(READING_TIME_METHODOLOGY_NOTE);
    expect(viewerReport()).not.toContain(READING_TIME_METHODOLOGY_NOTE);
  });
});
