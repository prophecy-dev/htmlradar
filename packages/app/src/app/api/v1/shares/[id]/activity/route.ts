// GET /api/v1/shares/{id}/activity[?include_detail=true] — who opened one
// link and what they read. {id} is the share id, its slug, or the whole link.
// One row per person (same email = same person); internal viewers and phantom
// bounces are excluded, as on the dashboard. Location and device only when
// asked for.

import type { NextRequest } from 'next/server';
import { listSectionEvents, listSessions, listViewers } from '@htmlradar/db/owner';
import { authenticateApiKey, CHEAP_MAX, json, notFound } from '@/lib/api-auth';
import { findOwnedShare } from '@/lib/api-share-lookup';
import { db } from '@/lib/cf';
import { isMetaSectionTitle } from '@/lib/section-filter';
import { shareUrl } from '@/lib/share-url';
import type { SectionEvent, Session, Viewer } from '@/lib/types';

interface ViewerDetail {
  country: string | null;
  city: string | null;
  device: string | null;
  referrer: string | null;
}

interface ViewerOut {
  label: string | null;
  email: string | null;
  first_open: string;
  last_seen: string;
  active_seconds: number;
  max_scroll: number;
  sections: Array<{ title: string; time_seconds: number }>;
  detail?: ViewerDetail;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateApiKey(req, { name: 'activity', max: CHEAP_MAX });
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const includeDetail = new URL(req.url).searchParams.get('include_detail') === 'true';

  const share = await findOwnedShare(caller.userId, decodeURIComponent(params.id));
  if (!share) return notFound();
  const url = shareUrl(share.slug);

  const d = db();
  const scope = { shareId: share.id };
  const [viewerRows, sessionRows, eventRows] = await Promise.all([
    listViewers(d, caller.userId, scope),
    listSessions(d, caller.userId, scope),
    listSectionEvents(d, caller.userId, scope),
  ]);

  const viewers: Viewer[] = viewerRows;
  const internalViewerIds = new Set(viewers.filter((v) => v.is_internal === true).map((v) => v.id));

  const sessions = (sessionRows as Session[]).filter(
    (s) =>
      !internalViewerIds.has(s.viewer_id) &&
      !(
        s.bounced === true &&
        (s.active_time_seconds ?? 0) === 0 &&
        (s.max_scroll_depth ?? 0) === 0
      ),
  );

  if (sessions.length === 0) {
    return json({ share_id: share.id, url, opened: false, viewers: [] });
  }

  const kept = new Set(sessions.map((s) => s.id));
  const sectionEvents: SectionEvent[] = eventRows.filter(
    (e) => kept.has(e.session_id) && !isMetaSectionTitle(e.section_title, e.section_id),
  );

  // One row per PERSON: same email = same person however many devices they
  // used; an anonymous viewer is their own person. Mirrors countDistinctViewers
  // and how ViewerInsights groups.
  const viewerById = new Map(viewers.map((v) => [v.id, v]));
  const groupKeyOf = (viewerId: string) =>
    viewerById.get(viewerId)?.email?.trim().toLowerCase() || viewerId;

  const sessionActiveSeconds = new Map(sessions.map((s) => [s.id, s.active_time_seconds ?? 0]));
  const sessionScale = scaler(sectionEvents, sessionActiveSeconds);

  const groups = new Map<
    string,
    {
      email: string | null;
      sessions: Session[];
      sections: Map<string, SectionRow>;
      viewers: Viewer[];
    }
  >();
  for (const session of sessions) {
    const key = groupKeyOf(session.viewer_id);
    const group = groups.get(key) ?? {
      email: viewerById.get(session.viewer_id)?.email ?? null,
      sessions: [],
      sections: new Map<string, SectionRow>(),
      viewers: [],
    };
    group.sessions.push(session);
    const viewer = viewerById.get(session.viewer_id);
    if (viewer && !group.viewers.includes(viewer)) group.viewers.push(viewer);
    groups.set(key, group);
  }

  const sessionToKey = new Map(sessions.map((s) => [s.id, groupKeyOf(s.viewer_id)]));
  for (const event of sectionEvents) {
    const group = groups.get(sessionToKey.get(event.session_id) ?? '');
    if (!group) continue;
    const row = group.sections.get(event.section_id) ?? {
      title: event.section_title ?? event.section_id,
      seconds: 0,
      ordinal: Number.POSITIVE_INFINITY,
    };
    row.seconds += event.time_seconds * sessionScale(event.session_id);
    if (typeof event.ordinal === 'number' && event.ordinal < row.ordinal)
      row.ordinal = event.ordinal;
    group.sections.set(event.section_id, row);
  }

  const out: ViewerOut[] = [...groups.values()]
    .map((group) => ({
      // The sender's own label for this link. It is the only human name the
      // product holds for an anonymous reader, and for a per-recipient link it
      // is exactly who the sender meant.
      label: share.recipient_label ?? null,
      email: group.email,
      first_open: min(group.sessions.map((s) => s.started_at)),
      last_seen: max(group.sessions.map((s) => s.last_heartbeat_at ?? s.started_at)),
      active_seconds: round(
        group.sessions.reduce((sum, s) => sum + (s.active_time_seconds ?? 0), 0),
      ),
      max_scroll: Math.max(0, ...group.sessions.map((s) => s.max_scroll_depth ?? 0)),
      sections: [...group.sections.values()]
        // Deck order — the narrative as the sender wrote it. Sections with no
        // recorded ordinal (older reads) fall to the end.
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((s) => ({ title: s.title, time_seconds: round(s.seconds) })),
      ...(includeDetail ? { detail: detailOf(group.viewers) } : {}),
    }))
    .sort((a, b) => (a.first_open < b.first_open ? -1 : 1));

  return json({ share_id: share.id, url, opened: out.length > 0, viewers: out });
}

interface SectionRow {
  title: string;
  seconds: number;
  ordinal: number;
}

/**
 * Where this person read from, taken from their most recent visit.
 *
 * One person can be several viewer rows — the same email on a laptop and a
 * phone — and the answer a sender wants is where they were the last time,
 * not an average of two places. Anything the tracker did not record stays
 * null rather than being guessed at from another row.
 */
function detailOf(viewers: Viewer[]): ViewerDetail {
  const latest = [...viewers].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))[0];
  return {
    country: latest?.country_code ?? null,
    city: latest?.city ?? null,
    device: latest?.device_type ?? null,
    referrer: latest?.referrer ?? null,
  };
}

// A session's section dwell cannot exceed the time the tab was actually
// active. Stale pre-fix tracker data over-credited; current sessions already
// satisfy this, so the factor is 1 for them.
function scaler(events: SectionEvent[], activeSeconds: Map<string, number>) {
  const sums = new Map<string, number>();
  for (const e of events) sums.set(e.session_id, (sums.get(e.session_id) ?? 0) + e.time_seconds);
  return (sessionId: string): number => {
    const active = activeSeconds.get(sessionId) ?? 0;
    const sum = sums.get(sessionId) ?? 0;
    return sum > active && sum > 0 ? active / sum : 1;
  };
}

function min(values: string[]): string {
  return values.reduce((a, b) => (a < b ? a : b));
}

function max(values: string[]): string {
  return values.reduce((a, b) => (a > b ? a : b));
}

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}
