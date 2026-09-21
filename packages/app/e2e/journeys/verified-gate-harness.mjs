// The local harness journey 11 runs against, and the reason journey 11 is the
// one golden journey that never touches production.
//
// WHY IT EXISTS. J1 to J10 run against the real application, the real proxy on
// htmlradar.page and the real Supabase, because what they guard is what a
// customer's data actually does. J11 cannot: the migration the verified e-mail
// gate needs (schema/055_verified_email_gate.sql) has deliberately not been
// applied, and the worker that reads it has not been deployed. So this file
// stands up a production-style copy of the worker on this machine — the real
// `packages/proxy` bundle under `wrangler dev`, not a mock of it — with every
// upstream it talks to pointed at one stub process.
//
// THE MAIL-SINK RULE, AND HOW THIS FILE HONOURS IT. README.md ("Accounts, and
// why they are mail sinks") says the journeys must never be able to put a
// message in a real person's inbox: owner accounts live on a sink domain, and
// readers live on example.com, which RFC 2606 reserves and which reaches
// nobody. The verified gate is the first thing in the product that mails a
// READER, so this file closes the question by construction rather than by
// configuration. The worker's RESEND_API_URL is pointed at the stub below, the
// stub keeps the message in an array, and NO MESSAGE EVER LEAVES THIS PROCESS.
// There is no credential here that could reach Resend even if the address were
// changed, and the reader addresses in the journey are on example.com anyway.
//
// WHAT THE STUB IS A STUB OF. Exactly the requests packages/proxy/src makes:
// the handful of PostgREST reads in supabase.ts, the two verified-gate RPCs,
// and the provider endpoint in mail.ts. The two RPCs are the interesting half —
// they mirror schema/055's functions (ten minutes, single use, five attempts,
// bound to link + address + browser challenge, and the three issue limits), so
// the worker's branches are driven by the same answers real Postgres gives.
// It is a mirror, so it cannot prove the SQL; schema/tests/055_*_test.sql does
// that, and packages/proxy/tests/verified-gate.test.ts proves the worker's
// branches. What only a browser can prove is what this harness is for: cookies,
// forms, and two browsers that cannot borrow each other's code.

/* eslint-env node */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createSocketServer } from 'node:net';
import { existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_DIR = path.resolve(__dirname, '../../../proxy');
const DEV_VARS = path.join(PROXY_DIR, '.dev.vars');
// `.dev.vars` and `.wrangler/` are both in the repository's .gitignore, so
// nothing this harness writes can be committed by accident.
const PERSIST_DIR = path.join(PROXY_DIR, '.wrangler', 'j11-state');

/** The address the link permits. example.com is RFC 2606 and reaches nobody. */
export const PERMITTED = 'buyer@example.com';
/** An address the link does not permit. Same domain, same reason. */
export const STRANGER = 'stranger@example.com';

export const SLUG = 'j11-verified-gate';
/** What the document says once a reader is through the gate. */
export const DOC_HEADING = 'Behind the verified gate';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const R2_BUCKET = 'htmlradar-docs';
const R2_KEY = 'j11/deck.html';
const DOC_TITLE = 'golden-journey j11 deck';

const DECK_HTML =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${DOC_TITLE}</title></head>` +
  `<body><h1>${DOC_HEADING}</h1><p>Only a reader who proved their address sees this.</p></body></html>`;

const defaultShare = () => ({
  id: SHARE_ID,
  slug: SLUG,
  document_id: DOC_ID,
  owner_id: OWNER_ID,
  recipient_label: 'golden j11 buyer',
  require_email: true,
  require_password: false,
  verify_email: true,
  allowed_email_domains: null,
  allowed_emails: [PERMITTED],
  lock_deck: false,
  expires_at: null,
  revoked_at: null,
  host_handle: null,
  owner_handle: null,
  owner_tier: 'pro',
  owner_display_name: 'Dana Sender',
  owner_email: 'dana@example.com',
  document_title: DOC_TITLE,
  custom_domain_id: null,
  custom_domain_hostname: null,
  custom_domain_state: null,
  custom_domain_owner_id: null,
});

const documentRow = {
  id: DOC_ID,
  owner_id: OWNER_ID,
  title: DOC_TITLE,
  source_type: 'upload',
  source_url: null,
  current_version: 1,
  r2_key: R2_KEY,
  deleted_at: null,
};

// The stub's whole world. `codes` is email_verification_codes; `mail` is every
// message the worker tried to send.
const state = {
  share: defaultShare(),
  /** @type {Array<{shareId:string,email:string,codeHash:string,challenge:string,ipHash:string|null,created:number,expires:number,attempts:number,used:boolean}>} */
  codes: [],
  /** @type {Array<{to:string[],subject:string,text:string,html:string}>} */
  mail: [],
  mailFails: false,
};

// ── the two RPCs, mirroring schema/055 ──────────────────────────────────────
//
// Read 055's `issue_email_verification_code` beside this. The order of the
// checks is the order of the SQL, and the three limits are its three limits:
// three per address per link per fifteen minutes, five per address per hour
// across every link, twenty per network address per hour. The advisory lock it
// takes has no counterpart here and needs none — this process answers one
// request at a time, which is the serialisation the lock buys in Postgres.
//
// It does NOT decide whether the address is allowed, exactly as the SQL does
// not. That decision is the worker's, and the worker calls this either way so
// that a permitted and a non-permitted address cost the same.
function issueCode({
  p_share_id,
  p_email,
  p_code_hash,
  p_challenge,
  p_ip_hash,
  p_permitted = true,
}) {
  const email = String(p_email ?? '')
    .trim()
    .toLowerCase();
  const share = state.share;
  if (!share || share.id !== p_share_id) return 'no_share';
  if (!share.verify_email || !share.require_email) return 'not_enabled';
  if (share.revoked_at || (share.expires_at && Date.parse(share.expires_at) < Date.now())) {
    return 'no_share';
  }

  const now = Date.now();
  // Astra's finding 5: a request for an address the link does not permit is
  // recorded so the network ceiling counts it, but spends none of that
  // address's own budget — five requests from anybody must not be able to lock
  // a named reader out of a link they were never sent.
  const counted = state.codes.filter((r) => r.countsTowardAddress);
  const perLink = counted.filter(
    (r) => r.shareId === p_share_id && r.email === email && r.created > now - 15 * 60_000,
  ).length;
  const perAddress = counted.filter(
    (r) => r.email === email && r.created > now - 60 * 60_000,
  ).length;
  if (p_permitted && (perLink >= 3 || perAddress >= 5)) return 'rate_limited';
  if (p_ip_hash) {
    const perNetwork = state.codes.filter(
      (r) => r.ipHash === p_ip_hash && r.created > now - 60 * 60_000,
    ).length;
    if (perNetwork >= 20) return 'rate_limited';
  }

  // One live code per browser: a new code retires whatever this browser was
  // still holding for the same link and address.
  for (const row of state.codes) {
    if (
      row.shareId === p_share_id &&
      row.email === email &&
      row.challenge === p_challenge &&
      !row.used &&
      row.expires > now
    ) {
      row.expires = now;
    }
  }

  state.codes.push({
    countsTowardAddress: p_permitted,
    shareId: p_share_id,
    email,
    codeHash: p_code_hash,
    challenge: p_challenge,
    ipHash: p_ip_hash ?? null,
    created: now,
    expires: now + 10 * 60_000,
    attempts: 0,
    used: false,
  });
  return 'ok';
}

// `check_email_verification_code`. The selector is the SQL's selector, and the
// attempt is spent before the comparison is trusted, so five wrong guesses
// leave `attempts` at five and the sixth request matches no row at all — the
// code is dead although it has neither expired nor been used. Every way of
// being wrong returns the same word, as it does in the database.
function checkCode({ p_share_id, p_email, p_code_hash, p_challenge }) {
  const email = String(p_email ?? '')
    .trim()
    .toLowerCase();
  const now = Date.now();
  const row = [...state.codes]
    .reverse()
    .find(
      (r) =>
        r.shareId === p_share_id &&
        r.email === email &&
        r.challenge === p_challenge &&
        !r.used &&
        r.expires > now &&
        r.attempts < 5,
    );
  if (!row) return 'bad';
  row.attempts += 1;
  if (row.codeHash !== p_code_hash) return 'bad';
  row.used = true;
  return 'ok';
}

// ── the stub server ─────────────────────────────────────────────────────────

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });

async function route(req, url, body) {
  const json = () => (body ? JSON.parse(body) : {});

  // PostgREST, as packages/proxy/src/supabase.ts asks for it.
  // share_lookup_for, the function the worker calls INSTEAD of the view, and
  // the interlock behind it (Astra, finding 3): the plain view no longer
  // contains a verified share at all, so a worker that does not declare it
  // enforces verification finds nothing. Mirrored here so the journey exercises
  // the same refusal the database performs.
  if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/share_lookup_for') {
    const { p_slug: wanted, p_supports_verification: supports } = json();
    if (wanted !== state.share.slug) return [200, []];
    if (state.share.verify_email && supports !== true) return [200, []];
    return [200, [state.share]];
  }
  // The view itself, kept so a test can prove an OLD worker gets nothing.
  if (req.method === 'GET' && url.pathname === '/rest/v1/share_lookup') {
    const wanted = (url.searchParams.get('slug') ?? '').replace(/^eq\./, '');
    const hit = wanted === state.share.slug && !state.share.verify_email;
    return [200, hit ? [state.share] : []];
  }
  if (req.method === 'GET' && url.pathname === '/rest/v1/documents') {
    return [200, [documentRow]];
  }
  if (req.method === 'GET' && url.pathname === '/rest/v1/document_attachments') return [200, []];
  if (req.method === 'GET' && url.pathname === '/rest/v1/custom_domains') return [200, []];
  if (req.method === 'POST' && url.pathname === '/rest/v1/app_events') return [201, null];
  if (url.pathname === '/rest/v1/rpc/issue_email_verification_code') {
    return [200, issueCode(json())];
  }
  if (url.pathname === '/rest/v1/rpc/check_email_verification_code') {
    return [200, checkCode(json())];
  }

  // THE MAIL SINK. Nothing here opens a socket to a provider.
  if (req.method === 'POST' && url.pathname === '/emails') {
    if (state.mailFails) return [500, { message: 'stub refused the message' }];
    state.mail.push(json());
    return [200, { id: 'stub' }];
  }
  // The tracker bundle the served document asks its own host for. The worker
  // fetches TRACKER_URL to answer it; a real one would record reading time
  // against Supabase, which is not what this journey is about.
  if (req.method === 'GET' && url.pathname === '/tracker.js') return [200, '/* j11 no-op */'];

  if (req.method === 'GET' && url.pathname === '/__mail') return [200, state.mail];
  if (req.method === 'POST' && url.pathname === '/__mail/fail') {
    state.mailFails = true;
    return [200, { mailFails: true }];
  }
  if (req.method === 'POST' && url.pathname === '/__mail/ok') {
    state.mailFails = false;
    return [200, { mailFails: false }];
  }

  return [404, { message: `no stub route for ${req.method} ${url.pathname}` }];
}

// ── starting and stopping ───────────────────────────────────────────────────

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** One GET against the worker, ignoring its self-signed development certificate. */
const ping = (port) =>
  new Promise((resolve) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path: '/robots.txt', rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.end();
  });

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROXY_DIR, env: { ...process.env, CI: 'true' } });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed:\n${err}`)),
    );
  });

let harness = null;

/**
 * Brings up the stub and a production-style `wrangler dev` pointed at it.
 *
 * Resolves with the worker's base URL and the in-process controls the journey
 * uses. Throws with wrangler's own stderr if the worker will not start, because
 * a harness that fails silently turns into a journey that fails mysteriously.
 */
export async function startHarness() {
  if (harness) return harness;

  const stubPort = await freePort();
  const stubUrl = `http://127.0.0.1:${stubPort}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url, stubUrl);
    readBody(req)
      .then((body) => route(req, url, body))
      .then(([status, payload]) => {
        // A scalar RPC comes back from PostgREST as a bare JSON value — the
        // string "ok", not {"result":"ok"} — and supabase.ts compares against
        // exactly that.
        const text = payload === null ? '' : JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      })
      .catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: String(e) }));
      });
  });
  await new Promise((resolve) => server.listen(stubPort, '127.0.0.1', resolve));
  // Chosen only once the stub is holding its own port, so the two can never be
  // handed the same one.
  const workerPort = await freePort();

  // The document itself. `wrangler dev` runs the worker locally with a local
  // R2, so the deck has to be put there the way the application would have put
  // it there — through the binding, not through a mocked fetch.
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  writeFileSync(path.join(PROXY_DIR, '.j11-deck.html'), DECK_HTML);
  await run('npx', [
    'wrangler',
    'r2',
    'object',
    'put',
    `${R2_BUCKET}/${R2_KEY}`,
    '--file',
    '.j11-deck.html',
    '--content-type',
    'text/html',
    '--local',
    '--persist-to',
    PERSIST_DIR,
  ]);
  unlinkSync(path.join(PROXY_DIR, '.j11-deck.html'));

  // Every upstream, pointed at the stub. `.dev.vars` rather than a wall of
  // --var flags: it is the file wrangler already reads for exactly this, and it
  // is gitignored. A developer's own copy is moved aside and put back.
  if (existsSync(DEV_VARS)) renameSync(DEV_VARS, `${DEV_VARS}.j11-backup`);
  writeFileSync(
    DEV_VARS,
    [
      `SUPABASE_URL=${stubUrl}`,
      'SUPABASE_SERVICE_ROLE_KEY=j11-service-role',
      'SUPABASE_ANON_KEY=j11-anon',
      'SESSION_SECRET=j11-session-secret',
      `TRACKER_URL=${stubUrl}/tracker.js`,
      'SHARE_HOST=localhost',
      'LEGACY_HOSTS=',
      'RESEND_API_KEY=j11-resend-key',
      'RESEND_FROM="HTMLRadar <hello@htmlradar.com>"',
      `RESEND_API_URL=${stubUrl}/emails`,
      // The gate's timing floor exists so a refused address and a permitted one
      // leave at the same moment on the clock. It has no meaning off the public
      // internet, and it would cost this journey 1.2 seconds on every gate post.
      'GATE_FLOOR_MS=0',
      '',
    ].join('\n'),
  );

  // https, because every cookie the gate sets is `Secure` and two of them carry
  // the `__Host-` prefix. The certificate is self-signed, which is what
  // `ignoreHTTPSErrors` in the journey's browser context is for.
  const worker = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local-protocol',
      'https',
      '--ip',
      '127.0.0.1',
      '--port',
      String(workerPort),
      // WITHOUT THIS THE WORKER DOES NOT SEE A LOCAL HOSTNAME AT ALL. wrangler
      // dev rewrites the request's host to the zone of the first route in
      // wrangler.toml, so the worker believed every request arrived on
      // htmlradar.page, took the customer-domain branch of resolveHost and
      // answered 500 on a hostname no stub could satisfy. Naming the dev
      // address here — with its port, so the origin the worker computes is the
      // origin the browser posts from — makes isLocal() true, which is the
      // apex, and keeps the origin check in isOwnGatePost honest.
      '--local-upstream',
      `127.0.0.1:${workerPort}`,
      '--persist-to',
      PERSIST_DIR,
      '--log-level',
      'warn',
    ],
    {
      cwd: PROXY_DIR,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group. `npx` is a shim that spawns wrangler, which
      // spawns workerd, and a signal to the shim alone leaves the other two
      // running — a stray worker holding a port after the run is exactly the
      // kind of thing that makes the NEXT run fail mysteriously.
      detached: true,
    },
  );
  let workerErr = '';
  worker.stderr.on('data', (d) => {
    workerErr += d;
  });
  worker.stdout.on('data', (d) => {
    workerErr += d;
  });
  let dead = false;
  worker.on('exit', () => {
    dead = true;
  });

  harness = {
    worker,
    server,
    /** What the journey navigates to. */
    baseUrl: `https://127.0.0.1:${workerPort}`,
    stubUrl,
    slug: SLUG,
    /** Clears the codes and the captured mail, and puts the share back. */
    reset(shareOverrides = {}) {
      state.codes = [];
      state.mail = [];
      state.mailFails = false;
      state.share = { ...defaultShare(), ...shareOverrides };
    },
    /** Changes the link's settings mid-journey, as an owner would. */
    setShare(patch) {
      state.share = { ...state.share, ...patch };
    },
    /** Every message the worker tried to send, newest last. */
    mail: () => state.mail,
    /** How many codes the database was asked to record, sent or not. The
     *  anti-enumeration property is that this counts a refused address too. */
    codeCount: () => state.codes.length,
    /** The six digits out of the newest message, the way a reader reads them. */
    lastCode() {
      const last = state.mail[state.mail.length - 1];
      const found = last && /\b(\d{6})\b/.exec(last.text ?? '');
      return found ? found[1] : null;
    },
  };

  for (let attempt = 0; attempt < 120; attempt++) {
    if (dead) {
      await stopHarness();
      throw new Error(`wrangler dev exited before it answered:\n${workerErr}`);
    }
    if (await ping(workerPort)) return harness;
    await new Promise((r) => setTimeout(r, 500));
  }
  await stopHarness();
  throw new Error(`wrangler dev did not answer on port ${workerPort} within 60s:\n${workerErr}`);
}

/** Stops both processes and leaves the working tree exactly as it was. */
export async function stopHarness() {
  const running = harness;
  harness = null;
  if (running?.worker) {
    await new Promise((resolve) => {
      running.worker.on('exit', resolve);
      // The whole group, so workerd goes with the shim that started it.
      try {
        process.kill(-running.worker.pid, 'SIGTERM');
      } catch {
        running.worker.kill('SIGTERM');
      }
      setTimeout(resolve, 5_000);
    });
  }
  if (running?.server) {
    // The worker's keep-alive sockets would otherwise hold close() open, and a
    // teardown that never finishes reads as a hung suite.
    running.server.closeAllConnections();
    await new Promise((resolve) => running.server.close(resolve));
  }
  rmSync(DEV_VARS, { force: true });
  if (existsSync(`${DEV_VARS}.j11-backup`)) renameSync(`${DEV_VARS}.j11-backup`, DEV_VARS);
  rmSync(PERSIST_DIR, { recursive: true, force: true });
}
