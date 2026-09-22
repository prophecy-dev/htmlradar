import type { FlushPayload, Geo } from './types.js';

// The tracker's calls, to the proxy worker that served the document:
//   POST {endpoint}/t/start_session
//   POST {endpoint}/t/update_session
//   POST {endpoint}/t/comment
// Same request bodies and P-code errors the Postgres RPCs used, so the gate's
// messages still map (see humanError in index.ts).
//
// text/plain, not application/json: a proxy-served document runs in an
// opaque (sandboxed) origin, so every call is cross-origin. A text/plain POST
// is a "simple" request with no CORS preflight, which also keeps the
// keep-alive report on unload working in browsers that refuse keepalive with
// a preflight. The worker parses the body as JSON regardless.

export interface RpcOptions {
  endpoint: string;
}

export interface StartSessionInput {
  shareSlug: string;
  email: string | null;
  fingerprint: string | null;
  referrer: string;
  userAgent: string;
  geo?: Geo;
}

export interface StartSessionResult {
  sessionId: string;
  token: string;
  documentId: string;
  documentVersion: number;
}

export interface CommentInput {
  sessionId: string;
  token: string;
  sectionId: string | null;
  sectionTitle: string | null;
  body: string;
}

export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function createTransport(opts: RpcOptions) {
  const rpcUrl = (name: string) => `${opts.endpoint.replace(/\/+$/, '')}/t/${name}`;

  async function call(rpc: string, body: object, keepalive = false): Promise<unknown> {
    const res = await fetch(rpcUrl(rpc), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      credentials: 'omit',
      body: JSON.stringify(body),
      keepalive,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = extractCode(text) ?? `http_${res.status}`;
      throw new RpcError(code, text || res.statusText, res.status);
    }
    return res.status === 204 ? null : await res.json();
  }

  async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const result = (await call('start_session', {
      p_share_slug: input.shareSlug,
      p_email: input.email,
      p_fingerprint: input.fingerprint,
      p_referrer: input.referrer,
      p_user_agent: input.userAgent,
      p_country_code: input.geo?.country ?? null,
      p_city: input.geo?.city ?? null,
      p_device_type: input.geo?.deviceType ?? null,
      p_os: input.geo?.os ?? null,
      p_browser: input.geo?.browser ?? null,
    })) as {
      session_id: string;
      token: string;
      document_id: string;
      document_version: number;
    };
    return {
      sessionId: result.session_id,
      token: result.token,
      documentId: result.document_id,
      documentVersion: result.document_version,
    };
  }

  async function updateSession(payload: FlushPayload, keepalive = false): Promise<void> {
    await call(
      'update_session',
      {
        p_session_id: payload.sessionId,
        p_token: payload.token,
        p_active_seconds: payload.activeSeconds,
        p_max_scroll: payload.maxScrollDepth,
        p_sections: payload.sections,
      },
      keepalive,
    );
  }

  // Never keep-alive: a comment is sent from a click the reader is watching,
  // and they are shown whether it arrived.
  async function comment(input: CommentInput): Promise<void> {
    await call('comment', {
      p_session_id: input.sessionId,
      p_token: input.token,
      p_section_id: input.sectionId,
      p_section_title: input.sectionTitle,
      p_body: input.body,
    });
  }

  return { startSession, updateSession, comment };
}

function extractCode(body: string): string | null {
  // The worker answers a refusal with `{ code: 'P0001', message: 'rate_limited' }`, the
  // same shape PostgREST used. Don't depend on a particular shape, so try a few.
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    if (parsed.code) return parsed.code;
    if (parsed.message) {
      const match = /P\d{4}/.exec(parsed.message);
      if (match) return match[0];
    }
  } catch {
    // ignore, fall through
  }
  return null;
}
