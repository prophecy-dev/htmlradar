// The sandbox every response on this worker runs in, in one place.
//
// Omitting allow-same-origin gives a served document an opaque origin: its own
// scripts run, but it cannot reach any cookie or storage of the host it came
// from. That is also why the tracker talks to /t/* cross-origin (text/plain,
// no credentials) — see packages/tracker/src/transport.ts.
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

// The WHOLE policy a response carrying customer HTML gets, as ONE header, so a
// serving path cannot acquire one half of the defence without the other.
//
// form-action 'none' is the credential-harvesting defence: a sign-in page
// uploaded as a document cannot post what a visitor types. NOT for the gate
// and opt-out pages, which are our own forms and post back; those carry the
// sandbox alone (withNoIndex in index.ts).
export const documentCsp = (): string =>
  `sandbox ${FRAME_SANDBOX}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
