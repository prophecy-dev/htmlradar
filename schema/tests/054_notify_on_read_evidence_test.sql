-- 054_notify_on_read_evidence_test.sql
-- ------------------------------------------------------------
-- Tests for 054_notify_on_read_evidence.sql. SCRATCH DATABASE ONLY, after
-- applying the numbered chain through 054. Wrapped in a transaction that rolls
-- back, so nothing survives — including the pg_net rows the send path queues.
--
-- WHAT COUNTS AS A PASS, and the first draft of this file got it wrong. It
-- counted rows in notifications_log, and a `skipped` row is a row: a test that
-- counts them certifies a refusal to send as a send. Every assertion below
-- names `status = 'queued'` and `sessions.notification_sent_at`, which only
-- the send path writes. To reach that path the Vault secrets have to resolve,
-- so section 0 puts throwaway ones in if the database has none.
--
-- EVERY CASE GETS ITS OWN READER. The first draft reused one viewer, so case
-- A's empty session sat in the table while B, C and D ran and silenced them
-- through the very defect this migration had to fix — and they reported
-- success. One viewer per case, and the cases that are ABOUT two sessions say
-- so.
--
-- Evidence is driven through `update_session`, the public RPC the tracker
-- actually calls, rather than by writing to `sessions` by hand, so the test
-- exercises the same path production does.
--
-- HOW THE RESULT COMES BACK. Every case records one row in a temporary table
-- and the file ENDS BY RAISING AN EXCEPTION carrying the whole report. That is
-- deliberate and it buys two things. The transaction is guaranteed to roll
-- back however the run goes, so this can be pointed at the live database; and
-- the report travels in an error message, which is the only channel that
-- survives the Supabase Management API, where RAISE NOTICE output is thrown
-- away. A case that fails is recorded and the run continues, so one failure
-- does not hide the other seven.
-- ------------------------------------------------------------

begin;

-- Bounded, so this can never queue behind a long query and wedge `sessions`.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Where every case records its verdict. Dropped by the rollback either way.
create temporary table t_result (ord serial, label text, ok boolean, detail text);
create temporary table t_ref (doc_id uuid, share_id uuid, owner_id uuid);

-- Helpers live in pg_temp, not public: they are session-local and cannot
-- outlive the connection even if something unexpected happens to the
-- transaction, and they cannot collide with a real function of the same name.
create function pg_temp.t_check(p_label text, p_ok boolean, p_detail text default '')
returns void language sql as $fn$
  insert into t_result (label, ok, detail) values (p_label, p_ok, p_detail);
$fn$;

-- ------------------------------------------------------------
-- 0. Fixture, and what the real schema demanded of it.
--
-- The first attempt against production aborted here, which is what this file
-- is for: it had never met the real database. Three rules it had not seen.
--
--   1. `validate_share_slug` (schema/033) refuses a CHOSEN link ending unless
--      the owner is Pro — P0036 slug_requires_pro. The trigger decides
--      "chosen" by comparing the slug against `app.generated_slug`, a
--      transaction-local setting that `create_share` sets when it generates
--      one. Setting it here is not a workaround, it is the same door
--      create_share uses, and it keeps the share non-custom so no tier is
--      needed and no Pro flag has to be faked.
--   2. `enforce_share_cap` (schema/027) caps a free owner at two links for
--      life. Running under an account that already has links would either
--      trip that or consume a slot.
--   3. `documents.owner_id` and `document_shares.owner_id` are foreign keys to
--      `auth.users`, and `notify_on_first_open` reads the owner out of
--      `profiles`, which only exists because the `on_auth_user_created`
--      trigger mirrors it.
--
-- So the run does NOT create an account. It borrows an existing internal one,
-- read-only, and creates only a document and a share beneath it — both rolled
-- back. Nothing is written to `auth.users` or `profiles` at all, which is the
-- safest shape for something pointed at a live database: no identity is
-- created, no e-mail address is invented, and no account trigger fires.
--
-- The viewers below are anonymous (fingerprint only), so none of them is the
-- owner's own address and the internal-viewer guard in the notification stays
-- out of the way.
-- ------------------------------------------------------------
do $$
declare v_owner uuid; v_doc uuid; v_share uuid;
begin
  begin
    select id into v_owner
      from profiles
     where email like '%@htmlradar.com' or email like '%@draconic.ai'
     order by created_at
     limit 1;
    if v_owner is null then
      raise exception 'no internal account to run under';
    end if;

    -- Rule 1: declare this slug the generated one for the length of this
    -- transaction, exactly as create_share does.
    perform set_config('app.generated_slug', 'quiet-falcon-054aaa', true);

    insert into documents (owner_id, title, source_type, r2_key, current_version)
    values (v_owner, '054 dry run', 'upload', 'dry-run/054.html', 1)
    returning id into v_doc;

    insert into document_shares (document_id, owner_id, slug)
    values (v_doc, v_owner, 'quiet-falcon-054aaa')
    returning id into v_share;

    insert into t_ref values (v_doc, v_share, v_owner);
  exception when others then
    -- Carry the marker so the wrapper reports this as a setup failure rather
    -- than as an unexplained error. The raise rolls everything back.
    raise exception '054 DRY RUN: the setup failed before any case ran (%: %)', sqlstate, sqlerrm
      using errcode = 'P0054';
  end;
end;
$$;

-- The send path needs these to resolve or it logs `skipped` and returns, and
-- every assertion below would be vacuous. Only added when ABSENT; on the live
-- database they are present and this does nothing.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'resend_api_key') then
    perform vault.create_secret('re_dry_run_only', 'resend_api_key');
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'resend_from') then
    perform vault.create_secret('dry-run@example.test', 'resend_from');
  end if;
end;
$$;

-- One reader per case, and a session opened for a named reader.
create function pg_temp.t_reader(p_label text) returns uuid
language plpgsql as $fn$
declare v_id uuid;
begin
  insert into viewers (share_id, fingerprint)
  select share_id, 'fp-054-' || p_label from t_ref
  returning id into v_id;
  return v_id;
end;
$fn$;

create function pg_temp.t_open(p_viewer uuid) returns uuid
language plpgsql as $fn$
declare v_id uuid;
begin
  insert into sessions (share_id, viewer_id, document_version)
  select share_id, p_viewer, 1 from t_ref
  returning id into v_id;
  return v_id;
end;
$fn$;

-- A tracker report, through the RPC the tracker really calls.
create function pg_temp.t_report(p_session uuid, p_active int, p_scroll real)
returns void language plpgsql as $fn$
declare v_token text;
begin
  select token into v_token from sessions where id = p_session;
  perform update_session(p_session, v_token, p_active, p_scroll, '[]'::jsonb);
end;
$fn$;

-- Sends only. A `skipped` row is not a send and must never satisfy a test.
create function pg_temp.t_sent(p_session uuid) returns int
language sql as $fn$
  select count(*)::int from notifications_log
   where session_id = p_session and status = 'queued';
$fn$;

-- ------------------------------------------------------------
-- Each case runs inside its own exception-handled block, so an unexpected SQL
-- error is recorded as a failure for that case and the rest still run. The
-- handler also rolls the case's own fixture rows back, which keeps a failing
-- case from leaking state into the next one.
-- ------------------------------------------------------------

-- A. An empty session sends nothing.
do $$
declare v_ok boolean := false; v_detail text := ''; v_s uuid; v_n int;
begin
  begin
    v_s := pg_temp.t_open(pg_temp.t_reader('a-empty'));
    select count(*) into v_n from notifications_log where session_id = v_s;
    if v_n <> 0 then
      v_detail := format('a bare session wrote %s notification rows, expected 0', v_n);
    elsif (select notification_sent_at from sessions where id = v_s) is not null then
      v_detail := 'an unread session was stamped as notified';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('A empty session notifies nobody', v_ok, v_detail);
end;
$$;

-- B. A session with reading time sends exactly one, and only one.
do $$
declare v_ok boolean := false; v_detail text := ''; v_s uuid;
begin
  begin
    v_s := pg_temp.t_open(pg_temp.t_reader('b-reads'));
    perform pg_temp.t_report(v_s, 15, 0);            -- the first heartbeat, ~20s in
    if pg_temp.t_sent(v_s) <> 1 then
      v_detail := format('first report with reading time sent %s, expected 1', pg_temp.t_sent(v_s));
    elsif (select notification_sent_at from sessions where id = v_s) is null then
      v_detail := 'the session was not stamped as notified';
    else
      perform pg_temp.t_report(v_s, 30, 0.4);        -- three more heartbeats
      perform pg_temp.t_report(v_s, 45, 0.8);
      perform pg_temp.t_report(v_s, 60, 1.0);
      if pg_temp.t_sent(v_s) <> 1 then
        v_detail := format('later heartbeats sent more; total is %s, expected 1', pg_temp.t_sent(v_s));
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('B reading time notifies exactly once', v_ok, v_detail);
end;
$$;

-- C. Scroll alone is evidence — the two genuine production reads that
--    recorded a full scroll and no reading time at all.
do $$
declare v_ok boolean := false; v_detail text := ''; v_s uuid;
begin
  begin
    v_s := pg_temp.t_open(pg_temp.t_reader('c-scrolls'));
    perform pg_temp.t_report(v_s, 0, 1.0);
    if pg_temp.t_sent(v_s) <> 1 then
      v_detail := format('a full scroll with no reading time sent %s, expected 1', pg_temp.t_sent(v_s));
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('C scroll alone notifies', v_ok, v_detail);
end;
$$;

-- D. An empty report is not evidence, and does not spend the one firing.
do $$
declare v_ok boolean := false; v_detail text := ''; v_s uuid; v_n int;
begin
  begin
    v_s := pg_temp.t_open(pg_temp.t_reader('d-empty-then-real'));
    perform pg_temp.t_report(v_s, 0, 0);
    select count(*) into v_n from notifications_log where session_id = v_s;
    if v_n <> 0 then
      v_detail := format('a report carrying nothing notified %s times', v_n);
    else
      perform pg_temp.t_report(v_s, 12, 0);
      if pg_temp.t_sent(v_s) <> 1 then
        v_detail := format('the real read that followed sent %s, expected 1', pg_temp.t_sent(v_s));
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('D empty report is not evidence', v_ok, v_detail);
end;
$$;

-- E. THE REGRESSION 054 HAD TO FIX. Open briefly, close before the tracker
--    reports, come back and read properly. Under 049's dedup the first, silent
--    session matched and the second stayed silent too, so the sender was never
--    told their document had been read.
do $$
declare v_ok boolean := false; v_detail text := ''; v_reader uuid; v_first uuid; v_second uuid;
begin
  begin
    v_reader := pg_temp.t_reader('e-returns');
    v_first := pg_temp.t_open(v_reader);             -- closed before reporting
    v_second := pg_temp.t_open(v_reader);            -- comes back and reads
    perform pg_temp.t_report(v_second, 40, 0.9);
    if pg_temp.t_sent(v_second) <> 1 then
      v_detail := format(
        'the genuine read sent %s, expected 1 — an earlier unread session silenced it',
        pg_temp.t_sent(v_second));
    elsif pg_temp.t_sent(v_first) <> 0 then
      v_detail := format('the empty session sent %s of its own, expected 0', pg_temp.t_sent(v_first));
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('E an unread session does not silence a later real read', v_ok, v_detail);
end;
$$;

-- F. Two sessions open before either reports, then both report. Exactly one
--    announcement; the second is skipped as a repeat, not lost. Sequential
--    here — one connection cannot hold two real transactions — so this pins
--    the DECISION, and G pins the lock that makes it hold under a real race.
do $$
declare v_ok boolean := false; v_detail text := ''; v_reader uuid; v_a uuid; v_b uuid; v_total int;
begin
  begin
    v_reader := pg_temp.t_reader('f-two-tabs');
    v_a := pg_temp.t_open(v_reader);
    v_b := pg_temp.t_open(v_reader);
    perform pg_temp.t_report(v_a, 20, 0.5);
    perform pg_temp.t_report(v_b, 20, 0.5);
    select pg_temp.t_sent(v_a) + pg_temp.t_sent(v_b) into v_total;
    if v_total <> 1 then
      v_detail := format('two tabs produced %s sends, expected exactly 1', v_total);
    elsif not exists (
      select 1 from notifications_log
       where session_id = v_b and status = 'skipped'
         and error_message = 'repeat open by same recipient on this document'
    ) then
      v_detail := 'the second tab was not recorded as a repeat open';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('F two tabs announce once', v_ok, v_detail);
end;
$$;

-- G. The decision is serialised. The advisory lock is transaction-scoped, so
--    it is still held here, and its key is the one the dedup matches on.
do $$
declare v_ok boolean := false; v_detail text := ''; v_key bigint; v_doc uuid; v_held int;
begin
  begin
    select doc_id into v_doc from t_ref;
    v_key := hashtextextended(v_doc::text || '|' || 'fp-054-f-two-tabs', 0);
    select count(*) into v_held from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid()
       and ((classid::bigint << 32) | objid::bigint) = v_key;
    if v_held = 0 then
      v_detail := 'no advisory lock was taken for (document, reader)';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('G the decision is locked per document and reader', v_ok, v_detail);
end;
$$;

-- H. A reader who has genuinely been announced still silences their own later
--    sessions — the dedup 054 narrowed must not be switched off.
do $$
declare v_ok boolean := false; v_detail text := ''; v_reader uuid; v_first uuid; v_later uuid;
begin
  begin
    v_reader := pg_temp.t_reader('h-repeat');
    v_first := pg_temp.t_open(v_reader);
    perform pg_temp.t_report(v_first, 25, 0.7);
    if pg_temp.t_sent(v_first) <> 1 then
      v_detail := format('the first real read sent %s, expected 1', pg_temp.t_sent(v_first));
    else
      v_later := pg_temp.t_open(v_reader);
      perform pg_temp.t_report(v_later, 25, 0.7);
      if pg_temp.t_sent(v_later) <> 0 then
        v_detail := format('a repeat open by an announced reader sent %s, expected 0',
                           pg_temp.t_sent(v_later));
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('H an announced reader stays silent later', v_ok, v_detail);
end;
$$;

-- I. The trigger is the one this migration installs, and the old AFTER INSERT
--    one is gone. Without this every case above would also pass on a database
--    where the drop silently failed and both triggers existed.
do $$
declare v_ok boolean := false; v_detail text := ''; v_def text; v_count int;
begin
  begin
    select count(*) into v_count from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'sessions' and not t.tgisinternal;
    select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'sessions' and t.tgname = 'trg_notify_on_first_open';
    if v_count <> 1 then
      v_detail := format('sessions carries %s non-internal triggers, expected 1', v_count);
    elsif v_def is null then
      v_detail := 'trg_notify_on_first_open is not on sessions at all';
    elsif v_def !~* 'AFTER UPDATE OF' then
      v_detail := format('the trigger still fires on insert: %s', v_def);
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('I one trigger, firing on a report not an insert', v_ok, v_detail);
end;
$$;

-- ------------------------------------------------------------
-- The report, and the rollback.
--
-- Raising is how the whole run ends, on purpose. It guarantees the transaction
-- rolls back whatever happened above, and an error message is the only channel
-- that survives the Supabase Management API, which returns a final result set
-- or an error and discards NOTICE output entirely.
-- ------------------------------------------------------------
do $$
declare v_total int; v_pass int; v_msg text;
begin
  select count(*), count(*) filter (where ok) into v_total, v_pass from t_result;
  select string_agg(
           label || case when ok then ' pass' else ' FAIL: ' || detail end,
           ' | ' order by ord)
    into v_msg
    from t_result;
  raise exception '054 DRY RUN: % of % passed | %', v_pass, v_total, coalesce(v_msg, 'no cases ran')
    using errcode = 'P0054';
end;
$$;

-- Unreachable while the block above raises, and kept as a belt: if that report
-- is ever removed, this file still refuses to leave anything behind.
rollback;
