-- 055_verified_email_gate_test.sql
-- ------------------------------------------------------------
-- Tests for 055_verified_email_gate.sql. SCRATCH DATABASE ONLY, after applying
-- the numbered chain through 055 — or, through 055_dry_run.sh, against the live
-- database inside a transaction that always rolls back.
--
-- WHAT COUNTS AS A PASS. Every case names a fact only the thing under test can
-- produce: a verdict string the function returned, a row that exists or does
-- not, a column that is or is not there. Nothing counts rows in a table that a
-- refusal also writes to, which is the mistake 054's first draft made.
--
-- WHAT THIS FILE IS FOR, given that the worker has its own suite. The worker's
-- tests drive a MODEL of these two functions. Only here do the limits, the
-- attempt counter, the single-use stamp and the constant-time comparison meet
-- real Postgres — and the one property that cannot be modelled at all, that two
-- concurrent issues cannot both slip under the same limit, is a property of the
-- advisory lock and of nothing else.
--
-- HOW THE RESULT COMES BACK. Every case records one row in a temporary table
-- and the file ENDS BY RAISING AN EXCEPTION carrying the whole report. That is
-- deliberate, and it buys the same two things it buys 054: the transaction is
-- guaranteed to roll back however the run goes, so this can be pointed at the
-- live database; and an error message is the only channel that survives the
-- Supabase Management API, which discards RAISE NOTICE output. A case that
-- fails is recorded and the run continues, so one failure does not hide the
-- rest.
-- ------------------------------------------------------------

begin;

-- Bounded, so this can never queue behind a long query and wedge the tables it
-- touches. 055 takes an ACCESS EXCLUSIVE lock on `document_shares` for the
-- column it adds, which is every reader's table.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create temporary table t_result (ord serial, label text, ok boolean, detail text);
create temporary table t_ref (
  doc_id         uuid,
  share_id       uuid,   -- owner 1, verification on
  other_share_id uuid,   -- owner 1, verification on, and mutated by cases O/Q
  plain_share_id uuid,   -- owner 1, verification OFF, touched by nothing else
  owner_id       uuid,
  owner2_id      uuid,   -- a SECOND real owner, or null if the database has none
  share2_id      uuid    -- owner 2's link, verification on
);

create function pg_temp.t_check(p_label text, p_ok boolean, p_detail text default '')
returns void language sql as $fn$
  insert into t_result (label, ok, detail) values (p_label, p_ok, p_detail);
$fn$;

-- ------------------------------------------------------------
-- 0. Fixture. The same shape 054's uses, and for the same three reasons:
--    validate_share_slug refuses a chosen ending unless the owner is Pro, so
--    the slug is declared generated exactly as create_share declares it;
--    enforce_share_cap caps a free owner for life, so no account is created;
--    and owner_id is a foreign key to auth.users, so an existing internal
--    account is borrowed read-only.
--
--    THREE shares under owner one: two with verification on, because the
--    per-owner hourly budget cannot be tested with a single link, and one with
--    it OFF, because case Y has to show that an ordinary link is still visible
--    in `share_lookup` while a verified one is not.
--
--    AND A FOURTH under a SECOND owner, because after the review the hourly
--    budget is per address PER LINK OWNER and the only honest way to show that
--    is to exhaust one owner's budget and watch another owner's link still
--    work. A second owner is possible here: the database has several internal
--    accounts. The one picked is the first that the share cap will still let
--    create a link — `enforce_share_cap` caps a non-Pro owner at two links for
--    life and counts the ones they already have — and if there is none, case W
--    fails loudly rather than quietly testing something weaker.
--
--    OWNER ONE PREFERS THE PRO ACCOUNT, for the same cap: three links is one
--    more than a free owner is ever allowed, so a free owner one would make the
--    fixture itself fail. `order by (tier = 'pro') desc` picks the same account
--    `order by created_at` picked before this change, and keeps picking a
--    usable one if the accounts change.
-- ------------------------------------------------------------
do $$
declare
  v_owner uuid; v_owner2 uuid; v_doc uuid; v_doc2 uuid;
  v_a uuid; v_b uuid; v_plain uuid; v_s2 uuid;
begin
  begin
    select id into v_owner
      from profiles
     where email like '%@htmlradar.com' or email like '%@draconic.ai'
     order by (tier = 'pro') desc, created_at
     limit 1;
    if v_owner is null then
      raise exception 'no internal account to run under';
    end if;

    select p.id into v_owner2
      from profiles p
     where (p.email like '%@htmlradar.com' or p.email like '%@draconic.ai')
       and p.id <> v_owner
       and (p.tier = 'pro'
            or (select count(*) from document_shares s where s.owner_id = p.id) < 2)
     order by p.created_at
     limit 1;

    perform set_config('app.generated_slug', 'quiet-falcon-055aaa', true);
    insert into documents (owner_id, title, source_type, r2_key, current_version)
    values (v_owner, '055 dry run', 'upload', 'dry-run/055.html', 1)
    returning id into v_doc;

    insert into document_shares (document_id, owner_id, slug, require_email, verify_email)
    values (v_doc, v_owner, 'quiet-falcon-055aaa', true, true)
    returning id into v_a;

    perform set_config('app.generated_slug', 'quiet-falcon-055bbb', true);
    insert into document_shares (document_id, owner_id, slug, require_email, verify_email)
    values (v_doc, v_owner, 'quiet-falcon-055bbb', true, true)
    returning id into v_b;

    perform set_config('app.generated_slug', 'quiet-falcon-055ccc', true);
    insert into document_shares (document_id, owner_id, slug, require_email, verify_email)
    values (v_doc, v_owner, 'quiet-falcon-055ccc', true, false)
    returning id into v_plain;

    if v_owner2 is not null then
      insert into documents (owner_id, title, source_type, r2_key, current_version)
      values (v_owner2, '055 dry run, second owner', 'upload', 'dry-run/055b.html', 1)
      returning id into v_doc2;

      perform set_config('app.generated_slug', 'quiet-falcon-055ddd', true);
      insert into document_shares (document_id, owner_id, slug, require_email, verify_email)
      values (v_doc2, v_owner2, 'quiet-falcon-055ddd', true, true)
      returning id into v_s2;
    end if;

    insert into t_ref values (v_doc, v_a, v_b, v_plain, v_owner, v_owner2, v_s2);
  exception when others then
    raise exception '055 DRY RUN: the setup failed before any case ran (%: %)', sqlstate, sqlerrm
      using errcode = 'P0055';
  end;
end;
$$;

-- A stand-in for the worker's HMAC. The real hash is computed under
-- SESSION_SECRET, which is not in this database; what matters to every function
-- here is only that it is sixty-four hex characters and that the same code
-- gives the same one.
create function pg_temp.t_hash(p_code text) returns text
language sql immutable as $fn$
  select encode(digest('055|' || p_code, 'sha256'), 'hex');
$fn$;

create function pg_temp.t_share() returns uuid language sql as $fn$
  select share_id from t_ref;
$fn$;

create function pg_temp.t_other() returns uuid language sql as $fn$
  select other_share_id from t_ref;
$fn$;

-- Owner one's ordinary link — the e-mail gate on, verification off.
create function pg_temp.t_plain() returns uuid language sql as $fn$
  select plain_share_id from t_ref;
$fn$;

-- Owner two's link, or null if the database had no second usable account.
create function pg_temp.t_share2() returns uuid language sql as $fn$
  select share2_id from t_ref;
$fn$;

-- One browser, one challenge. Distinct per case so no case can spend another's.
create function pg_temp.t_challenge(p_label text) returns text
language sql immutable as $fn$
  select substr(encode(digest('c055|' || p_label, 'sha256'), 'hex'), 1, 32);
$fn$;

-- ------------------------------------------------------------
-- Each case runs inside its own exception-handled block, so an unexpected SQL
-- error is recorded as a failure for that case and the rest still run.
-- ------------------------------------------------------------

-- A. The shape of the change: the column, its default, and the constraint that
--    is decision 9.
do $$
declare v_ok boolean := false; v_detail text := ''; v_n int;
begin
  begin
    select count(*) into v_n from information_schema.columns
     where table_schema = 'public' and table_name = 'document_shares'
       and column_name = 'verify_email';
    if v_n <> 1 then
      v_detail := 'document_shares.verify_email is not there';
    elsif exists (
      select 1 from document_shares
       where verify_email
         and id not in (
           select share_id from t_ref
           union select other_share_id from t_ref
           union select plain_share_id from t_ref
           union select share2_id from t_ref where share2_id is not null
         )
    ) then
      v_detail := 'an existing link came out of this migration with verification on';
    else
      begin
        update document_shares set require_email = false, verify_email = true
         where id = pg_temp.t_share();
        v_detail := 'verification was allowed with the e-mail gate off';
      exception when check_violation then
        v_ok := true;
      end;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('A the flag exists, defaults off, and needs the e-mail gate', v_ok, v_detail);
end;
$$;

-- B. The constant-time comparison is a comparison. Pointless as a timing proof
--    — a SQL test cannot measure that — and not pointless as a correctness
--    one: a compare written without early exit is exactly the kind that gets
--    an operator precedence wrong and returns true for everything.
do $$
declare v_ok boolean := false; v_detail text := '';
begin
  begin
    if not ct_eq('abc', 'abc') then v_detail := 'equal strings compared unequal';
    elsif ct_eq('abc', 'abd') then v_detail := 'differing strings compared equal';
    elsif ct_eq('abc', 'abcd') then v_detail := 'different lengths compared equal';
    elsif ct_eq(repeat('0', 64), repeat('0', 63) || '1') then
      v_detail := 'a one-character difference at the end was missed';
    elsif ct_eq(null, 'abc') or ct_eq('abc', null) then v_detail := 'null compared equal';
    else v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('B ct_eq compares correctly', v_ok, v_detail);
end;
$$;

-- C. The happy path: a code is issued, checked once, and opens the gate.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('happy');
    v_v := issue_email_verification_code(pg_temp.t_share(), 'Happy@Acme.Test',
             pg_temp.t_hash('111111'), v_c, 'iphash-happy');
    if v_v <> 'ok' then
      v_detail := format('issuing returned %s, expected ok', v_v);
    else
      v_v := check_email_verification_code(pg_temp.t_share(), 'happy@acme.test',
               pg_temp.t_hash('111111'), v_c);
      if v_v <> 'ok' then
        v_detail := format('the right code returned %s, expected ok', v_v);
      elsif not exists (
        select 1 from share_email_verifications
         where share_id = pg_temp.t_share() and email = 'happy@acme.test'
      ) then
        v_detail := 'the address was not recorded as verified';
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('C a code is issued, checked once, and recorded', v_ok, v_detail);
end;
$$;

-- D. Single use. The second arrival of the SAME correct code is refused.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('single');
    perform issue_email_verification_code(pg_temp.t_share(), 'single@acme.test',
              pg_temp.t_hash('222222'), v_c, null);
    perform check_email_verification_code(pg_temp.t_share(), 'single@acme.test',
              pg_temp.t_hash('222222'), v_c);
    v_v := check_email_verification_code(pg_temp.t_share(), 'single@acme.test',
             pg_temp.t_hash('222222'), v_c);
    if v_v <> 'bad' then
      v_detail := format('a used code returned %s the second time, expected bad', v_v);
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('D a code is single use', v_ok, v_detail);
end;
$$;

-- E. Five wrong attempts burn it, and the sixth request — with the RIGHT code —
--    is refused. This is the guessing budget, and it is the one that has to be
--    counted atomically.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text; v_n int;
begin
  begin
    v_c := pg_temp.t_challenge('burn');
    perform issue_email_verification_code(pg_temp.t_share(), 'burn@acme.test',
              pg_temp.t_hash('333333'), v_c, null);
    for i in 1..5 loop
      v_v := check_email_verification_code(pg_temp.t_share(), 'burn@acme.test',
               pg_temp.t_hash('999999'), v_c);
      if v_v <> 'bad' then
        v_detail := format('wrong guess %s returned %s', i, v_v);
        exit;
      end if;
    end loop;
    if v_detail = '' then
      select attempts into v_n from email_verification_codes
       where share_id = pg_temp.t_share() and email = 'burn@acme.test';
      if v_n <> 5 then
        v_detail := format('five guesses counted %s attempts', v_n);
      else
        v_v := check_email_verification_code(pg_temp.t_share(), 'burn@acme.test',
                 pg_temp.t_hash('333333'), v_c);
        if v_v <> 'bad' then
          v_detail := 'the right code still worked after five wrong guesses';
        else
          v_ok := true;
        end if;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('E five wrong attempts burn the code', v_ok, v_detail);
end;
$$;

-- F. Asking for a new code does not revive the burnt one, and does not hand
--    the guesser a second live code to work on at the same time.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text; v_live int;
begin
  begin
    v_c := pg_temp.t_challenge('reissue');
    perform issue_email_verification_code(pg_temp.t_share(), 'reissue@acme.test',
              pg_temp.t_hash('444444'), v_c, null);
    perform issue_email_verification_code(pg_temp.t_share(), 'reissue@acme.test',
              pg_temp.t_hash('555555'), v_c, null);
    select count(*) into v_live from email_verification_codes
     where share_id = pg_temp.t_share() and email = 'reissue@acme.test'
       and used_at is null and expires_at > now();
    if v_live <> 1 then
      v_detail := format('%s codes were live at once for one browser, expected 1', v_live);
    else
      v_v := check_email_verification_code(pg_temp.t_share(), 'reissue@acme.test',
               pg_temp.t_hash('444444'), v_c);
      if v_v <> 'bad' then
        v_detail := 'the superseded code still worked';
      else
        v_v := check_email_verification_code(pg_temp.t_share(), 'reissue@acme.test',
                 pg_temp.t_hash('555555'), v_c);
        if v_v <> 'ok' then
          v_detail := format('the new code returned %s, expected ok', v_v);
        else
          v_ok := true;
        end if;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('F a new code retires the old one rather than adding to it', v_ok, v_detail);
end;
$$;

-- G. The three ways a code belongs somewhere else, and they are one answer.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('elsewhere');
    perform issue_email_verification_code(pg_temp.t_share(), 'elsewhere@acme.test',
              pg_temp.t_hash('666666'), v_c, null);
    -- Another link.
    if check_email_verification_code(pg_temp.t_other(), 'elsewhere@acme.test',
         pg_temp.t_hash('666666'), v_c) <> 'bad' then
      v_detail := 'a code for one link worked on another';
    -- Another address.
    elsif check_email_verification_code(pg_temp.t_share(), 'someone@acme.test',
            pg_temp.t_hash('666666'), v_c) <> 'bad' then
      v_detail := 'a code for one address worked for another';
    -- Another browser.
    elsif check_email_verification_code(pg_temp.t_share(), 'elsewhere@acme.test',
            pg_temp.t_hash('666666'), pg_temp.t_challenge('other-browser')) <> 'bad' then
      v_detail := 'a code worked in a browser that never asked for it';
    -- And none of those three spent the genuine reader's attempts.
    elsif (select attempts from email_verification_codes
            where share_id = pg_temp.t_share() and email = 'elsewhere@acme.test') <> 0 then
      v_detail := 'a refusal elsewhere spent the real reader''s attempts';
    elsif check_email_verification_code(pg_temp.t_share(), 'elsewhere@acme.test',
            pg_temp.t_hash('666666'), v_c) <> 'ok' then
      v_detail := 'the genuine reader could no longer use their own code';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('G wrong link, wrong address and wrong browser are all refused', v_ok, v_detail);
end;
$$;

-- H. An expired code is refused, and a code that never existed is refused with
--    the same word — there is no verdict that distinguishes them.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text;
begin
  begin
    v_c := pg_temp.t_challenge('expired');
    perform issue_email_verification_code(pg_temp.t_share(), 'expired@acme.test',
              pg_temp.t_hash('777777'), v_c, null);
    update email_verification_codes set expires_at = now() - interval '1 second'
     where share_id = pg_temp.t_share() and email = 'expired@acme.test';
    if check_email_verification_code(pg_temp.t_share(), 'expired@acme.test',
         pg_temp.t_hash('777777'), v_c) <> 'bad' then
      v_detail := 'an expired code still worked';
    elsif check_email_verification_code(pg_temp.t_share(), 'never-asked@acme.test',
            pg_temp.t_hash('777777'), v_c) <> 'bad' then
      v_detail := 'a code that was never issued was accepted';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('H expired and never-issued are the same refusal', v_ok, v_detail);
end;
$$;

-- I. THREE CODES PER ADDRESS PER LINK PER FIFTEEN MINUTES.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('perlink');
    for i in 1..3 loop
      v_v := issue_email_verification_code(pg_temp.t_share(), 'perlink@acme.test',
               pg_temp.t_hash('1000' || i), v_c, null);
      if v_v <> 'ok' then
        v_detail := format('code %s of the allowance returned %s', i, v_v);
        exit;
      end if;
    end loop;
    if v_detail = '' then
      v_v := issue_email_verification_code(pg_temp.t_share(), 'perlink@acme.test',
               pg_temp.t_hash('100099'), v_c, null);
      if v_v <> 'rate_limited' then
        v_detail := format('the fourth code in fifteen minutes returned %s', v_v);
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('I three codes per address per link per fifteen minutes', v_ok, v_detail);
end;
$$;

-- J. FIVE PER ADDRESS PER HOUR ACROSS EVERY LINK OF ONE OWNER. The
--    inbox-flooding limit, and the reason the fixture has two shares under the
--    same owner: an owner with a second link must not get a second budget.
--    Case W is the other half of this — that a DIFFERENT owner's link has its
--    own budget, which is what review finding 5 asked for.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('flood');
    -- Three on the first link exhausts that link's allowance...
    for i in 1..3 loop
      perform issue_email_verification_code(pg_temp.t_share(), 'flood@acme.test',
                pg_temp.t_hash('2000' || i), v_c, null);
    end loop;
    -- ...and the second link carries on from three, not from zero.
    if issue_email_verification_code(pg_temp.t_other(), 'flood@acme.test',
         pg_temp.t_hash('200004'), v_c, null) <> 'ok' then
      v_detail := 'the fourth code overall was refused too early';
    elsif issue_email_verification_code(pg_temp.t_other(), 'flood@acme.test',
            pg_temp.t_hash('200005'), v_c, null) <> 'ok' then
      v_detail := 'the fifth code overall was refused too early';
    else
      v_v := issue_email_verification_code(pg_temp.t_other(), 'flood@acme.test',
               pg_temp.t_hash('200006'), v_c, null);
      if v_v <> 'rate_limited' then
        v_detail := format('the sixth code in an hour, on a second link, returned %s', v_v);
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('J five per address per hour, across every link of one owner', v_ok, v_detail);
end;
$$;

-- K. THE PER-NETWORK CEILING, on addresses that are all different — which is
--    what walking an allow-list looks like.
do $$
declare v_ok boolean := false; v_detail text := ''; v_v text;
begin
  begin
    for i in 1..20 loop
      v_v := issue_email_verification_code(pg_temp.t_share(), 'walk' || i || '@acme.test',
               pg_temp.t_hash('3000' || i), pg_temp.t_challenge('walk'), 'iphash-walker');
      if v_v <> 'ok' then
        v_detail := format('address %s of twenty was refused (%s)', i, v_v);
        exit;
      end if;
    end loop;
    if v_detail = '' then
      v_v := issue_email_verification_code(pg_temp.t_share(), 'walk21@acme.test',
               pg_temp.t_hash('300021'), pg_temp.t_challenge('walk'), 'iphash-walker');
      if v_v <> 'rate_limited' then
        v_detail := format('the twenty-first address from one network returned %s', v_v);
      -- And a different network is untouched by the walker's spending.
      elsif issue_email_verification_code(pg_temp.t_share(), 'innocent@acme.test',
              pg_temp.t_hash('300099'), pg_temp.t_challenge('innocent'), 'iphash-someone-else')
            <> 'ok' then
        v_detail := 'one network exhausting its ceiling locked another network out';
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('K a per-network ceiling, and it is not shared', v_ok, v_detail);
end;
$$;

-- L. THE DECISION IS SERIALISED. The advisory lock is transaction-scoped, so it
--    is still held here, and its key is the address the limits count. Without
--    it two concurrent issues both read a count neither has written to and both
--    insert, which is how a limit of three becomes no limit at all. Same shape
--    as 054's case G, and for the same reason: one connection cannot hold two
--    real transactions, so the lock is what is pinned.
do $$
declare v_ok boolean := false; v_detail text := ''; v_key bigint; v_held int;
begin
  begin
    v_key := hashtextextended('hr_verify_code|' || 'happy@acme.test', 0);
    select count(*) into v_held from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid()
       and ((classid::bigint << 32) | objid::bigint) = v_key;
    if v_held = 0 then
      v_detail := 'no advisory lock was taken on the address being limited';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('L issuing is serialised per address', v_ok, v_detail);
end;
$$;

-- M. AND SO IS CHECKING. Item A of the brief asks for proof that the attempt
--    counter cannot be bypassed by parallel requests. The row lock the check
--    takes would do it, but a lock on a row cannot be asserted from here once
--    the statement has finished; a transaction-scoped advisory lock can, and it
--    is still held. Its key is (link, address), which is the pair two
--    simultaneous guesses at one code share.
--
--    WHAT THIS STILL DOES NOT PROVE, and it is worth writing down rather than
--    implying: one connection cannot hold two real transactions, so no file
--    that runs here can watch a second guesser actually block. What is proved
--    is that the lock exists, is transaction-scoped and is keyed on the right
--    thing — which is what 054's case G proves about its own lock, for the same
--    reason.
do $$
declare v_ok boolean := false; v_detail text := ''; v_key bigint; v_held int;
begin
  begin
    v_key := hashtextextended(
      'hr_verify_check|' || pg_temp.t_share()::text || '|' || 'happy@acme.test', 0);
    select count(*) into v_held from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid()
       and ((classid::bigint << 32) | objid::bigint) = v_key;
    if v_held = 0 then
      v_detail := 'no advisory lock was taken on (link, address) while checking a code';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('M checking a code is serialised per link and address', v_ok, v_detail);
end;
$$;

-- N. THE FUNCTION DOES NOT KNOW THE ALLOW-LIST, and this is what makes the
--    worker's identical-screen promise cheap to keep. An address nowhere near
--    the list is issued a code exactly as one on it is; whether a message
--    follows is the worker's decision and is made somewhere else.
do $$
declare v_ok boolean := false; v_detail text := '';
begin
  begin
    update document_shares set allowed_emails = array['only-this@acme.test']
     where id = pg_temp.t_share();
    if issue_email_verification_code(pg_temp.t_share(), 'only-this@acme.test',
         pg_temp.t_hash('400001'), pg_temp.t_challenge('m1'), null) <> 'ok' then
      v_detail := 'the permitted address was refused';
    elsif issue_email_verification_code(pg_temp.t_share(), 'not-on-it@elsewhere.test',
            pg_temp.t_hash('400002'), pg_temp.t_challenge('m2'), null) <> 'ok' then
      v_detail := 'the database refused an address the worker had not judged yet';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('N issuing does the same work whoever the address is', v_ok, v_detail);
end;
$$;

-- O. A link that asks for no code cannot have one minted for it, and neither
--    can a revoked or expired one.
do $$
declare v_ok boolean := false; v_detail text := ''; v_v text;
begin
  begin
    update document_shares set verify_email = false where id = pg_temp.t_other();
    v_v := issue_email_verification_code(pg_temp.t_other(), 'off@acme.test',
             pg_temp.t_hash('500001'), pg_temp.t_challenge('off'), null);
    if v_v <> 'not_enabled' then
      v_detail := format('a link with verification off returned %s', v_v);
    else
      update document_shares set verify_email = true, revoked_at = now()
       where id = pg_temp.t_other();
      v_v := issue_email_verification_code(pg_temp.t_other(), 'revoked@acme.test',
               pg_temp.t_hash('500002'), pg_temp.t_challenge('rev'), null);
      if v_v <> 'no_share' then
        v_detail := format('a revoked link returned %s', v_v);
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('O no code for a link that does not ask, or is switched off', v_ok, v_detail);
end;
$$;

-- P. The write paths carry the flag, and the OLD signatures are gone. Both
--    halves matter: an overload left beside the new one makes the PostgREST
--    call ambiguous and the API starts failing, which is 033's lesson and 052's.
do $$
declare v_ok boolean := false; v_detail text := ''; v_n int;
begin
  begin
    select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'create_share';
    if v_n <> 1 then
      v_detail := format('create_share has %s overloads, expected exactly 1', v_n);
    elsif pg_get_function_arguments(
            (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'create_share')
          ) not like '%p_verify_email%' then
      v_detail := 'create_share does not accept p_verify_email';
    else
      select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('create_share_as', 'update_share');
      if v_n <> 2 then
        v_detail := format('create_share_as and update_share have %s overloads between them, expected 2', v_n);
      elsif exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('create_share_as', 'update_share')
           and pg_get_function_arguments(p.oid) not like '%p_verify_email%'
      ) then
        v_detail := 'one of create_share_as / update_share does not accept p_verify_email';
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('P one create_share, one create_share_as, one update_share, all taking the flag', v_ok, v_detail);
end;
$$;

-- Q. update_share really sets it, and switching the e-mail gate off switches
--    verification off rather than refusing the edit with a constraint error the
--    customer cannot read.
do $$
declare v_ok boolean := false; v_detail text := ''; v_share document_shares%rowtype;
begin
  begin
    perform set_config('request.jwt.claim.sub', (select owner_id::text from t_ref), true);
    update document_shares set require_email = true, verify_email = false, revoked_at = null
     where id = pg_temp.t_other();

    v_share := update_share(pg_temp.t_other(), null, true, false, null, null, null, null, true);
    if not v_share.verify_email then
      v_detail := 'update_share did not turn verification on';
    else
      v_share := update_share(pg_temp.t_other(), null, false, false, null, null, null, null, null);
      if v_share.verify_email then
        v_detail := 'turning the e-mail gate off left verification on';
      elsif v_share.require_email then
        v_detail := 'the e-mail gate did not turn off';
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('Q update_share sets the flag, and clears it with the gate', v_ok, v_detail);
end;
$$;

-- R. The proxy's one read carries the flag. Without this the worker would ask
--    for a column that is not in the view and every recipient request would
--    become the try-again page.
do $$
declare v_ok boolean := false; v_detail text := ''; v_n int;
begin
  begin
    select count(*) into v_n from information_schema.columns
     where table_schema = 'public' and table_name = 'share_lookup'
       and column_name in ('verify_email', 'document_title', 'owner_display_name', 'owner_email');
    if v_n <> 4 then
      v_detail := format('share_lookup carries %s of the four columns the gate reads', v_n);
    elsif exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'share_lookup' and grantee in ('anon', 'authenticated', 'PUBLIC')
    ) then
      v_detail := 'share_lookup is readable by something other than the service role';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('R share_lookup carries the flag, service role only', v_ok, v_detail);
end;
$$;

-- S. Nobody but the two functions can reach the codes, and no customer can
--    mark their own recipients verified.
do $$
declare v_ok boolean := false; v_detail text := '';
begin
  begin
    if exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'email_verification_codes'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    ) then
      v_detail := 'something holds a grant on email_verification_codes';
    elsif exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'share_email_verifications'
         and privilege_type <> 'SELECT'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    ) then
      v_detail := 'share_email_verifications is writable by a role that should only read it';
    elsif not (select relrowsecurity from pg_class where relname = 'email_verification_codes') then
      v_detail := 'row level security is off on email_verification_codes';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('S the codes are reachable only through the two functions', v_ok, v_detail);
end;
$$;

-- T. The sweep. Rows survive the hour the limits count over and are gone after
--    it, and it is carried by a job that already runs rather than a new one.
do $$
declare v_ok boolean := false; v_detail text := ''; v_n int;
begin
  begin
    update email_verification_codes set created_at = now() - interval '2 hours'
     where email = 'happy@acme.test';
    perform purge_connect_handles();
    select count(*) into v_n from email_verification_codes where email = 'happy@acme.test';
    if v_n <> 0 then
      v_detail := 'a two-hour-old code survived the sweep';
    else
      select count(*) into v_n from email_verification_codes where email = 'burn@acme.test';
      if v_n = 0 then
        v_detail := 'the sweep also took a code inside the hour the limits count';
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('T expired codes are swept by the job that already runs', v_ok, v_detail);
end;
$$;

-- U. The neighbours are untouched. 054's trigger is still the one on sessions,
--    and the handle purge still does its own job.
do $$
declare v_ok boolean := false; v_detail text := ''; v_def text;
begin
  begin
    select pg_get_functiondef(p.oid) into v_def from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'purge_connect_handles';
    if v_def not like '%connect_handles%' then
      v_detail := 'the handle purge lost its own delete';
    elsif not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'sessions' and t.tgname = 'trg_notify_on_first_open'
    ) then
      v_detail := 'the first-open trigger is no longer on sessions';
    elsif not exists (
      select 1 from information_schema.columns
       where table_name = 'viewers' and column_name = 'email'
    ) then
      v_detail := 'the viewers table lost its address column';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('U the neighbouring migrations are untouched', v_ok, v_detail);
end;
$$;

-- ------------------------------------------------------------
-- V to AA are the cases the security review of 2026-09-21 asked for:
-- findings 3a (the database fails closed for a worker that does not enforce
-- verification), 5 (one reader cannot be locked out across all owners) and 7
-- (the per-network ceiling is not racable).
-- ------------------------------------------------------------

-- V. A NON-PERMITTED REQUEST SPENDS NO ADDRESS BUDGET, AND STILL COUNTS
--    TOWARD THE NETWORK CEILING. This is rule (a), and it is the half of
--    finding 5 that mattered most: an attacker who knows nothing but a
--    reader's address could type it into any link at all and burn that
--    reader's allowance, with no mail sent and therefore nothing for anybody
--    to notice.
--
--    Twenty non-permitted requests is far past every address budget — the
--    three-per-link allowance, the five-per-owner one, the global fifteen —
--    so if any of them were being spent, one of these twenty would be
--    refused. All twenty are accepted. The twenty-first is refused, which is
--    the per-network ceiling counting them: the rows exist, they are simply
--    not the ADDRESS's to spend. And afterwards the address's own
--    three-per-link allowance is still whole, tested from a different network
--    so the ceiling is not what refuses the fourth.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    v_c := pg_temp.t_challenge('nonperm');
    for i in 1..20 loop
      v_v := issue_email_verification_code(pg_temp.t_share(), 'nonperm@acme.test',
               pg_temp.t_hash('6000' || i), v_c, 'iphash-nonperm', false);
      if v_v <> 'ok' then
        v_detail := format('non-permitted request %s of twenty returned %s — an address budget was spent', i, v_v);
        exit;
      end if;
    end loop;
    if v_detail = '' then
      if issue_email_verification_code(pg_temp.t_share(), 'nonperm@acme.test',
           pg_temp.t_hash('600021'), v_c, 'iphash-nonperm', false) <> 'rate_limited' then
        v_detail := 'twenty non-permitted requests from one network did not reach the per-network ceiling';
      elsif (select count(*) from email_verification_codes
              where email = 'nonperm@acme.test' and counts_toward_address) <> 0 then
        v_detail := 'a non-permitted request was recorded as counting toward the address';
      else
        -- The reader's own allowance, from a different network, is untouched.
        for i in 1..3 loop
          v_v := issue_email_verification_code(pg_temp.t_share(), 'nonperm@acme.test',
                   pg_temp.t_hash('6100' || i), v_c, 'iphash-nonperm-real', true);
          if v_v <> 'ok' then
            v_detail := format('the reader''s own request %s of three was refused (%s)', i, v_v);
            exit;
          end if;
        end loop;
        if v_detail = '' then
          v_v := issue_email_verification_code(pg_temp.t_share(), 'nonperm@acme.test',
                   pg_temp.t_hash('610099'), v_c, 'iphash-nonperm-real', true);
          if v_v <> 'rate_limited' then
            v_detail := format('the reader''s fourth permitted request returned %s, expected rate_limited', v_v);
          else
            v_ok := true;
          end if;
        end if;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('V a non-permitted request spends no address budget but counts toward the network ceiling', v_ok, v_detail);
end;
$$;

-- W. THE HOURLY BUDGET IS PER LINK OWNER. Finding 5's other half: three
--    requests on one attacker-owned link and two on another used to exhaust a
--    named reader's budget for the WHOLE product, so the code they were
--    actually waiting for, on somebody else's link, never arrived.
--
--    This is tested with a SECOND REAL OWNER rather than by inspecting the
--    count's WHERE clause: owner one's two links are driven to their five, the
--    sixth on owner one is refused, and then owner two's link issues normally
--    for the same address. If the database had no second usable account the
--    fixture leaves share2_id null and this case FAILS rather than passing on
--    something weaker.
--
--    t_other() is reset first, because cases O and Q leave it revoked and with
--    verification off.
do $$
declare v_ok boolean := false; v_detail text := ''; v_c text; v_v text;
begin
  begin
    if pg_temp.t_share2() is null then
      v_detail := 'the database has no second internal account with room under the share cap, '
               || 'so per-owner scoping could not be tested against a real second owner';
    else
      update document_shares set require_email = true, verify_email = true, revoked_at = null
       where id = pg_temp.t_other();
      v_c := pg_temp.t_challenge('owners');

      for i in 1..3 loop
        v_v := issue_email_verification_code(pg_temp.t_share(), 'owners@acme.test',
                 pg_temp.t_hash('7000' || i), v_c, null, true);
        if v_v <> 'ok' then
          v_detail := format('owner one, link one, code %s returned %s', i, v_v);
          exit;
        end if;
      end loop;

      if v_detail = '' then
        for i in 4..5 loop
          v_v := issue_email_verification_code(pg_temp.t_other(), 'owners@acme.test',
                   pg_temp.t_hash('7000' || i), v_c, null, true);
          if v_v <> 'ok' then
            v_detail := format('owner one, link two, code %s returned %s', i, v_v);
            exit;
          end if;
        end loop;
      end if;

      if v_detail = '' then
        v_v := issue_email_verification_code(pg_temp.t_other(), 'owners@acme.test',
                 pg_temp.t_hash('700006'), v_c, null, true);
        if v_v <> 'rate_limited' then
          v_detail := format('owner one''s sixth code in an hour returned %s', v_v);
        else
          -- The point of the whole case: a different owner has a different budget.
          v_v := issue_email_verification_code(pg_temp.t_share2(), 'owners@acme.test',
                   pg_temp.t_hash('700007'), v_c, null, true);
          if v_v <> 'ok' then
            v_detail := format('a second owner''s link returned %s for a reader whose budget '
                            || 'only the first owner had spent', v_v);
          else
            v_ok := true;
          end if;
        end if;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('W the hourly budget is per link owner, and a second owner is unaffected', v_ok, v_detail);
end;
$$;

-- X. THE GLOBAL CEILING OF FIFTEEN. Rule (c): flood protection above the
--    per-owner budget, so no number of accounts can put more than fifteen
--    codes an hour into one inbox.
--
--    Reaching fifteen legitimately would need three owners, and the database
--    has two usable internal accounts. The other fourteen rows are therefore
--    written straight into the table under four made-up owner identifiers —
--    which is honest rather than a shortcut, because `owner_id` here is a
--    plain uuid the function copies off the share and the ceiling counts rows,
--    not accounts. They are dated twenty minutes ago so the fifteen-minute
--    per-link rule cannot see them, and spread so no made-up owner holds more
--    than four, so the per-owner rule cannot be what refuses anything. The one
--    limit left that can refuse is the global fifteen, and it does.
do $$
declare v_ok boolean := false; v_detail text := ''; v_v text;
begin
  begin
    insert into email_verification_codes (
      share_id, email, code_hash, challenge, ip_hash, owner_id,
      counts_toward_address, expires_at, created_at
    )
    select pg_temp.t_share(), 'ceiling@acme.test',
           encode(digest('seed|' || i, 'sha256'), 'hex'),
           substr(encode(digest('seedc|' || i, 'sha256'), 'hex'), 1, 32),
           null,
           ('00000000-0000-0000-0000-00000000000' || (i % 4 + 1))::uuid,
           true,
           now() - interval '10 minutes',
           now() - interval '20 minutes'
      from generate_series(1, 14) i;

    v_v := issue_email_verification_code(pg_temp.t_share(), 'ceiling@acme.test',
             pg_temp.t_hash('800015'), pg_temp.t_challenge('ceiling'), null, true);
    if v_v <> 'ok' then
      v_detail := format('the fifteenth code in an hour returned %s, expected ok', v_v);
    else
      v_v := issue_email_verification_code(pg_temp.t_share(), 'ceiling@acme.test',
               pg_temp.t_hash('800016'), pg_temp.t_challenge('ceiling'), null, true);
      if v_v <> 'rate_limited' then
        v_detail := format('the sixteenth code in an hour returned %s', v_v);
      else
        v_ok := true;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('X fifteen per address per hour across all owners', v_ok, v_detail);
end;
$$;

-- Y. THE DATABASE FAILS CLOSED. Finding 3a. `share_lookup` is the view the OLD
--    worker reads, and a verified link is not in it, so a worker that ignores
--    the flag — because it was deployed late, or because it was rolled back —
--    finds no row and shows its ordinary not-found page instead of the
--    document. The NEW worker reads `share_lookup_for(slug, true)` and gets the
--    row; the same function with false does not, so a caller that has not said
--    it enforces verification is treated exactly like the old worker.
--
--    And the ordinary link is still served by both, because failing closed on
--    verified links must not close anything else.
do $$
declare v_ok boolean := false; v_detail text := '';
begin
  begin
    if exists (select 1 from share_lookup where slug = 'quiet-falcon-055aaa') then
      v_detail := 'share_lookup still hands a verified link to a worker that may not enforce it';
    elsif not exists (select 1 from share_lookup_for('quiet-falcon-055aaa', true)) then
      v_detail := 'share_lookup_for(slug, true) did not return the verified link the new worker needs';
    elsif exists (select 1 from share_lookup_for('quiet-falcon-055aaa', false)) then
      v_detail := 'share_lookup_for(slug, false) returned a verified link to a caller that does not enforce it';
    elsif not exists (select 1 from share_lookup where slug = 'quiet-falcon-055ccc') then
      v_detail := 'an ordinary link disappeared from share_lookup';
    elsif not exists (select 1 from share_lookup_for('quiet-falcon-055ccc', false)) then
      v_detail := 'an ordinary link is not returned by share_lookup_for';
    elsif exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'share_lookup_all'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    ) then
      v_detail := 'share_lookup_all is readable directly, which is a way around the filter';
    else
      v_ok := true;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('Y share_lookup hides a verified link and share_lookup_for is the only door', v_ok, v_detail);
end;
$$;

-- Z. BOTH BUCKETS ARE LOCKED, AND IN A FIXED ORDER. Finding 7: only the
--    address bucket used to be locked, so parallel requests for DIFFERENT
--    addresses from one network never met and could all read a network count
--    none of them had written to. Both locks are transaction-scoped, so every
--    one taken by every case above is still held here and can be counted.
--
--    The second half is the ordering. Two locks is how deadlocks are made, and
--    what prevents one is that every request takes the smaller bigint key
--    first — a total order, so there is no cycle to wait in. That is a property
--    of the code, not of a row, so it is asserted against the function's own
--    definition: `least` and `greatest` around the two keys, and no branch
--    between them. If somebody replaces that with "address first, then
--    network", this case fails.
--
--    WHAT REMAINS UNPROVEN, AND IT IS THE RACE ITSELF. Nothing in this file
--    runs two transactions at once, so nothing here watches a second request
--    actually block on the network lock. That is not a choice: the dry run
--    reaches the database through the Supabase Management API over a single
--    connection, and a second connection is no use either, because every share
--    this file tests against lives in an UNCOMMITTED transaction and is
--    invisible outside it — a second session would be told `no_share`. The two
--    extensions that could run a statement in another backend were checked
--    read-only before this was written: `pg_background` is not available on
--    this Postgres at all, and `dblink` is available but not installed, and
--    installing it would not help for the reason just given. Committing a
--    fixture to production to make a race possible is not something a dry run
--    gets to do. So what is proved here is that both locks are taken, that
--    they are transaction-scoped, that they are keyed on the two buckets the
--    limits count, and that they are taken in a fixed total order. The
--    conclusion that this makes the counts unracable and deadlock-free is an
--    argument from those four facts, and the honest place for a real
--    two-connection race is a scratch database with the fixture committed,
--    which this project does not have.
do $$
declare
  v_ok boolean := false; v_detail text := '';
  v_addr bigint; v_net bigint; v_held int; v_def text;
begin
  begin
    v_addr := hashtextextended('hr_verify_code|' || 'happy@acme.test', 0);
    v_net  := hashtextextended('hr_verify_net|' || 'iphash-happy', 0);

    select count(*) into v_held from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid()
       and ((classid::bigint << 32) | objid::bigint) = v_net;
    if v_held = 0 then
      v_detail := 'no advisory lock was taken on the network bucket, so the per-network '
               || 'ceiling can still be walked through by parallel requests';
    else
      select count(*) into v_held from pg_locks
       where locktype = 'advisory' and pid = pg_backend_pid()
         and ((classid::bigint << 32) | objid::bigint) in (v_addr, v_net);
      if v_held < 2 then
        v_detail := format('only %s of the two buckets was locked', v_held);
      else
        select pg_get_functiondef(p.oid) into v_def
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'issue_email_verification_code';
        if v_def not like '%least(v_addr_key, v_net_key)%'
           or v_def not like '%greatest(v_addr_key, v_net_key)%' then
          v_detail := 'the two locks are not taken in ascending key order, so two requests '
                   || 'wanting the same pair can deadlock';
        else
          v_ok := true;
        end if;
      end if;
    end if;
  exception when others then v_detail := 'error: ' || sqlerrm;
  end;
  perform pg_temp.t_check('Z both the address and the network bucket are locked, in ascending key order', v_ok, v_detail);
end;
$$;

-- ------------------------------------------------------------
-- The report, and the rollback. Raising is how the run ends, on purpose: it
-- guarantees the transaction rolls back whatever happened above, and an error
-- message is the only channel that survives the Supabase Management API.
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
  raise exception '055 DRY RUN: % of % passed | %', v_pass, v_total, coalesce(v_msg, 'no cases ran')
    using errcode = 'P0055';
end;
$$;

-- Unreachable while the block above raises, and kept as a belt: if that report
-- is ever removed, this file still refuses to leave anything behind.
rollback;
