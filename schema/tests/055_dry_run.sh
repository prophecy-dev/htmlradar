#!/usr/bin/env bash
#
# 055_dry_run.sh — apply 055, test it, and put everything back.
#
# Safe to run against the live database. Read the three sections below first.
# This is 054_dry_run.sh's mechanism, unchanged, pointed at a different pair of
# files; what is different about 055 is spelled out where it matters.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# Schema 055 has never executed anywhere. There is no scratch Supabase project,
# and a plain Postgres container cannot stand in for one: the migration rebuilds
# a view over `profiles` and `custom_domains`, recreates functions that call
# `auth.uid()` and `crypt()`, and leans on triggers — `validate_share_slug`,
# `enforce_share_cap`, `trg_validate_share_host` — that only exist here. This is
# how 055 gets exercised against the real schema without being kept.
#
# It ASSEMBLES rather than duplicates: it reads the real migration and the real
# test file off disk, strips their own transaction control, and wraps the pair
# in one transaction that ends in ROLLBACK. There is no second copy of 055 to
# drift out of step with the first.
#
# ---------------------------------------------------------------------------
# NOTHING ESCAPES THE TRANSACTION. Each way out, and why it is closed:
#
#   * E-mail. 055 sends none. It creates no trigger that sends, and the code
#     message is sent by the WORKER over its own HTTPS connection, not from
#     Postgres — which is the whole reason the worker now needs a RESEND_API_KEY
#     of its own. So unlike 054's run, this one does not even queue a pg_net
#     row. The one thing to know is the reverse of 054's caveat: because the
#     send path is not in the database, this dry run cannot exercise it. The
#     worker's own suite does (packages/proxy/tests/verified-gate.test.ts).
#   * Sequences. Any sequence touched will have advanced, because sequences
#     deliberately do not roll back. Nothing asserts on one and nothing reads
#     them, so this is the one harmless residue — named here so nobody is
#     surprised by a gap.
#   * The Vault. Nothing here reads or writes `vault`.
#   * Advisory locks. Every lock 055 takes is `pg_advisory_xact_lock`, which is
#     transaction-scoped and released by the rollback. Since the review there
#     are TWO per issued code — the address bucket and, when the request has a
#     network identity, the network bucket — taken in ascending key order so
#     they cannot deadlock. Cases L and Z assert they are still held, which is
#     only true because they are scoped that way.
#   * Rows. The test creates two documents and four shares under EXISTING
#     internal accounts — three links under one owner and one under a second,
#     because the hourly budget is now per link owner and proving that needs a
#     real second owner — and codes and verifications beneath them. All of it
#     rolls back. No account is created, no address is invented, and no account
#     trigger fires.
#   * pg_cron, dblink, autonomous transactions: none. `dblink` and
#     `pg_background` were both considered for a genuine two-transaction race
#     against the per-network ceiling and both were rejected; case Z of the test
#     file says exactly why, and says what that leaves unproven. The sweep is exercised by
#     CALLING `purge_connect_handles()` inside the transaction, so its deletes
#     roll back with everything else — including, deliberately, any genuinely
#     expired `connect_handles` rows it would have taken. Those are swept again
#     five minutes later by the real job, so nothing is lost.
#
# ---------------------------------------------------------------------------
# THE LOCK, AND WHY THIS IS SAFE ON A LIVE DATABASE
#
# 055 takes an ACCESS EXCLUSIVE lock on `document_shares` — `alter table ... add
# column` and `add constraint` each do — and a lock taken inside a transaction
# is held until that transaction ends. `document_shares` is read on EVERY
# recipient request. So for the whole run, readers opening documents WAIT.
#
# The column has a default and the constraint cannot be violated by any existing
# row, so neither statement rewrites the table; both are catalogue changes over
# a few thousand rows, comfortably under a second. The real danger is not
# duration, it is the QUEUE: a request for ACCESS EXCLUSIVE that cannot be
# granted at once parks behind every in-flight reader AND blocks everything
# arriving after it, so one long query could turn a fast migration into a stall
# for everybody.
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
#                     ./schema/tests/055_dry_run.sh --api
#   With psql:        ./schema/tests/055_dry_run.sh "$DATABASE_URL"
#   Just the SQL:     ./schema/tests/055_dry_run.sh --print > /tmp/055-dry-run.sql
#                     then paste that file into the Supabase SQL editor.
#
# `--api` is the mode that matches how this project reaches production: the
# Supabase Management API, which has no psql and returns only a final result set
# or an error. NOTICE output is discarded there, so the run does NOT report
# through RAISE NOTICE. Every case records a row in a temporary table and the
# script ENDS BY RAISING an exception whose message is the whole report. That is
# what carries the result back in the API's error body, and it is also what
# guarantees the rollback: there is no path on which this commits.
#
# A report reading "N of N passed" is a pass. Anything less is a refusal to
# ship 055, and nothing was changed either way.
#
# Afterwards, confirm the database is untouched:
#
#   select count(*) from information_schema.columns
#    where table_name = 'document_shares' and column_name = 'verify_email';
#   -- must STILL be 0. The rollback undid the migration.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
schema="$(dirname "$here")"
migration="$schema/055_verified_email_gate.sql"
cases="$here/055_verified_email_gate_test.sql"

for f in "$migration" "$cases"; do
  [ -f "$f" ] || { echo "055_dry_run: missing $f" >&2; exit 1; }
done

# Strip ONLY transaction control written at column zero, which is where both
# source files put their own. Inside the plpgsql function bodies every `begin`
# is either indented or carries no semicolon, so the functions are untouched —
# checked immediately below.
strip_tx() { sed -E '/^[[:space:]]*(begin|commit|rollback)[[:space:]]*;[[:space:]]*$/Id' "$1"; }

build() {
  cat <<'PREFIX'
-- Generated by schema/tests/055_dry_run.sh. Do not commit this output.
-- One transaction, ending in ROLLBACK: the migration is applied, tested, and
-- undone. See the script for why nothing escapes and why the lock is safe.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $dryrun$
begin
  if to_regclass('public.document_shares') is null
     or to_regclass('public.connect_handles') is null then
    raise exception 'this does not look like the HTMLRadar database; refusing to run';
  end if;
  -- 055 is not the first migration this database has seen. If verify_email is
  -- already there, the real 055 has been applied and this run would be testing
  -- a no-op rather than the change.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'document_shares'
       and column_name = 'verify_email'
  ) then
    raise notice '--- 055 dry run: verify_email already exists; re-applying over it ---';
  end if;
  raise notice '--- 055 dry run: applying the migration, then testing it ---';
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

# The stripper must not have eaten a function's own plpgsql `begin`. If the
# assembled script does not still contain each piece the migration is made of,
# something was removed that should not have been.
for needle in 'add column if not exists verify_email' \
              'create or replace function public.issue_email_verification_code' \
              'create or replace function public.check_email_verification_code' \
              'create or replace function public.ct_eq' \
              'pg_advisory_xact_lock' \
              'least(v_addr_key, v_net_key)' \
              'counts_toward_address' \
              'create view public.share_lookup_all' \
              'create view public.share_lookup with' \
              'create or replace function public.share_lookup_for' \
              '055 DRY RUN:'; do
  case "$sql" in
    *"$needle"*) ;;
    *) echo "055_dry_run: assembly lost '$needle'; refusing to run" >&2; exit 1 ;;
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
  *) echo "055_dry_run: assembled script does not end in rollback; refusing" >&2; exit 1 ;;
esac
if ! printf '%s' "$sql" | python3 -c '
import re, sys
code = re.sub(r"--[^\n]*", "", sys.stdin.read())
sys.exit(1 if re.search(r"(?is)\bcommit\b\s*(;|transaction|work)", code) else 0)
'; then
  echo "055_dry_run: assembled script contains a commit; refusing" >&2
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

  tmp="$(mktemp -t 055dryrun)"
  out="$(mktemp -t 055dryout)"
  trap 'rm -f "$tmp" "$out"' EXIT

  # JSON-encode the SQL properly rather than by hand, and send it from a file
  # so no shell quoting touches it.
  printf '%s' "$sql" | python3 -c 'import json,sys; sys.stdout.write(json.dumps({"query": sys.stdin.read()}))' > "$tmp"

  curl -sS -X POST "https://api.supabase.com/v1/projects/$ref/database/query" \
    -H "Authorization: Bearer $SUPABASE_PERSONAL_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @"$tmp" > "$out" || { echo "055_dry_run: the request failed" >&2; exit 1; }

  python3 - "$out" <<'PARSE'
import json, re, sys

raw = open(sys.argv[1]).read()
MARK = '055 DRY RUN:'

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
command -v psql >/dev/null || { echo "055_dry_run: psql not found; use --api or --print" >&2; exit 1; }

printf '%s\n' "$sql" | psql "$1" -v ON_ERROR_STOP=1 -f -
