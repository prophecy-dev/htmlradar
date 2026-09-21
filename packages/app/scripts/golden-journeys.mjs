#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console */
// The parity harness. Two commands, and the second one is the point.
//
//   node scripts/golden-journeys.mjs run    before.json
//   …make the change, deploy it to a preview…
//   PLAYWRIGHT_BASE_URL=https://<preview> node scripts/golden-journeys.mjs run after.json
//   node scripts/golden-journeys.mjs compare before.json after.json
//
// `run` walks the golden journeys against whatever PLAYWRIGHT_BASE_URL
// names and writes a PARITY RECORD: for each journey, the facts the product
// recorded in its own database and the numbers it printed on the screen.
//
// `compare` reads two of those records and fails on any difference outside
// the tolerances in e2e/journeys/tolerances.mjs. That is the check every
// milestone of the design overhaul runs before and after itself. A design
// change that alters a recorded number is not a design change.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TOLERANCE, IGNORED, TOLERANCES } from '../e2e/journeys/tolerances.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARITY_DIR = path.join(APP, 'e2e/journeys/.parity');

function run(outPath) {
  if (!outPath) die('usage: golden-journeys.mjs run <out.json>');
  // A stale file from a previous run would be merged into this one and
  // silently pass a journey that did not execute.
  rmSync(PARITY_DIR, { recursive: true, force: true });
  mkdirSync(PARITY_DIR, { recursive: true });

  const result = spawnSync(
    'npx',
    ['playwright', 'test', '--project=golden', ...process.argv.slice(4)],
    { cwd: APP, stdio: 'inherit' },
  );

  const journeys = {};
  for (const file of existsSync(PARITY_DIR) ? readdirSync(PARITY_DIR).sort() : []) {
    if (file.endsWith('.json')) {
      journeys[file.replace(/\.json$/, '')] = JSON.parse(
        readFileSync(path.join(PARITY_DIR, file), 'utf8'),
      );
    }
  }

  const record = {
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? 'https://htmlradar.com',
    recordedAt: new Date().toISOString(),
    journeys,
  };
  writeFileSync(path.resolve(outPath), `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `\nparity record → ${outPath} (${Object.keys(journeys).length} journeys recorded)` +
      (result.status === 0 ? '' : '\nWARNING: the suite did not pass; this record is incomplete.'),
  );
  // A record written from a failed run is still worth having for the diff,
  // but the command must not report success.
  process.exit(result.status ?? 1);
}

/** Every leaf of an object, as `a.b.c` → value. */
function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${key}` : key, out);
  } else {
    // Arrays compare whole and in order: the app_events names are a sequence,
    // and an event that moved is as much a change as one that vanished.
    out[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
  return out;
}

const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function compare(beforePath, afterPath) {
  if (!beforePath || !afterPath) die('usage: golden-journeys.mjs compare <before.json> <after.json>');
  const before = flatten(JSON.parse(readFileSync(path.resolve(beforePath), 'utf8')));
  const after = flatten(JSON.parse(readFileSync(path.resolve(afterPath), 'utf8')));

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const problems = [];
  for (const key of keys) {
    if (IGNORED.some((prefix) => key.startsWith(prefix))) continue;
    const a = before[key];
    const b = after[key];
    if (!(key in before)) {
      problems.push(`${key}: the "after" run recorded this and the "before" run did not (${b})`);
      continue;
    }
    if (!(key in after)) {
      problems.push(`${key}: the "before" run recorded ${a} and the "after" run recorded nothing`);
      continue;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      // Tolerances are written the way a person names a fact — `j3.db.
      // active_seconds` — while the flattened path carries the `journeys.`
      // container in front of it.
      const slack = TOLERANCES[key.replace(/^journeys\./, '')] ?? DEFAULT_TOLERANCE;
      if (Math.abs(a - b) > slack) {
        problems.push(`${key}: ${a} → ${b} (tolerance ${slack})`);
      }
    } else if (a !== b) {
      // Arrays arrive here already serialised by flatten(); stringifying
      // again would show the reader a wall of backslashes.
      problems.push(`${key}: ${show(a)} → ${show(b)}`);
    }
  }

  if (problems.length === 0) {
    console.log(`PARITY. ${keys.length} facts compared, nothing moved outside its tolerance.`);
    return;
  }
  console.error(`NOT PARITY. ${problems.length} of ${keys.length} facts moved:\n`);
  for (const line of problems) console.error(`  ${line}`);
  console.error(
    '\nEach line is one fact the product recorded differently after the change.\n' +
      'If a difference is intended, widen or add its tolerance in\n' +
      'e2e/journeys/tolerances.mjs with a comment saying why — never delete the fact.',
  );
  process.exit(1);
}

function die(message) {
  console.error(message);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') run(rest[0]);
else if (command === 'compare') compare(rest[0], rest[1]);
else die('usage: golden-journeys.mjs run <out.json> | compare <before.json> <after.json>');
