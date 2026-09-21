// Two-source config:
//   1. `<script data-*>` attributes — the 90% case, lets people drop a one-liner
//      into their HTML with no inline scripting.
//   2. `window.HTMLRadarConfig` — runtime override, used by the proxy to inject
//      verified email + geo into the page, and by power users who want hooks.
// Runtime values win when both are present.
//
// We deep-merge against DEFAULTS rather than asking callers to specify every
// field. If validation fails (missing required attrs), we return null and the
// boot path bails — no half-running tracker silently consuming events.

import type { TrackerConfig } from './types.js';

// DeepPartial — `Partial<T>` only makes top-level fields optional, which
// forces test/runtime callers to supply every nested field. DeepPartial
// makes the whole tree optional, matching how host pages actually use
// `window.HTMLRadarConfig` (sparse overrides). Function-typed properties
// are passed through untouched — without this guard, hook signatures get
// recursively-partialized into `{}` which then doesn't satisfy the call.
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

declare global {
  interface Window {
    HTMLRadarConfig?: DeepPartial<TrackerConfig> & {
      endpoint?: string;
      shareSlug?: string;
    };
  }
}

const DEFAULTS: Omit<TrackerConfig, 'endpoint' | 'shareSlug'> = {
  sections: {
    // Default is the broadest heading selector. The discover step
    // auto-slugs missing IDs from the heading text, and a fallback
    // layer (see SectionTracker.pickCandidates) widens to slide/page
    // containers when headings are absent. Hosts wanting the old
    // strict behaviour can pass `'h1[id], h2[id], h3[id]'` via
    // window.HTMLRadarConfig.sections.selector.
    selector: 'h1, h2, h3',
    boundaryOffsetPx: 120,
    minDwellMs: 3000,
  },
  session: {
    heartbeatMs: 15000,
    maxSessionMinutes: 120,
  },
  gate: {
    enabled: true,
    brand: { accentColor: '#7A1F2E', backgroundColor: '#FAF5EE' },
    copy: {
      heading: 'Confirm your email to open.',
      subhead: 'The sender wants to know when this document gets read.',
      buttonLabel: 'Open document',
      placeholder: 'you@company.com',
      privacyNote: 'Your email goes to the sender only. Not used for marketing.',
    },
  },
  privacy: { mode: 'email-gated' },
  hooks: {},
  debug: false,
};

export function resolveConfig(scriptEl: HTMLScriptElement | null): TrackerConfig | null {
  const fromAttrs = scriptEl ? readScriptAttrs(scriptEl) : {};
  const fromRuntime = window.HTMLRadarConfig ?? {};

  // Where to report. Explicit when given; otherwise the origin the script
  // itself was loaded from, which for a proxy-served document is the proxy.
  const endpoint = fromRuntime.endpoint ?? fromAttrs.endpoint ?? scriptOrigin(scriptEl);
  const shareSlug = fromRuntime.shareSlug ?? fromAttrs.shareSlug;

  if (!endpoint || !shareSlug) {
    return null;
  }

  const config: TrackerConfig = {
    endpoint,
    shareSlug,
    sections: { ...DEFAULTS.sections, ...(fromRuntime.sections ?? {}) },
    session: { ...DEFAULTS.session, ...(fromRuntime.session ?? {}) },
    gate: {
      ...DEFAULTS.gate,
      ...(fromRuntime.gate ?? {}),
      brand: { ...DEFAULTS.gate.brand, ...(fromRuntime.gate?.brand ?? {}) },
      copy: { ...DEFAULTS.gate.copy, ...(fromRuntime.gate?.copy ?? {}) },
    },
    privacy: { ...DEFAULTS.privacy, ...(fromRuntime.privacy ?? {}) },
    hooks: fromRuntime.hooks ?? {},
    debug: fromRuntime.debug ?? false,
  };
  if (fromRuntime.email) config.email = fromRuntime.email;
  if (fromRuntime.readerId) config.readerId = fromRuntime.readerId;
  if (fromRuntime.geo) config.geo = fromRuntime.geo;
  return config;
}

interface ScriptAttrs {
  endpoint?: string;
  shareSlug?: string;
}

function scriptOrigin(el: HTMLScriptElement | null): string | undefined {
  if (!el?.src) return undefined;
  try {
    const origin = new URL(el.src, window.location.href).origin;
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

function readScriptAttrs(el: HTMLScriptElement): ScriptAttrs {
  const out: ScriptAttrs = {};
  if (el.dataset['endpoint']) out.endpoint = el.dataset['endpoint'];
  if (el.dataset['shareSlug']) out.shareSlug = el.dataset['shareSlug'];
  return out;
}

export { DEFAULTS };
