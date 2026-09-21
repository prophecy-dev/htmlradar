#!/usr/bin/env bash
#
# 054_dry_run.sh — apply 054, test it, and put everything back.
#
# Safe to run against the live database. Read the three sections below first.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# Schema 054 has never executed anywhere. There is no scratch Supabase project,
# and a plain Postgres container cannot stand in for one, because the
# migration's function reads `vault`, calls `net.http_post` and writes tables
# that only exist here. This is how 054 gets exercised against the real schema
# without being kept.
#
# It ASSEMBLES rather than duplicates: it reads the real migration and the real
# test file off disk, strips their own transaction control, and wraps the pair
# in one transaction that ends in ROLLBACK. There is no second copy of 054 to
# drift out of step with the first.
#
# ---------------------------------------------------------------------------
# NOTHING ESCAPES THE TRANSACTION. Each way out, and why it is closed:
#
#   * The e-mail. `notify_on_first_open` calls `net.http_post`. On this project
#     that is a plpgsql function whose entire body inserts one row into
#     `net.http_request_queue` and signals a background worker — verified by
#     reading `pg_get_functiondef` for it on this database on 21 September
#     2026. That insert is an ordinary transactional insert. The worker runs in
#     a separate backend and can only see COMMITTED rows, so after the rollback
#     there is no row and no request is ever made. The Resend key is read into a
#     local variable and placed in a row that is rolled back; it is never
#     transmitted. No stub is needed, and none is used, so the real send path is
#     the one under test.
#   * Sequences. `http_request_queue.id` and any other sequence touched will
#     have advanced, because sequences deliberately do not roll back. Nothing
#     asserts on a sequence value and nothing reads them, so this is the one
#     harmless residue — named here so nobody is surprised by a gap.
#   * The Vault. Nothing here writes to `vault`. The test creates the Resend
#     secrets only if they are ABSENT; on this database they are present, so it
#     is a no-op and the real secrets are used, read-only.
#   * Advisory locks. The one 054 takes is `pg_advisory_xact_lock`, which is
#     transaction-scoped and released by the rollback.
#   * pg_cron, triggers on other tables, dblink, autonomous transactions: none.
#
# ---------------------------------------------------------------------------
# THE LOCK, AND WHY THIS IS SAFE ON A LIVE DATABASE
#
# `drop trigger` and `create trigger` each take an ACCESS EXCLUSIVE lock on
# `sessions`, and a lock taken inside a transaction is held until that
# transaction ends. So for the whole run, other connections reading or writing
# `sessions` — `start_session` and `update_session`, which is every reader
# opening or reporting on a document — WAIT.
#
# The work between taking the lock and the rollback is a few dozen single-row
# inserts and updates against tables holding a few thousand rows: comfortably
# under a second. The real danger is not duration, it is the QUEUE. A request
# for ACCESS EXCLUSIVE that cannot be granted at once parks behind every
# in-flight reader AND blocks everything arriving after it, so one long query on
# `sessions` could turn a fast migration into a stall for everybody.
#
# `lock_timeout = 2s` removes that: if the lock cannot be taken almost
# immediately the transaction aborts, and an abort is a rollback, which is the
# same safe ending as success. `statement_timeout = 30s` bounds any single
# statement the same way. Both are SET LOCAL, so they touch nothing else.
#
# If it aborts on a lock timeout, nothing happened. Run it again.
#
# ---------------------------------------------------------------------------
# HOW TO RUN
#
#   This project:     set -a; . code/.env.local; set +a
#                     ./schema/tests/054_dry_run.sh --api
#   With psql:        ./schema/tests/054_dry_run.sh "$DATABASE_URL"
#   Just the SQL:     ./schema/tests/054_dry_run.sh --print > /tmp/054-dry-run.sql
#                     then paste that file into the Supabase SQL editor.
#
# `--api` is the mode that matches how this project reaches production: the
# Supabase Management API, which has no psql and returns only a final result
# set or an error. NOTICE output is discarded there, so the run does NOT report
# through RAISE NOTICE. Every case records a row in a temporary table and the
# script ENDS BY RAISING an exception whose message is the whole report. That
# is what carries the result back in the API's error body, and it is also what
# guarantees the rollback: there is no path on which this commits.
#
# A report reading "N of N passed" is a pass. Anything less is a refusal to
# ship 054, and nothing was changed either way.
#
# Afterwards, confirm the database is untouched:
#
#   select pg_get_triggerdef(t.oid) from pg_trigger t
#     join pg_class c on c.oid = t.tgrelid
#    where c.relname = 'sessions' and t.tgname = 'trg_notify_on_first_open';
#   -- must STILL read AFTER INSERT. The rollback undid the migration.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
schema="$(dirname "$here")"
migration="$schema/054_notify_on_read_evidence.sql"
cases="$here/054_notify_on_read_evidence_test.sql"

for f in "$migration" "$cases"; do
  [ -f "$f" ] || { echo "054_dry_run: missing $f" >&2; exit 1; }
done

# Strip ONLY transaction control written at column zero, which is where both
# source files put their own. Inside the plpgsql function bodies every `begin`
# is either indented or carries no semicolon, so the functions are untouched —
# checked immediately below.
strip_tx() { sed -E '/^[[:space:]]*(begin|commit|rollback)[[:space:]]*;[[:space:]]*$/Id' "$1"; }

build() {
  cat <<'PREFIX'
-- Generated by schema/tests/054_dry_run.sh. Do not commit this output.
-- One transaction, ending in ROLLBACK: the migration is applied, tested, and
-- undone. See the script for why nothing escapes and why the lock is safe.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $dryrun$
begin
  if to_regclass('public.sessions') is null
     or to_regclass('public.notifications_log') is null then
    raise exception 'this does not look like the HTMLRadar database; refusing to run';
  end if;
  raise notice '--- 054 dry run: applying the migration, then testing it ---';
end;
$dryrun$;

PREFIX
  strip_tx "$migration"
  printf '\n'
  strip_tx "$cases"
  # The cases file ends by raising the report, so this is never reached. Kept
  # as a belt: if that report is ever removed, the script still cannot commit.
  cat <<'SUFFIX'

rollback;
SUFFIX
}

sql="$(build)"

# The stripper must not have eaten the function's own plpgsql `begin`. If the
# assembled script does not still contain the trigger function and its trigger,
# something was removed that should not have been.
for needle in 'create or replace function notify_on_first_open' \
              'create trigger trg_notify_on_first_open' \
              'pg_advisory_xact_lock' \
              '054 DRY RUN:'; do
  case "$sql" in
    *"$needle"*) ;;
    *) echo "054_dry_run: assembly lost '$needle'; refusing to run" >&2; exit 1 ;;
  esac
done

# And it must end in a rollback, with no commit ANYWHERE. Not a column-zero
# grep: `strip_tx` has already removed those, so a grep for them could never
# fire and would be decoration. What has to be caught is a commit that survived
# stripping — indented, upper-cased, or inside a DO block, where `COMMIT` ends
# the transaction and would defeat the whole point of this script. Comments are
# removed before the scan so prose about committing does not trip it.
case "$sql" in
  *"$(printf '\nrollback;\n')") ;;
  *) echo "054_dry_run: assembled script does not end in rollback; refusing" >&2; exit 1 ;;
esac
if ! printf '%s' "$sql" | python3 -c '
import re, sys
code = re.sub(r"--[^\n]*", "", sys.stdin.read())
sys.exit(1 if re.search(r"(?is)\bcommit\b\s*(;|transaction|work)", code) else 0)
'; then
  echo "054_dry_run: assembled script contains a commit; refusing" >&2
  exit 1
fi

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$sql"
  exit 0
fi

# ---------------------------------------------------------------------------
# --api: the Supabase Management API, which is how this project reaches the
# database. The whole script goes in one request; the report comes back in the
# error body, because the script ends by raising it.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--api" ]; then
  : "${SUPABASE_PERSONAL_ACCESS_TOKEN:?set it first: set -a; . code/.env.local; set +a}"
  ref="${SUPABASE_PROJECT_REF:-ewennjnxuqjzsgawbzur}"

  tmp="$(mktemp -t 054dryrun)"
  out="$(mktemp -t 054dryout)"
  trap 'rm -f "$tmp" "$out"' EXIT

  # JSON-encode the SQL properly rather than by hand, and send it from a file
  # so no shell quoting touches it.
  printf '%s' "$sql" | python3 -c 'import json,sys; sys.stdout.write(json.dumps({"query": sys.stdin.read()}))' > "$tmp"

  curl -sS -X POST "https://api.supabase.com/v1/projects/$ref/database/query" \
    -H "Authorization: Bearer $SUPABASE_PERSONAL_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @"$tmp" > "$out" || { echo "054_dry_run: the request failed" >&2; exit 1; }

  python3 - "$out" <<'PARSE'
import json, re, sys

raw = open(sys.argv[1]).read()
MARK = '054 DRY RUN:'

def walk(node, want):
    if isinstance(node, str):
        return node if want(node) else None
    if isinstance(node, dict):
        for v in node.values():
            hit = walk(v, want)
            if hit:
                return hit
    if isinstance(node, list):
        for v in node:
            hit = walk(v, want)
            if hit:
                return hit
    return None

try:
    parsed = json.loads(raw)
except Exception:
    parsed = None

report = walk(parsed, lambda t: MARK in t) if parsed is not None else (raw if MARK in raw else None)

# Our own deliberate exception: either the full report, or the setup saying it
# stopped before any case ran. Both mean the transaction rolled back.
if report:
    # Postgres appends its own CONTEXT trace to the message; the report is the
    # part we wrote.
    body = report[report.index(MARK):]
    body = re.split(r'\n\s*(?:CONTEXT|DETAIL|HINT|QUERY):', body)[0].strip()
    print(body)
    print()
    print('NOTHING WAS CHANGED')
    sys.exit(0 if (' FAIL: ' not in report and 'setup failed' not in report) else 2)

# A plain SQL error. It ALSO rolled the transaction back — an error inside a
# transaction cannot leave half of it behind — so telling somebody to go and
# check the database would be the wrong alarm. Say what it was instead.
code = walk(parsed, lambda t: bool(re.fullmatch(r'[0-9A-Z]{5}', t))) if parsed is not None else None
if code:
    print(json.dumps(parsed) if parsed is not None else raw.strip()[:4000])
    print()
    print('THE RUN STOPPED ON A DATABASE ERROR BEFORE THE REPORT (SQLSTATE ' + code + ').')
    print('NOTHING WAS CHANGED: the error rolled the transaction back.')
    sys.exit(3)

# Anything else — an auth failure, a gateway, or a result set where an
# exception was expected. The last of those is the only one worth an alarm,
# and it is indistinguishable from the others here, so raise it for all.
print(raw.strip()[:4000])
print()
print('UNEXPECTED RESPONSE, CHECK THE DATABASE')
sys.exit(1)
PARSE
  exit $?
fi

[ $# -ge 1 ] || { echo "usage: $0 --api | --print | <DATABASE_URL>" >&2; exit 1; }
command -v psql >/dev/null || { echo "054_dry_run: psql not found; use --api or --print" >&2; exit 1; }

printf '%s\n' "$sql" | psql "$1" -v ON_ERROR_STOP=1 -f -
