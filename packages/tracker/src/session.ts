import type { FlushPayload, SectionInfo, SessionInfo, TrackerConfig } from './types.js';
// v2: viewport-coverage-weighted accumulation.
// One-line rollback: change this import to `./sections-legacy.js`. The
// legacy file ships in the bundle until 2026-05-24 once v2 is stable.
import { SectionTracker } from './sections-v2.js';
import { createTransport, RpcError, type StartSessionResult } from './transport.js';

interface SessionOptions {
  config: TrackerConfig;
  email: string | null;
  fingerprint: string;
  // When the email gate already called start_session (so it could surface
  // server-side rejections in the gate UI), this is the result. Session
  // installs it directly and skips its own RPC — preventing duplicate
  // session rows + duplicate first-read emails.
  preStarted?: StartSessionResult;
}

// Owns the lifecycle: starts the session, runs the heartbeat, tracks scroll
// depth + active time, flushes on visibility-hidden / pagehide.
//
// The flushing mutex is the answer to audit F-11: heartbeat and unload
// handlers can race; without a mutex we get duplicate UPSERTs. With the
// mutex (+ the DB-side `unique(session_id, section_id)`), they queue.
export class Session {
  private readonly opts: SessionOptions;
  private readonly transport: ReturnType<typeof createTransport>;
  private readonly sections: SectionTracker;

  private info: SessionInfo | null = null;
  private token: string | null = null;

  private activeMs = 0;
  private activeRunningSince: number | null = null;
  // Idle watchdog at the session level. If the reader shows no sign of
  // presence for this long, session active_time stops accumulating even
  // if the tab is foregrounded. Without this, "reading time" inflated
  // when the reader left the tab open and walked away.
  private lastActivityMs: number = performance.now();
  private maxScroll = 0;
  // Active milliseconds already handed to the section tracker. The
  // section tracker owns no clock of its own; it spends what this one
  // credits (see consumeActiveMs), so section totals can never exceed
  // the session's active time.
  private consumedMs = 0;

  private heartbeatTimer: number | null = null;
  private maxSessionTimer: number | null = null;

  private flushing = false;
  // A flush asked for while another was in flight. The old code dropped
  // it, which meant the LAST report — the one sent on hide, carrying the
  // final figures — was exactly the one a slow heartbeat could lose.
  private pendingFlush: { keepalive: boolean } | null = null;
  private dirty = false;
  private rafScrollScheduled = false;
  private boundCount = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.transport = createTransport({ endpoint: opts.config.endpoint });
    this.sections = new SectionTracker({
      selector: opts.config.sections.selector,
      boundaryOffsetPx: opts.config.sections.boundaryOffsetPx,
      minDwellMs: opts.config.sections.minDwellMs,
      consumeActiveMs: (nowMs) => this.consumeActiveMs(nowMs),
      ...(opts.config.hooks.onSectionEnter
        ? { onSectionEnter: opts.config.hooks.onSectionEnter }
        : {}),
      ...(opts.config.hooks.onSectionRead
        ? { onSectionRead: opts.config.hooks.onSectionRead }
        : {}),
    });
  }

  async start(): Promise<SessionInfo | null> {
    // ---------------------------------------------------------------
    // Bot / accidental-tap filter
    // ---------------------------------------------------------------
    // When the email gate already created a session server-side (the
    // recipient typed an email + clicked Continue — a strong "real
    // human" signal), there's no warm-up wait: we install the
    // pre-started session immediately.
    //
    // For every OTHER path — anonymous shares, allow-listed pre-auth,
    // returning recipients with localStorage'd email — we hold for 5s
    // before creating the session row. If the recipient bounced or
    // backgrounded the tab during the wait, we skip session creation
    // entirely. Stops link-preview crawlers, accidental clicks, and
    // 1-second mis-opens from inflating viewer counts and triggering
    // owner-notification emails.
    //
    // Listener binding is deferred until AFTER the warm-up so a bounce
    // during the wait leaves nothing to clean up.
    if (!this.opts.preStarted) {
      if (document.hidden) return null;
      // Was the page visible for the WHOLE warm-up, not just at both
      // ends? Only then are the warm-up seconds real reading seconds.
      let hiddenDuringWarmUp = false;
      const watchWarmUp = (): void => {
        if (document.hidden) hiddenDuringWarmUp = true;
      };
      document.addEventListener('visibilitychange', watchWarmUp);
      await new Promise<void>((resolve) => setTimeout(resolve, Session.WARM_UP_MS));
      document.removeEventListener('visibilitychange', watchWarmUp);
      if (document.hidden) return null;
      // Credit the warm-up back. The reader was looking at the document
      // during those seconds; the wait exists to filter crawlers and
      // mis-taps, not to shorten the reading time of everyone who stays.
      // A visit that never gets this far is still recorded as nothing.
      if (!hiddenDuringWarmUp) {
        this.activeMs = Session.WARM_UP_MS;
        // Not spendable by the section tracker: no section was being
        // sampled yet, so those seconds stay unattributed.
        this.consumedMs = Session.WARM_UP_MS;
        this.dirty = true;
      }
    }

    if (!document.hidden) {
      const now = performance.now();
      // Start the idle window here, not at construction. `lastActivityMs`
      // is stamped in its field initialiser, and the warm-up above waits
      // exactly IDLE_THRESHOLD_MS — so without this the clock began
      // already past its own deadline and credited nothing until the
      // reader's first event. sections-v2 stamps its watchdog in start()
      // for the same reason; now both agree on when a session begins.
      this.lastActivityMs = now;
      this.activeRunningSince = now;
    }
    this.bindListeners();
    this.sections.start();
    this.updateMaxScroll();

    const result =
      this.opts.preStarted ??
      (await this.transport.startSession({
        shareSlug: this.opts.config.shareSlug,
        email: this.opts.email,
        fingerprint: this.opts.fingerprint,
        referrer: document.referrer ?? '',
        userAgent: navigator.userAgent ?? '',
        ...(this.opts.config.geo ? { geo: this.opts.config.geo } : {}),
      }));

    this.info = {
      sessionId: result.sessionId,
      documentId: result.documentId,
      documentVersion: result.documentVersion,
    };
    this.token = result.token;

    this.startTimers();
    if (this.opts.config.hooks.onSessionStart) {
      this.opts.config.hooks.onSessionStart(this.info);
    }
    return this.info;
  }

  async flush(keepalive = false): Promise<void> {
    if (!this.info || !this.token) return;
    if (this.flushing) {
      // Queue it instead of dropping it, and keep the keep-alive flag if
      // either call asked for one: the queued report is re-read from the
      // live counters when it runs, so it carries the fuller figures.
      this.pendingFlush = { keepalive: keepalive || (this.pendingFlush?.keepalive ?? false) };
      return;
    }
    this.flushing = true;
    try {
      this.tickActive(performance.now());
      // Poll scroll position on every flush. The scroll-listener path
      // covers normal scrolling, but smooth-scroll libraries and mobile
      // momentum scrolls sometimes leave events un-fired while position
      // does change — polling here makes max_scroll_depth eventually
      // consistent with reality regardless of event firing.
      this.updateMaxScroll();
      const sections: SectionInfo[] = this.sections.snapshot();
      if (sections.length === 0 && !this.dirty) {
        // Nothing changed and no sections to send.
        return;
      }
      const payload: FlushPayload = {
        sessionId: this.info.sessionId,
        token: this.token,
        activeSeconds: Math.round(this.activeMs / 1000),
        maxScrollDepth: this.maxScroll,
        sections: sections.map((s) => ({
          section_id: s.id,
          section_title: s.title,
          depth: s.depth,
          ordinal: s.ordinal,
          time_seconds: s.timeSeconds,
        })),
      };
      const transformed = this.opts.config.hooks.beforeFlush?.(payload) ?? payload;
      if (transformed === false) return;
      // Clear the flag BEFORE the request, not after: anything credited
      // while this one is in flight — the seconds the hide handler books,
      // above all — must leave the session dirty so the queued report
      // still goes out. Marking it clean afterwards silently swallowed
      // the last update.
      this.dirty = false;
      await this.transport.updateSession(transformed, keepalive);
    } catch (err) {
      this.dirty = true;
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.opts.config.debug) {
        // eslint-disable-next-line no-console
        console.warn('[HTMLRadar] flush failed', error);
      }
      this.opts.config.hooks.onFlushError?.(error);
      if (err instanceof RpcError && err.code === 'P0010') {
        // Invalid token — session no longer valid; stop trying.
        this.stop();
      }
    } finally {
      this.flushing = false;
      const queued = this.pendingFlush;
      this.pendingFlush = null;
      if (queued) await this.flush(queued.keepalive);
    }
  }

  stop(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.maxSessionTimer !== null) {
      clearTimeout(this.maxSessionTimer);
      this.maxSessionTimer = null;
    }
    this.sections.stop();
    this.unbindListeners();
  }

  // --- internals ---

  private startTimers(): void {
    this.heartbeatTimer = window.setInterval(
      () => void this.flush(),
      this.opts.config.session.heartbeatMs,
    );
    this.maxSessionTimer = window.setTimeout(
      () => this.stop(),
      this.opts.config.session.maxSessionMinutes * 60_000,
    );
  }

  private bindListeners(): void {
    if (this.boundCount > 0) return;
    this.boundCount = 1;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    // Page-lifecycle stops. `freeze` is Chrome discarding a background
    // tab; `pageshow` with persisted=true is the same page coming back
    // out of the back-forward cache, where every clock we hold is stale
    // by however long the reader was away. `beforeprint` covers the
    // print dialog: the document is on screen but nobody is reading it.
    document.addEventListener('freeze', this.onFreeze);
    document.addEventListener('resume', this.onResume);
    window.addEventListener('pageshow', this.onPageShow);
    window.addEventListener('beforeprint', this.onFreeze);
    window.addEventListener('afterprint', this.onResume);
    // Capture, not bubble: a scroll event on an inner scroll container does
    // not bubble, so a bubble-phase window listener never sees a document
    // that scrolls a panel instead of the page. Capture runs from the
    // window down and catches both.
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    // Presence inputs. A wheel notch, a touch, a key or a click is a
    // person; so is a throttled mousemove, for a reader holding still on
    // a page that does not scroll. Scroll itself is NOT here — see
    // onScroll. Capture, so input inside an inner panel counts too.
    window.addEventListener('keydown', this.onActivity, { passive: true, capture: true });
    window.addEventListener('touchstart', this.onActivity, { passive: true, capture: true });
    window.addEventListener('mousedown', this.onActivity, { passive: true, capture: true });
    window.addEventListener('wheel', this.onActivity, { passive: true, capture: true });
    window.addEventListener('mousemove', this.onMouseMove, { passive: true, capture: true });
  }

  private unbindListeners(): void {
    if (this.boundCount === 0) return;
    this.boundCount = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('freeze', this.onFreeze);
    document.removeEventListener('resume', this.onResume);
    window.removeEventListener('pageshow', this.onPageShow);
    window.removeEventListener('beforeprint', this.onFreeze);
    window.removeEventListener('afterprint', this.onResume);
    window.removeEventListener('scroll', this.onScroll, { capture: true });
    window.removeEventListener('keydown', this.onActivity, { capture: true });
    window.removeEventListener('touchstart', this.onActivity, { capture: true });
    window.removeEventListener('mousedown', this.onActivity, { capture: true });
    window.removeEventListener('wheel', this.onActivity, { capture: true });
    window.removeEventListener('mousemove', this.onMouseMove, { capture: true });
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.pauseClocks();
      // Keep-alive: the tab may be closing rather than merely hiding,
      // and this report is the one that carries the final figures.
      void this.flush(true);
    } else {
      this.resumeClocks();
    }
  };

  private onPageHide = (): void => {
    this.pauseClocks();
    void this.flush(true);
  };

  // Frozen tab, or an open print dialog: the clocks stop, nothing is
  // sent (a frozen page cannot complete a request anyway).
  private onFreeze = (): void => {
    this.pauseClocks();
  };

  private onResume = (): void => {
    if (!document.hidden) this.resumeClocks();
  };

  // Restored from the back-forward cache. Same session, same row — we
  // never start a second one — but every timestamp we hold predates the
  // absence, so the clocks restart from now.
  private onPageShow = (e: PageTransitionEvent): void => {
    if (!e.persisted) return;
    if (document.hidden) {
      this.pauseClocks();
      return;
    }
    this.resumeClocks();
  };

  private pauseClocks(): void {
    this.tickActive(performance.now());
    this.activeRunningSince = null;
    this.sections.pause();
  }

  private resumeClocks(): void {
    const now = performance.now();
    // Coming back to the document IS a sign of presence — the reader
    // chose this tab — so the allowance starts fresh from this moment.
    this.lastActivityMs = now;
    this.activeRunningSince = now;
    this.sections.resume();
  }

  // Scroll is a POSITION signal only, never a sign of presence: a
  // browser marks a script's `scrollTo` as trusted exactly like a
  // human's, so an auto-advancing carousel would read as a reader.
  // Real human scrolling always arrives with wheel, touchstart or
  // keydown alongside it, and those renew the allowance.
  private onScroll = (e: Event): void => {
    // A scroll on an inner element (a deck whose slides scroll inside a
    // 100vh `.deck` container, with the window itself never moving) makes
    // that element the one depth is measured against, if it scrolls further
    // than whatever was measured before.
    const t = e.target;
    if (t instanceof Element && scrollRange(t) > (this.scrollEl ? scrollRange(this.scrollEl) : 0)) {
      this.scrollEl = t;
    }
    if (this.rafScrollScheduled) return;
    this.rafScrollScheduled = true;
    requestAnimationFrame(() => {
      this.rafScrollScheduled = false;
      this.updateMaxScroll();
    });
  };

  // mousemove fires per pixel of travel; one bump a second is all the
  // watchdog can use, so the other few hundred are dropped before they
  // touch anything.
  private lastMoveBumpMs = 0;
  private onMouseMove = (e: Event): void => {
    const now = performance.now();
    if (now - this.lastMoveBumpMs < 1_000) return;
    this.lastMoveBumpMs = now;
    this.onActivity(e);
  };

  // Renews the reading allowance. Only genuine human input gets here:
  // keydown, touchstart, mousedown, wheel and throttled mousemove, and
  // only when the browser marks the event as trusted. An event a script
  // dispatched — an auto-advancing deck, a media player, a document that
  // rewrites itself — is not a reader, so it renews nothing.
  private onActivity = (e?: Event): void => {
    if (e && e.isTrusted === false) return;
    const now = performance.now();
    // Credit what was earned under the OLD deadline before moving it.
    // Input that arrives after the allowance expired but before the next
    // routine update would otherwise back-date the whole silent gap into
    // reading time — a small error at five seconds, a large one at thirty.
    this.tickActive(now);
    this.lastActivityMs = now;
    if (this.activeRunningSince === null && typeof document !== 'undefined' && !document.hidden) {
      this.activeRunningSince = now;
    }
  };

  // Hands the section tracker the active milliseconds credited since it
  // last asked. It has no clock of its own, so whatever it attributes to
  // sections is a share of this number and never more than it.
  private consumeActiveMs(nowMs: number): number {
    this.tickActive(nowMs);
    const unspent = this.activeMs - this.consumedMs;
    this.consumedMs = this.activeMs;
    return unspent;
  }

  // The element that scrolls instead of the window, on documents built that
  // way (see onScroll and findScrollContainer). Null while the window is the
  // scroller, which is the ordinary case.
  private scrollEl: Element | null = null;
  private scrollElSearched = false;

  private updateMaxScroll(): void {
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (docHeight <= 0 && !this.scrollEl && !this.scrollElSearched) {
      this.scrollElSearched = true;
      this.scrollEl = findScrollContainer();
    }
    if (docHeight <= 0 && this.scrollEl) {
      const range = scrollRange(this.scrollEl);
      if (range > 0) {
        const ratio = Math.max(0, Math.min(1, this.scrollEl.scrollTop / range));
        if (ratio > this.maxScroll) {
          this.maxScroll = ratio;
          this.dirty = true;
        }
        return;
      }
    }
    if (docHeight <= 0) {
      // Single-viewport doc — they saw all of it.
      if (this.maxScroll < 1) {
        this.maxScroll = 1;
        this.dirty = true;
      }
      return;
    }
    // Robust scroll-position read: some mobile browsers / smooth-scroll
    // libraries (Lenis) leave `window.scrollY` stale while
    // `documentElement.scrollTop` updates, and vice versa on iOS Safari
    // during momentum scrolls. Take the larger of the two so we don't
    // silently report 0% on a deck where one of them isn't moving.
    const scrolledPx = Math.max(
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    const ratio = Math.max(0, Math.min(1, scrolledPx / docHeight));
    if (ratio > this.maxScroll) {
      this.maxScroll = ratio;
      this.dirty = true;
    }
  }

  // Session-level active-time accumulator with idle watchdog.
  //
  // The reader's active_time only advances while BOTH of:
  //   - the tab is visible (handled in pauseClocks — when hidden,
  //     activeRunningSince is set to null and this method no-ops)
  //   - they showed a sign of presence in the last IDLE_THRESHOLD_MS
  //     (handled here by capping the elapsed window at
  //     lastActivityMs + IDLE_THRESHOLD_MS)
  //
  // Thirty seconds, not five. Five came from news-site analytics,
  // where readers scroll constantly; people read a deck or a proposal
  // with their hands still, and across 151 ordinary visits we recorded
  // 36 seconds of a 152-second visit. Thirty is the allowance a silent
  // reader gets before we stop believing they are there; a reader who
  // walks away therefore costs us at most thirty seconds of error.
  private static readonly IDLE_THRESHOLD_MS = 30_000;

  // The bot / mis-tap warm-up at the top of start(), and the amount
  // credited back once the session proves real.
  private static readonly WARM_UP_MS = 5_000;

  private tickActive(nowMs: number): void {
    if (this.activeRunningSince === null) return;
    const idleAt = this.lastActivityMs + Session.IDLE_THRESHOLD_MS;
    // Cap the credited window at the moment the user went idle.
    // If they were active throughout, effectiveNow === nowMs.
    const effectiveNow = Math.min(nowMs, idleAt);
    const elapsed = effectiveNow - this.activeRunningSince;
    if (elapsed > 0) {
      this.activeMs += elapsed;
      this.dirty = true;
    }
    if (nowMs <= idleAt) {
      // Still active — keep accumulating from here.
      this.activeRunningSince = nowMs;
    } else {
      // Idle — pause accumulation. onActivity will restart it when
      // the reader interacts again.
      this.activeRunningSince = null;
    }
  }
}

/** How far an element can scroll vertically, in pixels. */
function scrollRange(el: Element): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * On a document whose window does not scroll, the element that does: the
 * largest vertically scrollable box that fills at least half the viewport.
 * Decks built as a `100vh` scroll-snap container look exactly like this, and
 * measuring depth against the window would report every one of them as fully
 * read the moment it loads. Null when nothing qualifies — a genuinely
 * single-screen document.
 */
export function findScrollContainer(root: ParentNode = document): Element | null {
  const minHeight = (window.innerHeight || 0) / 2;
  let best: Element | null = null;
  let bestRange = 0;
  const all = root.querySelectorAll('body *');
  // Bounded: this runs once, and only on a document whose window did not scroll.
  const limit = Math.min(all.length, 5000);
  for (let i = 0; i < limit; i++) {
    const el = all[i]!;
    const range = scrollRange(el);
    if (range <= bestRange || el.clientHeight < minHeight) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
    best = el;
    bestRange = range;
  }
  return best;
}
