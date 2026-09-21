// /docs/[id] — Three-tab document view (Sharing / Analytics / Versions), with
// the document-level attachments and link preview below the tabs.
//
// Every read goes through packages/db/src/owner.ts, scoped to the signed-in
// owner; analytics are read with owner-scoped joins rather than IN lists, so
// a document with many sessions never hits D1's bound-parameter limit.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, FileText, Link2 } from 'lucide-react';
import {
  getDocument,
  listAttachments,
  listEmailVerifications,
  listSectionEvents,
  listSessions,
  listSharesForDocument,
  listVersions,
  listViewers,
  touchDocumentViewed,
} from '@htmlradar/db/owner';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/cf';
import { Chip } from '@/components/doc-dashboard/Chip';
import {
  previewDocumentAction,
  replaceDocumentAction,
  deleteDocumentAction,
  previewShareAction,
  editShareAction,
  toggleShareAction,
  deleteShareAction,
  uploadAttachmentsAction,
  deleteAttachmentAction,
  toggleViewerInternalAction,
  updateLinkPreviewAction,
} from '../actions';
import { AttachmentsPanel, type AttachmentRow } from '../AttachmentsPanel';
import type { SectionTotal } from './SectionTimeBarChart';
import { DeleteDocumentButton } from '../DeleteDocumentButton';
import { ReplaceDocumentButton } from '../ReplaceDocumentButton';
import { PreviewDocumentButton } from '../PreviewDocumentButton';
import { LiveRefresh } from '../LiveRefresh';
import { VersionHistoryPopover, type DocumentVersionRow } from '../VersionHistoryPopover';
import { DocTabsClient } from './DocTabsClient';
import { normalizeTab, type TabKey } from './tab-key';
import { type ShareRow, type ShareAnalyticsData } from '../share-types';
import { LinkPreviewForm } from '../LinkPreviewForm';
import type { Viewer, Session, SectionEvent } from '@/lib/types';
import { isMetaSectionTitle } from '@/lib/section-filter';
import { countDistinctViewers } from '@/lib/viewer-metrics';

type DocSearchParams = {
  tab?: string;
  share_error?: string;
  delete_error?: string;
  attachment_error?: string;
  preview_error?: string;
  replace_error?: string;
  replaced?: string;
  hide_error?: string;
  edited?: string;
  share_deleted?: string;
  share_kept?: string;
  preview_saved?: string;
};

export default async function DocumentPageV2(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<DocSearchParams>;
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  return renderV2({ params, searchParams });
}

async function renderV2({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: DocSearchParams;
}) {
  const user = await requireUser();
  const d = db();

  const banners = collectBanners(searchParams ?? {});
  const initialTab: TabKey = normalizeTab(searchParams?.tab);

  const doc = await getDocument(d, user.id, params.id);
  if (!doc) notFound();

  // Clears the "new activity since last visit" marker on /docs.
  await touchDocumentViewed(d, user.id, doc.id);

  const scope = { documentId: doc.id };
  const [rawShares, versionRows, attachmentRows, allViewers, allSessions, rawEvents, verified] =
    await Promise.all([
      listSharesForDocument(d, user.id, doc.id),
      listVersions(d, user.id, doc.id),
      listAttachments(d, user.id, doc.id),
      listViewers(d, user.id, scope),
      listSessions(d, user.id, scope),
      listSectionEvents(d, user.id, scope),
      listEmailVerifications(d, user.id, scope),
    ]);
  const shareIds = rawShares.map((s) => s.id);
  const versions: DocumentVersionRow[] = versionRows as DocumentVersionRow[];
  const attachments: AttachmentRow[] = attachmentRows.map((a) => ({
    id: a.id,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    created_at: a.created_at,
  }));
  const allEvents: SectionEvent[] = rawEvents.filter(
    (e) => !isMetaSectionTitle(e.section_title, e.section_id),
  );

  // A viewer is verified when the code was proved on THAT viewer's own link at
  // THAT viewer's own address — a verification belongs to one link.
  const verifiedPairs = new Set(
    verified.map((r) => `${r.share_id}|${r.email.trim().toLowerCase()}`),
  );
  const verifiedViewerIds = allViewers
    .filter(
      (v) => v.email?.trim() && verifiedPairs.has(`${v.share_id}|${v.email.trim().toLowerCase()}`),
    )
    .map((v) => v.id);

  const internalViewerIds = new Set(allViewers.filter((v) => v.is_internal).map((v) => v.id));
  const visibleViewers = allViewers.filter((v) => !internalViewerIds.has(v.id));
  const visibleSessions: Session[] = allSessions.filter(
    (s) =>
      !internalViewerIds.has(s.viewer_id) &&
      !(
        s.bounced === true &&
        (s.active_time_seconds ?? 0) === 0 &&
        (s.max_scroll_depth ?? 0) === 0
      ),
  );
  const viewerCount = countDistinctViewers(visibleViewers);
  const hasOpens = visibleSessions.length > 0;

  const now = Date.now();
  const viewersById = new Map(allViewers.map((v) => [v.id, v]));
  const liveKeys = new Set<string>();
  for (const s of allSessions) {
    const hb = s.last_heartbeat_at ? new Date(s.last_heartbeat_at).getTime() : 0;
    if (hb > 0 && now - hb < 60_000) {
      liveKeys.add(viewersById.get(s.viewer_id)?.email?.trim().toLowerCase() || s.viewer_id);
    }
  }
  const liveReaders = liveKeys.size;

  const sessionToShare = new Map<string, string>(visibleSessions.map((s) => [s.id, s.share_id]));
  const sessionsByShare: Record<string, Session[]> = {};
  for (const s of visibleSessions) {
    (sessionsByShare[s.share_id] ??= []).push(s);
  }
  const viewersByShare: Record<string, Viewer[]> = {};
  for (const v of visibleViewers) {
    (viewersByShare[v.share_id] ??= []).push(v);
  }

  const shares: ShareRow[] = rawShares.map((s) => ({
    id: s.id,
    slug: s.slug,
    slug_is_custom: s.slug_is_custom,
    recipient_label: s.recipient_label,
    require_email: s.require_email,
    verify_email: s.verify_email,
    require_password: s.require_password,
    allowed_email_domains: s.allowed_email_domains,
    allowed_emails: s.allowed_emails,
    lock_deck: s.lock_deck,
    notify_first_open: s.notify_first_open,
    expires_at: s.expires_at,
    revoked_at: s.revoked_at,
    viewCount: sessionsByShare[s.id]?.length ?? 0,
  }));

  // Aggregate section totals for the doc-level chart.
  //
  // Two filters that the prior version missed and produced the
  // 309-min / duplicate-bars regression on the v2 Analytics tab:
  //
  // 1. Keep only events from visibleSessions (internal viewers and
  //    phantom/bounced sessions otherwise dominate every bar — the
  //    owner re-reading their own deck during dev showed up as a
  //    125-min "The Decade" bar with no real reader on it).
  // 2. Key on the normalized section TITLE, not section_id. Across
  //    deck versions the same titled section gets a fresh DOM id
  //    (slide-9 → slide-12 → slide-30), so keying by id rendered
  //    "Why We Win / Roadmap / Team" as three duplicate bars instead
  //    of one. Sections without a title fall back to id (can't merge
  //    unknowns safely).
  const visibleSessionIds = new Set(visibleSessions.map((s) => s.id));

  // Per-session cap. A session's section dwell can never exceed the time the
  // session was actually active. Sessions recorded by an older tracker (before
  // the normalized viewport-coverage fix) over-credited — their section
  // time_seconds can sum to 2–3x the session's active_time. Rescale each
  // session's events proportionally so its sections sum to at most its
  // active_time, then aggregate. Current-tracker sessions already satisfy this
  // (scale = 1), so this only corrects stale pre-fix data on the chart.
  const sessionActiveSeconds = new Map(
    visibleSessions.map((s) => [s.id, s.active_time_seconds ?? 0]),
  );
  const sessionEventSum = new Map<string, number>();
  for (const e of allEvents) {
    if (!visibleSessionIds.has(e.session_id)) continue;
    sessionEventSum.set(e.session_id, (sessionEventSum.get(e.session_id) ?? 0) + e.time_seconds);
  }
  const sessionScale = (sessionId: string): number => {
    const active = sessionActiveSeconds.get(sessionId) ?? 0;
    const sum = sessionEventSum.get(sessionId) ?? 0;
    return sum > active && sum > 0 ? active / sum : 1;
  };

  const sectionAgg = new Map<
    string,
    { id: string; title: string; totalSeconds: number; minOrdinal: number }
  >();
  for (const e of allEvents) {
    if (!visibleSessionIds.has(e.session_id)) continue;
    const title = (e.section_title ?? e.section_id).trim();
    const key = title ? title.toLowerCase() : e.section_id;
    const cur = sectionAgg.get(key) ?? {
      id: e.section_id,
      title: title || e.section_id,
      totalSeconds: 0,
      minOrdinal: Number.POSITIVE_INFINITY,
    };
    cur.totalSeconds += e.time_seconds * sessionScale(e.session_id);
    if (typeof e.ordinal === 'number' && e.ordinal < cur.minOrdinal) {
      cur.minOrdinal = e.ordinal;
    }
    sectionAgg.set(key, cur);
  }
  const sectionTotals: SectionTotal[] = [...sectionAgg.entries()]
    .map(([key, v]) => ({
      id: key,
      title: v.title,
      totalSeconds: v.totalSeconds,
      ordinal: Number.isFinite(v.minOrdinal) ? v.minOrdinal : null,
    }))
    .sort((a, b) => {
      if (a.ordinal == null && b.ordinal == null) return 0;
      if (a.ordinal == null) return 1;
      if (b.ordinal == null) return -1;
      return a.ordinal - b.ordinal;
    });

  // Per-share id → slug + recipient_label maps for ViewerInsights.
  const shareSlugs = Object.fromEntries(rawShares.map((s) => [s.id, s.slug]));
  const shareLabels = Object.fromEntries(rawShares.map((s) => [s.id, s.recipient_label]));

  const analyticsByShareId: Record<string, ShareAnalyticsData> = {};
  for (const s of rawShares) {
    const shareSessions = sessionsByShare[s.id] ?? [];
    const sessionToViewer = new Map<string, string>(
      shareSessions.map((sess) => [sess.id, sess.viewer_id]),
    );
    const sectionMap = new Map<
      string,
      { title: string; totalSeconds: number; viewerIds: Set<string>; minOrdinal: number }
    >();
    for (const e of allEvents) {
      if (sessionToShare.get(e.session_id) !== s.id) continue;
      const cur = sectionMap.get(e.section_id) ?? {
        title: e.section_title ?? e.section_id,
        totalSeconds: 0,
        viewerIds: new Set<string>(),
        minOrdinal: Number.POSITIVE_INFINITY,
      };
      cur.totalSeconds += e.time_seconds * sessionScale(e.session_id);
      const vId = sessionToViewer.get(e.session_id);
      if (vId) cur.viewerIds.add(vId);
      if (typeof e.ordinal === 'number' && e.ordinal < cur.minOrdinal) {
        cur.minOrdinal = e.ordinal;
      }
      sectionMap.set(e.section_id, cur);
    }
    const sections = [...sectionMap.entries()]
      .map(([id, v]) => ({
        id,
        title: v.title,
        totalSeconds: v.totalSeconds,
        viewers: v.viewerIds.size,
        ordinal: Number.isFinite(v.minOrdinal) ? v.minOrdinal : null,
      }))
      .sort((a, b) => {
        if (a.ordinal == null && b.ordinal == null) return 0;
        if (a.ordinal == null) return 1;
        if (b.ordinal == null) return -1;
        return a.ordinal - b.ordinal;
      });
    analyticsByShareId[s.id] = {
      viewers: viewersByShare[s.id] ?? [],
      sessions: shareSessions,
      sections,
    };
  }

  return (
    <div className="pb-16">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-graphite"
      >
        <Link href="/docs" className="hover:text-signal-dark">
          Documents
        </Link>
        <ChevronRight aria-hidden className="size-3 opacity-50" />
        <span className="max-w-[40ch] truncate normal-case tracking-normal text-ink-soft">
          {doc.title}
        </span>
      </nav>

      <header className="mt-6 flex flex-col gap-7 pb-8 md:flex-row md:items-end md:justify-between md:gap-10">
        <div className="min-w-0 flex-1">
          <h1
            title={doc.title}
            className="text-letterpress font-serif text-[30px] font-normal leading-[1.06] tracking-tightest text-ink md:text-[40px] lg:text-[46px]"
          >
            {doc.title}
          </h1>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {liveReaders > 0 && (
              <Chip variant="live">
                {liveReaders === 1 ? '1 reading now' : `${liveReaders} reading now`}
              </Chip>
            )}
            <Chip
              icon={
                doc.source_type === 'upload' ? (
                  <FileText className="size-3 text-signal-dark" />
                ) : (
                  <Link2 className="size-3 text-signal-dark" />
                )
              }
            >
              {doc.source_type === 'upload' ? 'Uploaded HTML' : 'URL source'}
            </Chip>
            <VersionHistoryPopover currentVersion={doc.current_version} versions={versions} />
            <LiveRefresh />
          </div>
          {doc.source_type === 'url' && doc.source_url && (
            <a
              href={doc.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block max-w-[60ch] truncate font-mono text-[12px] text-signal-dark underline decoration-line decoration-2 underline-offset-2 hover:decoration-signal"
            >
              {doc.source_url}
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {doc.source_type === 'upload' && (
            <>
              <PreviewDocumentButton documentId={doc.id} action={previewDocumentAction} />
              <ReplaceDocumentButton documentId={doc.id} action={replaceDocumentAction} />
            </>
          )}
          <DeleteDocumentButton
            documentId={doc.id}
            documentTitle={doc.title}
            shareCount={shareIds.length}
            action={deleteDocumentAction}
          />
        </div>
      </header>

      {banners.map((b) => (
        <div
          key={b.key}
          role={b.role}
          className={
            b.role === 'alert'
              ? 'mt-6 rounded-md border border-alert/40 bg-alert/5 px-4 py-3 text-[14px] leading-relaxed text-alert'
              : 'mt-6 rounded-md border border-signal/30 bg-signal/5 px-4 py-3 text-[14px] leading-relaxed text-signal-dark'
          }
        >
          {b.message}
        </div>
      ))}

      <DocTabsClient
        documentId={doc.id}
        initialTab={initialTab}
        shareCount={shareIds.length}
        versionCount={versions.length}
        viewerCount={viewerCount}
        hasShares={shareIds.length > 0}
        hasOpens={hasOpens}
        hasMultipleVersions={versions.length > 1}
        shares={shares}
        analyticsByShareId={analyticsByShareId}
        previewShareAction={previewShareAction}
        editShareAction={editShareAction}
        toggleShareAction={toggleShareAction}
        deleteShareAction={deleteShareAction}
        viewers={allViewers}
        verifiedViewerIds={verifiedViewerIds}
        sessions={allSessions}
        events={allEvents}
        shareSlugs={shareSlugs}
        shareLabels={shareLabels}
        toggleViewerInternalAction={toggleViewerInternalAction}
        sectionTotals={sectionTotals}
        versions={versions}
        currentVersion={doc.current_version}
      />

      {/* Attachments stay full-width below the tabs. They're doc-level
          assets (one set per document, not per share), so embedding
          inside each share card would mislead — the same files would
          appear under every card. Live page uses the same placement. */}
      <div className="mt-12">
        <AttachmentsPanel
          documentId={doc.id}
          attachments={attachments}
          uploadAction={uploadAttachmentsAction}
          deleteAction={deleteAttachmentAction}
        />
      </div>

      <div className="mt-12">
        <LinkPreviewForm
          documentId={doc.id}
          title={doc.title}
          description={doc.og_description}
          hasImage={!!doc.og_image_r2_key}
          action={updateLinkPreviewAction}
        />
      </div>
    </div>
  );
}

// ---------- helpers ----------

const CUSTOM_SLUG_KEPT_MESSAGE =
  'This link’s address is permanent — the people you sent it to are still using it. The link has been switched off instead, so the address can never point at anyone else’s document.';

type BannerRow = { key: string; role: 'alert' | 'status'; message: string };

function collectBanners(sp: DocSearchParams) {
  const out: BannerRow[] = [];
  if (!sp) return out;
  if (sp.share_kept)
    out.push({
      key: 'share_kept',
      role: 'status',
      message: CUSTOM_SLUG_KEPT_MESSAGE,
    });
  // Not prefixed with "Couldn't create the share" — this parameter also
  // carries failures from revoking and deleting a link, and the old wording
  // mislabelled every one of them.
  if (sp.share_error)
    out.push({
      key: 'share_error',
      role: 'alert',
      message: decodeURIComponent(sp.share_error),
    });
  if (sp.delete_error)
    out.push({
      key: 'delete_error',
      role: 'alert',
      message: `Couldn't delete this document: ${decodeURIComponent(sp.delete_error)}`,
    });
  if (sp.preview_error)
    out.push({
      key: 'preview_error',
      role: 'alert',
      message: `Preview problem: ${decodeURIComponent(sp.preview_error)}`,
    });
  if (sp.replace_error)
    out.push({
      key: 'replace_error',
      role: 'alert',
      message: `Couldn't replace the document: ${decodeURIComponent(sp.replace_error)}`,
    });
  if (sp.hide_error)
    out.push({
      key: 'hide_error',
      role: 'alert',
      message: `Couldn't update the viewer: ${decodeURIComponent(sp.hide_error)}`,
    });
  if (sp.attachment_error)
    out.push({
      key: 'attachment_error',
      role: 'alert',
      message: `Attachment problem: ${decodeURIComponent(sp.attachment_error)}`,
    });
  if (sp.replaced === '1')
    out.push({
      key: 'replaced',
      role: 'status',
      message: 'New version saved. All existing share links now serve the latest upload.',
    });
  if (sp.edited)
    out.push({
      key: 'edited',
      role: 'status',
      message: 'Share settings updated. All visitors to this link now see the new rules.',
    });
  if (sp.preview_saved === '1')
    out.push({
      key: 'preview_saved',
      role: 'status',
      message: 'Link preview saved. Chat apps may cache the old card for a while.',
    });
  if (sp.share_deleted === '1')
    out.push({
      key: 'share_deleted',
      role: 'status',
      message: 'Share deleted. The URL now returns Not Found.',
    });
  return out;
}
