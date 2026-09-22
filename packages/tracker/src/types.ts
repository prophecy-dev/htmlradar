// Shared types for the HTMLRadar tracker.
// Public types are exported via window.HTMLRadar (see api.ts).

export interface Geo {
  country?: string;
  city?: string;
  deviceType?: string;
  os?: string;
  browser?: string;
}

export interface TrackerConfig {
  // Origin the tracker reports to: POST {endpoint}/t/start_session and
  // /t/update_session. The proxy that served the document, in practice.
  endpoint: string;
  shareSlug: string;

  // If set, the proxy already collected the viewer's email (e.g. allow-list
  // shares enforce gate server-side). The tracker skips its Shadow DOM gate.
  email?: string;

  // The returning-reader identifier, supplied by the proxy from its own
  // first-party cookie on the document's host. Present on every proxy-served
  // document, absent on a directly-embedded tracker — and absent when the
  // reader has opted out, because the proxy then injects no tracker at all.
  //
  // It exists because a proxy-served document runs in an opaque origin, where
  // localStorage throws and the stored fingerprint below is unreachable.
  readerId?: string;

  // Populated by the proxy from Cloudflare's request.cf + parsed UA.
  geo?: Geo;

  sections: {
    selector: string;
    boundaryOffsetPx: number;
    minDwellMs: number;
  };

  session: {
    heartbeatMs: number;
    maxSessionMinutes: number;
  };

  gate: {
    enabled: boolean;
    brand: {
      accentColor: string;
      backgroundColor: string;
    };
    copy: {
      heading: string;
      subhead: string;
      buttonLabel: string;
      placeholder: string;
      privacyNote: string;
    };
  };

  // The reader's comment box. Off unless the proxy turns it on, which it does
  // only on a link that asks for a verified address and only once this reader
  // has proved theirs. Nothing is ever read back: a comment goes to the sender
  // and the reader never sees it, or anyone else's, again.
  comments: {
    enabled: boolean;
    /** Signed by the proxy from the reader's verified cookie; sent back with each comment. */
    proof?: string;
  };

  privacy: {
    mode: 'anonymous' | 'email-gated';
  };

  hooks: {
    onSessionStart?: (info: SessionInfo) => void;
    onSectionEnter?: (info: SectionInfo) => void;
    onSectionRead?: (info: SectionInfo) => void;
    beforeFlush?: (payload: FlushPayload) => FlushPayload | false;
    onFlushError?: (err: Error) => void;
  };

  debug: boolean;
}

export interface SessionInfo {
  sessionId: string;
  documentId: string;
  documentVersion: number;
}

export interface SectionInfo {
  id: string;
  title: string;
  depth: number;
  ordinal: number;
  timeSeconds: number;
}

export interface FlushPayload {
  sessionId: string;
  token: string;
  activeSeconds: number;
  maxScrollDepth: number;
  sections: Array<{
    section_id: string;
    section_title: string;
    depth: number;
    ordinal: number;
    time_seconds: number;
  }>;
}
