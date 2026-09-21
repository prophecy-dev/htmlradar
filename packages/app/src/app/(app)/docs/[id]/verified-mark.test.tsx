// Who gets the "Verified" mark in the read report.
//
// The report groups a reader by their address across every link on the
// document, and a verification is made on ONE link. So the mark has to be tied
// to the reads themselves: a group is marked only when every read behind it
// was verified. The case this pins is the one that used to be wrong — the same
// address typed on an ordinary sibling link, inheriting a badge it never
// earned.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ViewerInsights } from './ViewerInsights';
import type { Session, Viewer } from '@/lib/types';

const AT = '2026-09-20T10:00:00.000Z';

function viewer(id: string, shareId: string): Viewer {
  return {
    id,
    share_id: shareId,
    email: 'reader@example.com',
    fingerprint: null,
    first_seen: AT,
    last_seen: AT,
    visit_count: 1,
    country_code: 'IN',
    city: null,
    device_type: 'desktop',
    os: null,
    browser: null,
    referrer: null,
    is_internal: false,
  };
}

function session(id: string, shareId: string, viewerId: string): Session {
  return {
    id,
    share_id: shareId,
    viewer_id: viewerId,
    document_version: 1,
    started_at: AT,
    last_heartbeat_at: AT,
    active_time_seconds: 95,
    max_scroll_depth: 0.8,
    bounced: false,
  };
}

// One reader, two links: verified on the first, an ordinary gate on the second.
const viewers = [viewer('v1', 'sh1'), viewer('v2', 'sh2')];
const sessions = [session('s1', 'sh1', 'v1'), session('s2', 'sh2', 'v2')];

const report = (verifiedViewerIds: string[]) =>
  renderToStaticMarkup(
    <ViewerInsights
      viewers={viewers}
      sessions={sessions}
      events={[]}
      documentId="d1"
      verifiedViewerIds={verifiedViewerIds}
      toggleInternal={() => {}}
    />,
  );

describe('the verified mark', () => {
  it('marks a reader whose every read was verified', () => {
    expect(report(['v1', 'v2'])).toContain('Verified');
  });

  it('does not mark a reader who also read on a link nobody verified', () => {
    expect(report(['v1'])).not.toContain('Verified');
  });

  it('marks nobody when nothing was verified', () => {
    expect(report([])).not.toContain('Verified');
  });
});
