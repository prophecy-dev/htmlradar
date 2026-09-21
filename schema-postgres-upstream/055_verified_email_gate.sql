-- 055_verified_email_gate.sql
-- ------------------------------------------------------------
-- The e-mail gate learns to check that the address is really the reader's.
--
-- WHAT WAS WRONG. `require_email` accepts whatever a reader types. The
-- allow-lists on a share are therefore an honour system: anybody holding the
-- link opens it by typing an address that happens to be on the list, and the
-- "who read it" column of every read report is only as true as what was typed.
--
-- WHAT THIS ADDS. A second, per-share option: `verify_email`. With it on, the
-- address the reader types is sent a six-digit code, and the document opens
-- only when that code comes back. The design and the failure list this file
-- answers are
-- docs/workstreams/security/VERIFIED-EMAIL-GATE-BRIEF-2026-09-21.md.
--
-- THE FOUR PIECES, and why each is here rather than in the worker.
--
--   1. `document_shares.verify_email`, with a CHECK that ties it to
--      `require_email`. Decision 9 of the brief says the option is refused
--      when the e-mail gate is off. The application, the public API and the
--      connector all say so in words a customer can read; this constraint is
--      what makes it true for every writer, including a hand-typed UPDATE.
--
--   2. `email_verification_codes`, holding a KEYED HASH of the code and never
--      the code. The key is the worker's SESSION_SECRET, which is not in this
--      database, so a reader of this table cannot walk a hash back to a code
--      by trying all a million of them.
--
--   3. Two functions, `issue_email_verification_code` and
--      `check_email_verification_code`. The limits and the attempt counter
--      are HERE and not in worker memory because a Worker isolate is one of
--      many: two requests land on two isolates, each counts to one, and a
--      limit of three is really a limit of thirty. A database row is the only
--      place the count is shared.
--
--   4. `share_email_verifications`, the durable record that an address proved
--      itself on a link. This is what the read report reads.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON `viewers`. The brief says "the
-- verified flag on the viewer or session so the report can show it". A column
-- on `viewers` would be null on almost every real verification, because of the
-- ORDER things happen in: the reader verifies, the document is then served,
-- and only then does the tracker create the viewer row. There is no viewer to
-- stamp at the moment verification happens. Verification is in any case a fact
-- about (link, address) and not about one browser session — the same address
-- returning tomorrow in another browser is still the address that proved
-- itself — so the key of this table is the fact itself. The read report joins
-- it to `viewers` on (share_id, lower(email)), which is the same pairing every
-- other per-recipient join in the product already uses.
--
-- WHAT IS DELIBERATELY UNTOUCHED. `require_password`, the password gate's own
-- rate limiter (004), the allow-lists (008), the opt-out, the owner preview,
-- the first-open notification (054) and every existing share. Every column
-- added here defaults to the behaviour that exists today, so no owner has a
-- migration step and no link changes what it does.
--
-- ------------------------------------------------------------
-- APPLY. Paste the WHOLE file into the Supabase SQL editor and run once, or
-- `psql -f` it. It carries its own BEGIN and COMMIT, so it applies as one
-- transaction: either all of it is there or none of it is. Idempotent —
-- `create table if not exists`, `add column if not exists`, a guarded
-- constraint drop, `create or replace` on every function, and a rebuilt view
-- with its grants re-stated — so re-running leaves exactly the same objects
-- behind.
--
-- ORDER RELATIVE TO THE WORKER DEPLOY: THIS FILE FIRST, THEN THE WORKER — and
-- since the review, the database no longer TRUSTS that order, it ENFORCES it.
--
-- The old argument was that the application would not offer the option until
-- its own deploy, so in the window between this file and the worker nothing
-- could be verified yet. That argument depends on two deploys landing in the
-- intended order and on neither being rolled back, and the review found both
-- assumptions breakable: the application reaches production before the worker,
-- and rolling the worker back restored a build that ignores the flag. Either
-- way a link the owner believes is verified would have been served by a worker
-- that opens it on a typed address alone.
--
-- Section 7 removes the assumption. `share_lookup` — the view the OLD worker
-- reads — is now filtered to `where not verify_email`, so a verified link is
-- simply not in it: an old worker finds no row and answers its ordinary
-- not-found page. The NEW worker reads through `share_lookup_for(slug, true)`,
-- which is the only door that returns a verified row and only when the caller
-- states that it enforces verification. The failure mode of every wrong
-- ordering and every rollback is therefore a closed link, never an open one.
--
-- ROLLBACK. Deploy the previous worker. Verified links stop opening — they are
-- invisible to it — and every other link is unaffected. That is the intended
-- behaviour and not a regression: a verified link that opens without a code is
-- the thing being prevented. To restore service on those links, roll the worker
-- FORWARD again, or turn verification off on the affected shares.
--
-- CONFIRM, after applying:
--   select column_name from information_schema.columns
--    where table_name = 'document_shares' and column_name = 'verify_email';
--   select count(*) from document_shares where verify_email;   -- expect 0
--   select proname from pg_proc
--    where proname in ('issue_email_verification_code',
--                      'check_email_verification_code',
--                      'share_lookup_for');                     -- expect 3
--   select 'verify_email' = any (
--     select column_name from information_schema.columns
--      where table_name = 'share_lookup_all');                  -- expect true
--   -- and the fail-closed property itself:
--   select count(*) from share_lookup where verify_email;       -- expect 0
-- ------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 1. The per-share flag, and the constraint that is decision 9.
--
-- `not verify_email or require_email` is "verification implies the gate".
-- Written that way rather than as an implication because Postgres has no
-- implication operator and this is the form every reader of the table can
-- check by eye. Every existing row satisfies it, because the new column
-- defaults to false, so the ALTER does not have to rewrite the table's data
-- and takes only the brief ACCESS EXCLUSIVE lock a catalogue change needs.
--
-- NOT VALID is deliberately NOT used. That is for constraints an existing
-- table might violate; this one cannot be violated by any existing row, and a
-- NOT VALID constraint is a second thing somebody has to remember to validate
-- later.
-- ------------------------------------------------------------
alter table public.document_shares
  add column if not exists verify_email boolean not null default false;

comment on column public.document_shares.verify_email is
  'When true, the e-mail gate mails a six-digit code to the address the reader types and opens the document only when that code comes back. Requires require_email (see the CHECK below). Off on every existing link; turning it on makes readers who are already past the gate verify at their next open.';

alter table public.document_shares
  drop constraint if exists document_shares_verify_needs_email;
alter table public.document_shares
  add constraint document_shares_verify_needs_email
  check (not verify_email or require_email);

-- ------------------------------------------------------------
-- 2. The codes.
--
-- WHAT IS STORED, AND WHAT IS NOT. `code_hash` is HMAC-SHA256 of
-- `verify:{share_id}|{email}|{code}` under the worker's SESSION_SECRET, in
-- hex. The code itself never reaches this database in any form. The key is not
-- in this database either, so the hash is not a puzzle a reader of the table
-- can solve: without the key, a million candidate codes produce a million
-- hashes and none of them is comparable to the stored one.
--
-- The share and the address are IN the signed message, not merely in
-- neighbouring columns, so a row copied to another share or another address
-- cannot be made to match: the hash the worker computes on the way in carries
-- both, and it would differ.
--
-- `challenge` is a random 128-bit value the worker sets as a `__Host-` cookie
-- on the browser that asked for the code, and it is in the row rather than in
-- the message so a code can be looked up by the browser that owns it. It is
-- what makes a code read over somebody's shoulder useless: typed into a
-- different browser it finds no row, because that browser holds a different
-- challenge.
--
-- THE ADDRESS IS IN THE CLEAR, and that is a considered choice rather than an
-- oversight. It has to be readable to enforce "five codes per address per hour
-- ACROSS ALL LINKS", which is the limit that stops the gate being used to
-- flood somebody's inbox, and a keyed hash of it would enforce the same limit
-- while adding a second secret and a second thing to rotate. The product
-- already stores recipient addresses in the clear in `document_shares.allowed_emails`
-- and in `viewers.email`; inventing a different privacy model for one table
-- that holds its rows for at most an hour would be complexity without a gain.
--
-- RETENTION. A row is useful for ten minutes as a code and for sixty minutes
-- as a rate-limit fact, so the sweep in section 6 deletes it an hour after it
-- was made, not when it expires.
-- ------------------------------------------------------------
create table if not exists public.email_verification_codes (
  id          uuid primary key default gen_random_uuid(),
  share_id    uuid not null references public.document_shares(id) on delete cascade,
  -- Lower-cased by the worker and again by the functions below, so the same
  -- address in two letter-cases is one address to every limit here.
  email       text not null check (length(email) between 3 and 320),
  code_hash   text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  challenge   text not null check (challenge ~ '^[0-9a-f]{32}$'),
  -- The rate-limit identity of the connecting network address, hashed by the
  -- worker under the same key it hashes abuse reporters with. The raw address
  -- never leaves the worker. Nullable: a request with no CF-Connecting-IP (a
  -- local run) has none, and those share one bucket rather than escaping it.
  ip_hash     text,
  -- The owner of the link the code was minted for, copied from the share at
  -- insert rather than joined at count time. It is here so the inbox-protecting
  -- hourly budget can be PER OWNER (section 5a, rule b) as a single indexed
  -- count. Plain uuid and not a foreign key: the row lives an hour and
  -- `share_id` already cascades, so a second constraint would only add a second
  -- lock to take on every insert.
  owner_id    uuid,
  -- Whether this request may spend the ADDRESS's budgets. False on a request
  -- the worker has already judged non-permitted: it still has to exist, because
  -- the per-network ceiling counts every row and that ceiling is what bounds an
  -- address-walker, but it must not be able to spend a budget belonging to a
  -- reader who has done nothing. See rule (a) in section 5a.
  counts_toward_address boolean not null default true,
  expires_at  timestamptz not null,
  attempts    smallint not null default 0,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Idempotency: `create table if not exists` above does nothing to a table that
-- is already there, so a re-run over an earlier 055 adds the two columns here.
alter table public.email_verification_codes
  add column if not exists owner_id uuid;
alter table public.email_verification_codes
  add column if not exists counts_toward_address boolean not null default true;

-- The four reads the function below makes, in the order it makes them.
create index if not exists email_verification_codes_share_email_idx
  on public.email_verification_codes (share_id, email, created_at desc);
create index if not exists email_verification_codes_email_owner_idx
  on public.email_verification_codes (email, owner_id, created_at desc);
create index if not exists email_verification_codes_email_idx
  on public.email_verification_codes (email, created_at desc);
create index if not exists email_verification_codes_ip_idx
  on public.email_verification_codes (ip_hash, created_at desc)
  where ip_hash is not null;
-- The sweep.
create index if not exists email_verification_codes_created_idx
  on public.email_verification_codes (created_at);

-- NOBODY READS THIS TABLE DIRECTLY. RLS is on with no policy at all, so the
-- table is closed to `authenticated` and `anon` whatever else is granted; the
-- two functions below are SECURITY DEFINER and are the only doors. Not even
-- the service role gets a grant: the worker holds that key, and the worker has
-- no business reading a hash it can compute itself.
alter table public.email_verification_codes enable row level security;
revoke all on public.email_verification_codes from public, anon, authenticated, service_role;

comment on table public.email_verification_codes is
  'Short-lived verification codes for the verified e-mail gate. Holds a keyed hash of the code (HMAC under the worker''s SESSION_SECRET, which is not in this database) and never the code. Rows are swept an hour after they are made. Reachable only through issue_email_verification_code and check_email_verification_code.';

-- ------------------------------------------------------------
-- 3. The durable record: this address proved itself on this link.
--
-- Written by the check function on success, read by the read report. One row
-- per (link, address) however many times that address verifies, with the first
-- and the latest time kept, because "when did this person first prove who they
-- were" and "are they still the same person coming back" are both questions a
-- salesperson asks of a read report.
--
-- RLS lets a link's OWNER read their own rows and nobody else read anything.
-- No insert, update or delete policy exists, so the only writer is the
-- SECURITY DEFINER function below: an owner cannot mark an address verified by
-- hand, which would make the mark worth nothing.
-- ------------------------------------------------------------
create table if not exists public.share_email_verifications (
  share_id          uuid not null references public.document_shares(id) on delete cascade,
  email             text not null,
  first_verified_at timestamptz not null default now(),
  last_verified_at  timestamptz not null default now(),
  primary key (share_id, email)
);

alter table public.share_email_verifications enable row level security;

drop policy if exists "share_email_verifications_owner_read" on public.share_email_verifications;
create policy "share_email_verifications_owner_read" on public.share_email_verifications
  for select to authenticated
  using (
    exists (
      select 1 from public.document_shares s
       where s.id = share_email_verifications.share_id
         and s.owner_id = auth.uid()
    )
  );

revoke all on public.share_email_verifications from public, anon, authenticated, service_role;
grant select on public.share_email_verifications to authenticated;
grant select on public.share_email_verifications to service_role;

comment on table public.share_email_verifications is
  'One row per (link, address) that has passed the verified e-mail gate. Read by the read report to mark an address verified. Written only by check_email_verification_code — an owner cannot mark their own recipients verified.';

-- ------------------------------------------------------------
-- 4. Constant-time equality, for the one comparison that matters.
--
-- WHERE THE COMPARISON HAPPENS is the database, because the atomic attempt
-- counter and the comparison have to be the same statement: any design that
-- returns the stored hash to the worker to compare there has a gap between the
-- read and the increment, and a gap is what parallel requests are for.
--
-- Postgres has no constant-time compare, so here is one. It runs over the full
-- length with no early exit, accumulating differences with a bitwise OR, which
-- is the same shape as the worker's own constantTimeEqual in auth.ts. The
-- length check before the loop is not a leak: both sides are always 64 hex
-- characters by the CHECK on the column and by what the worker computes, so an
-- unequal length is a malformed input and not a near-miss.
--
-- IS THIS NEEDED? Honestly: a timing oracle here would leak an HMAC, and an
-- attacker cannot submit an HMAC — they submit a code to the worker, which
-- hashes it. To exploit the oracle they would already need the code. It is ten
-- lines, it is the brief's requirement, and it removes the argument entirely,
-- so it is here rather than in a note explaining why it is not.
-- ------------------------------------------------------------
create or replace function public.ct_eq(a text, b text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_diff int := 0;
  v_len  int;
begin
  if a is null or b is null then return false; end if;
  v_len := pg_catalog.length(a);
  if v_len <> pg_catalog.length(b) then return false; end if;
  for i in 1..v_len loop
    v_diff := v_diff | (pg_catalog.ascii(pg_catalog.substr(a, i, 1))
                        # pg_catalog.ascii(pg_catalog.substr(b, i, 1)));
  end loop;
  return v_diff = 0;
end;
$$;

comment on function public.ct_eq(text, text) is
  'Constant-time string equality: runs the whole length with no early exit. Used by check_email_verification_code so the comparison of a keyed code hash leaks nothing through timing.';

revoke all on function public.ct_eq(text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5a. Issuing a code, with the three limits.
--
-- THE LIMITS, and what each one is for (decision 5, reworked after finding 5
-- of the review):
--
--   (d) three per address per link per fifteen minutes — the ordinary
--     "I did not get it, send another" allowance, and the cap on how many live
--     codes one attacker can be working on at a time.
--   (b) five per address per hour PER LINK OWNER — the inbox-flooding limit.
--     It used to be five per address per hour across every link in the
--     product, and the review showed what that costs: three requests on one
--     attacker-owned link and two on another exhaust a named reader's budget
--     for the WHOLE product, so the code they are actually waiting for, on
--     somebody else's link, never arrives. Scoping the budget to the owner of
--     the link means one owner's links can only ever spend the budget for that
--     owner's links. It still stops the flooding it was written for: an
--     attacker with a hundred links in ONE account still gets five sends an
--     hour to one victim, not a hundred.
--   (c) fifteen per address per hour across ALL owners — flood protection and
--     nothing more. Three owners' worth of budget, so it never binds an
--     honest reader (who is dealing with one or two senders at a time) and
--     still caps what any number of accounts can put in one inbox.
--   twenty per network address per hour — the ceiling that stops one machine
--     walking a list of addresses to find which ones a link permits. It is
--     generous because a whole office behind one address shares it, and an
--     office of twenty people all opening one deck in an hour must not be
--     locked out. Unlike the three above it counts EVERY row, including the
--     ones a non-permitted request leaves behind.
--
--   (a) A NON-PERMITTED REQUEST SPENDS NO ADDRESS BUDGET. `p_permitted` is
--     false when the worker has already decided the address is not on the
--     link's list. Such a request is still recorded — the per-network ceiling
--     has to count it, or an address-walker escapes the only limit aimed at
--     them — but the row is written with `counts_toward_address = false` and
--     the three address budgets step over it. Without this, an attacker who
--     knows nothing but a reader's address can burn that reader's allowance by
--     typing it into any link at all, and no mail is ever sent, so nobody sees
--     it happening.
--
-- RESIDUAL RISK, STATED PLAINLY RATHER THAN IMPLIED. Scoping the budget to the
-- owner does not end the attack, it prices it. An attacker holding SEVERAL
-- accounts still gets five sends an hour per account against one named reader,
-- up to the global ceiling of fifteen — so roughly three accounts buys an hour
-- in which that reader cannot receive a code on a fourth sender's link. What it
-- costs them is account creation, and it is bounded again by the twenty-per-
-- network ceiling, so it also costs them networks. What it buys them is DELAY:
-- no code is read, no document opens, and the reader is held up for at most an
-- hour. Closing it properly means bot-resistant admission — a Cloudflare
-- Turnstile challenge in front of the request-a-code form, so a budget is only
-- ever spent by something that passed a challenge. That is deliberately NOT
-- built now: it puts a second vendor on the recipient path, and on the critical
-- path of every reader, to answer an attack nobody has run against this
-- product. It can be added later without touching this function, since the
-- worker would simply stop calling it on a failed challenge. If this is ever
-- abused, that is the next step, and this paragraph is the reason it is the
-- next step and not this one.
--
-- ATOMIC, and that word earns its place. The counting and the insert are
-- serialised by transaction-scoped advisory locks, which is the pattern 054
-- uses for the notification decision. Without them two requests arriving
-- together both count two, both find it under three, and both insert: the limit
-- of three becomes a limit of four, and with enough parallelism it becomes no
-- limit at all.
--
-- TWO LOCKS, AND THE ORDER THEY ARE TAKEN IN. Locking the address alone was
-- finding 7: two requests for DIFFERENT addresses from the same network take
-- different locks, never meet, and both read a network count neither has
-- written to — so the per-network ceiling could be walked straight through by
-- running requests in parallel. Both buckets are now locked: the address and,
-- when there is one, the network.
--
-- Taking two locks is how deadlocks are made. Request A holds the address lock
-- and wants the network lock; request B holds the network lock and wants the
-- address lock; neither can proceed and Postgres kills one of them. The fix is
-- a TOTAL ORDER that every request obeys: both keys are bigints, so they are
-- already totally ordered, and every request takes the SMALLER key first and
-- the larger second. Two requests that want the same pair of locks therefore
-- queue for the same one first, and whoever loses that race waits before it
-- holds anything the winner could want — so there is no cycle to deadlock on.
-- The ordering is the proof; it does not depend on which bucket is which, on
-- how many requests are in flight, or on the locks being taken for the same
-- reason.
--
-- ONE LIVE CODE PER BROWSER. Issuing expires whatever was live for the same
-- (share, address, browser) first, so a reader who presses "send another"
-- never has two codes that both work and never has to guess which of the two
-- messages in their inbox is the live one. The cost is the reader who asks for
-- a second code and then types the first one: they are told the code is not
-- right and asked again, which is what every product that does this does.
--
-- IT IS NOT A DEFENCE, AND SAYING SO IS THE POINT. An attacker controls their
-- own browser and can present a fresh challenge every time, so they can hold
-- three live codes for one address and have fifteen guesses in the air rather
-- than five. What bounds them is the pair of limits above and nothing else:
-- five codes per address per hour is twenty-five guesses an hour against a
-- million possibilities, which is one chance in forty thousand per hour of
-- trying — and every one of those codes also lands in the victim's inbox,
-- where it is visible. The arithmetic is the defence; this is tidiness.
--
-- WHAT IT DOES NOT DO: decide whether the address is allowed. That is the
-- worker's job, and it is why this function is called for a permitted and a
-- non-permitted address alike — identical work, identical timing, and the
-- worker alone decides whether an e-mail follows (decision 2 and item C).
-- `p_permitted` is that decision arriving as a fact to be RECORDED, not as a
-- second opinion to be acted on: nothing below branches on it except the value
-- written into `counts_toward_address`, so the two cases still do the same work
-- and take the same time.
--
-- THE SIGNATURE IS APPEND-ONLY. `p_permitted` is the sixth argument and
-- defaults to true, so every existing caller — and the worker build that
-- predates it — keeps the behaviour it has today.
-- ------------------------------------------------------------
-- Append-only to the CALLER, but not a second overload in the catalogue: an
-- earlier 055 left a five-argument version behind, and two overloads that both
-- accept the old named arguments make the PostgREST call ambiguous. Same
-- reasoning, and the same one-line answer, as section 8.
drop function if exists public.issue_email_verification_code(uuid, text, text, text, text);

create or replace function public.issue_email_verification_code(
  p_share_id  uuid,
  p_email     text,
  p_code_hash text,
  p_challenge text,
  p_ip_hash   text default null,
  p_permitted boolean default true
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(trim(p_email));
  v_share    document_shares%rowtype;
  v_n        int;
  v_counts   boolean := coalesce(p_permitted, true);
  v_addr_key bigint;
  v_net_key  bigint;
begin
  select * into v_share from document_shares where id = p_share_id;
  if not found then
    return 'no_share';
  end if;
  -- Refusing here as well as in the worker is not a second opinion that can
  -- disagree; it is the same rule, and it means a code cannot be minted for a
  -- link that does not ask for one even if some future caller forgets.
  if not v_share.verify_email or not v_share.require_email then
    return 'not_enabled';
  end if;
  if v_share.revoked_at is not null
     or (v_share.expires_at is not null and v_share.expires_at < now()) then
    return 'no_share';
  end if;

  -- Everything from here to the insert is one decision, and this is what makes
  -- it one. Transaction-scoped: released at commit or rollback, so a failure
  -- cannot strand it.
  --
  -- ASCENDING BY KEY, ALWAYS. See the header: the smaller bigint first and the
  -- larger second is what makes a deadlock impossible between two requests that
  -- want the same pair of buckets. `least`/`greatest` is the whole of the
  -- ordering — there is no branch on which bucket is which, because a branch is
  -- where an inconsistent order would creep back in. When the two keys collide
  -- the second call is a no-op on a lock this transaction already holds.
  v_addr_key := hashtextextended('hr_verify_code|' || v_email, 0);
  if p_ip_hash is null then
    perform pg_advisory_xact_lock(v_addr_key);
  else
    v_net_key := hashtextextended('hr_verify_net|' || p_ip_hash, 0);
    perform pg_advisory_xact_lock(least(v_addr_key, v_net_key));
    perform pg_advisory_xact_lock(greatest(v_addr_key, v_net_key));
  end if;

  -- (d) Three per address per link per fifteen minutes.
  select count(*) into v_n
    from email_verification_codes
   where share_id = p_share_id and email = v_email
     and counts_toward_address
     and created_at > now() - interval '15 minutes';
  if v_n >= 3 then return 'rate_limited'; end if;

  -- (b) Five per address per hour, PER LINK OWNER.
  select count(*) into v_n
    from email_verification_codes
   where email = v_email
     and owner_id = v_share.owner_id
     and counts_toward_address
     and created_at > now() - interval '1 hour';
  if v_n >= 5 then return 'rate_limited'; end if;

  -- (c) Fifteen per address per hour across every owner. Flood protection only.
  select count(*) into v_n
    from email_verification_codes
   where email = v_email
     and counts_toward_address
     and created_at > now() - interval '1 hour';
  if v_n >= 15 then return 'rate_limited'; end if;

  -- The per-network ceiling counts EVERY row, permitted or not.
  if p_ip_hash is not null then
    select count(*) into v_n
      from email_verification_codes
     where ip_hash = p_ip_hash
       and created_at > now() - interval '1 hour';
    if v_n >= 20 then return 'rate_limited'; end if;
  end if;

  -- The previous live code for this browser stops being live.
  update email_verification_codes
     set expires_at = now()
   where share_id = p_share_id and email = v_email and challenge = p_challenge
     and used_at is null and expires_at > now();

  insert into email_verification_codes (
    share_id, email, code_hash, challenge, ip_hash,
    owner_id, counts_toward_address, expires_at
  )
  values (
    p_share_id, v_email, p_code_hash, p_challenge, p_ip_hash,
    v_share.owner_id, v_counts, now() + interval '10 minutes'
  );

  return 'ok';
end;
$$;

comment on function public.issue_email_verification_code(uuid, text, text, text, text, boolean) is
  'Records one verification code for the verified e-mail gate, enforcing three codes per address per link per fifteen minutes, five per address per hour per LINK OWNER, fifteen per address per hour across all owners, and twenty per network address per hour. p_permitted false records the request for the per-network ceiling without letting it spend any of the address''s budgets, so an attacker cannot lock a named reader out by typing their address into an unrelated link. Every over-limit outcome returns the same word, rate_limited; the others are ok, not_enabled and no_share. Never decides whether the address is allowed — the worker does that, and calls this either way so the timing is the same.';

revoke all on function public.issue_email_verification_code(uuid, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_email_verification_code(uuid, text, text, text, text, boolean)
  to service_role;

-- ------------------------------------------------------------
-- 5b. Checking a code.
--
-- ATOMIC ATTEMPT COUNTING, and why it is one statement. The selector picks the
-- newest live code for this (link, address, browser) FOR UPDATE, so a second
-- request for the same row waits for this one to commit rather than reading a
-- count that is about to change. The same statement increments `attempts` and,
-- when the hash matches, stamps `used_at`. There is no moment at which a row
-- has been read but not yet counted, so parallel guesses cannot each spend the
-- same attempt.
--
-- SINGLE USE: `used_at is null` in the selector, and the stamp in the same
-- statement. The second arrival of a correct code finds no live row.
--
-- FIVE ATTEMPTS BURN IT: `attempts < 5` in the selector. The fifth wrong guess
-- leaves attempts at five and the sixth request matches nothing — the code is
-- dead even though it has not expired and has not been used.
--
-- EVERY REFUSAL IS THE SAME REFUSAL. Used, expired, burnt, wrong code, a code
-- for another link, a code for another address, a code from another browser
-- and no code at all are one return value, `bad`, because the worker must show
-- one screen for all of them (item B). There is no branch here that a caller
-- could use to tell them apart.
--
-- AND THEY COST THE SAME. When the selector finds nothing, the function still
-- runs ct_eq once, against a fixed impossible hash. Without that, "no such
-- code" would return measurably faster than "wrong code", which is the timing
-- distinction item C forbids.
-- ------------------------------------------------------------
create or replace function public.check_email_verification_code(
  p_share_id  uuid,
  p_email     text,
  p_code_hash text,
  p_challenge text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := lower(trim(p_email));
  v_id      uuid;
  v_stored  text;
  v_match   boolean;
begin
  -- SERIALISED PER (LINK, ADDRESS), the same way issuing is.
  --
  -- The `for update` below is already enough on its own: a second guess blocks
  -- on the row, and when it is granted Postgres re-evaluates the WHERE against
  -- the committed row, so a spent attempt or a spent code is seen rather than
  -- raced. This lock is here because "already enough on its own" is an argument
  -- and not a test. A transaction-scoped advisory lock can be ASSERTED — see
  -- case M of the test file — and item A of the brief asks for proof that the
  -- attempt counter cannot be bypassed by parallel requests, not for an
  -- argument that it cannot.
  --
  -- It costs nothing a guesser should have. Two simultaneous guesses at one
  -- address now take their turns, which is exactly the behaviour being paid
  -- for; two readers of DIFFERENT addresses never meet, because the address is
  -- in the key.
  perform pg_advisory_xact_lock(
    hashtextextended('hr_verify_check|' || p_share_id::text || '|' || v_email, 0)
  );

  select id, code_hash into v_id, v_stored
    from email_verification_codes
   where share_id = p_share_id
     and email = v_email
     and challenge = p_challenge
     and used_at is null
     and expires_at > now()
     and attempts < 5
   order by created_at desc
   limit 1
     for update;

  if v_id is null then
    -- The same work, so the same time. Sixty-four zeroes is a hash the worker
    -- cannot produce, so this can never accidentally succeed.
    perform ct_eq(repeat('0', 64), p_code_hash);
    return 'bad';
  end if;

  v_match := ct_eq(v_stored, p_code_hash);

  update email_verification_codes
     set attempts = attempts + 1,
         used_at  = case when v_match then now() else used_at end
   where id = v_id;

  if not v_match then
    return 'bad';
  end if;

  insert into share_email_verifications (share_id, email)
  values (p_share_id, v_email)
  on conflict (share_id, email)
  do update set last_verified_at = now();

  return 'ok';
end;
$$;

comment on function public.check_email_verification_code(uuid, text, text, text) is
  'Spends one attempt against the live verification code for (link, address, browser) and returns ok or bad. Single use, five attempts, ten minutes; every way of being wrong returns the same word, and the no-such-code path does the same comparison work so it takes the same time. On success records the address in share_email_verifications.';

revoke all on function public.check_email_verification_code(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.check_email_verification_code(uuid, text, text, text)
  to service_role;

-- ------------------------------------------------------------
-- 6. The sweep, carried by a job that already runs.
--
-- `purge_connect_handles` has run every five minutes since 045 and is exactly
-- the right shape: a SECURITY DEFINER function of plain deletes, scheduled
-- once. Adding a second delete to it costs nothing and needs no new pg_cron
-- entry, no new grant and no change to the schedule — which matters on a
-- project where pg_cron is optional (see schema/README.md) and a new job would
-- be a new thing to set up on every self-hosted install.
--
-- The name now says less than the function does. Renaming it would mean
-- altering the cron job's command as well, so the comment carries the truth
-- instead: cheaper, and it cannot half-apply.
--
-- AN HOUR, NOT TEN MINUTES. An expired code is useless as a code after ten
-- minutes but is still a fact the hourly limits count, so deleting on expiry
-- would hand an attacker a fresh budget every ten minutes.
-- ------------------------------------------------------------
create or replace function public.purge_connect_handles()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.connect_handles where expires_at < now();
  delete from public.email_verification_codes where created_at < now() - interval '1 hour';
$$;

comment on function public.purge_connect_handles() is
  'Sweeps two short-lived tables: expired connect_handles rows, so an unexchanged handle does not keep its plaintext api_key around (045); and email_verification_codes older than an hour, which is past both the ten-minute code life and the sixty-minute rate-limit window (055). Scheduled every 5 minutes via pg_cron; also callable by hand as service_role.';

revoke all on function public.purge_connect_handles() from public, anon, authenticated;
grant execute on function public.purge_connect_handles() to service_role;

-- ------------------------------------------------------------
-- 7. share_lookup learns the flag — and learns to REFUSE a worker that does
--    not enforce it. This is finding 3a of the review.
--
-- The worker decides whether to ask for a code before it serves a single byte,
-- so the flag has to arrive on the one read a recipient request makes. Adding
-- a column to the view would have been enough IF every worker that reads the
-- view could be relied on to look at it. The review's point is that it cannot:
-- the application reaches production before the worker, and a rollback puts a
-- build that never heard of `verify_email` back in front of links that now
-- have it set. That build reads the view, sees a share, and opens it on a
-- typed address. Nothing in the database stops it.
--
-- So the read is split in three, and the split is the enforcement:
--
--   `share_lookup_all` — the full body, everything the proxy reads, including
--     verified links. Granted to NOBODY. It is a private base that the two
--     doors below are built on, so there is no way to reach a verified row
--     except through a door that knows what one is.
--
--   `share_lookup` — that view filtered to `where not verify_email`, keeping
--     the name, the columns and the grant the old worker already uses. A
--     verified link is not in it. An old worker selecting by slug finds no
--     row and answers exactly what it answers for a slug that does not exist:
--     its standard not-found page. Wrong deploy order, failed deploy and
--     rollback all end in a closed link rather than an open one, which is what
--     "fail closed" means and is the whole point of doing this in the database
--     rather than in a deployment runbook.
--
--   `share_lookup_for(slug, supports_verification)` — the new worker's door.
--     It returns the row for the slug, and returns a VERIFIED row only when
--     the caller passes true, which is the caller stating that it enforces
--     verification. The new worker passes true. A caller that forgets gets the
--     same closed link as the old worker.
--
-- WHY A BOOLEAN THE CALLER SETS, rather than trusting whoever holds the
-- service key. Because the service key is the same key before and after the
-- deploy; it cannot distinguish the two builds. The argument can, and it is the
-- cheapest honest signal available: a build that passes `true` is a build whose
-- source was changed to pass it.
--
-- The views are rebuilt rather than altered because a view's column list cannot
-- be changed in place; the body below is 052's with one line added, and the
-- grants are re-stated for the same reason.
-- ------------------------------------------------------------
-- In dependency order, innermost last: the function returns `setof
-- share_lookup_all`, and `share_lookup` selects from it, so both have to go
-- before it can be rebuilt.
drop function if exists public.share_lookup_for(text, boolean);
drop view if exists public.share_lookup;
drop view if exists public.share_lookup_all;

create view public.share_lookup_all with (security_invoker = off) as
select
  s.id,
  s.slug,
  s.document_id,
  s.owner_id,
  s.recipient_label,
  s.require_email,
  s.require_password,
  s.verify_email,
  s.allowed_email_domains,
  s.allowed_emails,
  s.lock_deck,
  s.expires_at,
  s.revoked_at,
  s.host_handle,
  s.custom_domain_id,
  cd.hostname             as custom_domain_hostname,
  cd.state                as custom_domain_state,
  cd.owner_id             as custom_domain_owner_id,
  p.handle                as owner_handle,
  p.tier                  as owner_tier,
  p.display_name          as owner_display_name,
  p.email                 as owner_email,
  d.title                 as document_title,
  d.source_type           as document_source_type,
  d.source_url            as document_source_url,
  d.current_version       as document_current_version,
  d.r2_key                as document_r2_key,
  d.deleted_at            as document_deleted_at
from document_shares s
join documents d on d.id = s.document_id
left join profiles p on p.id = s.owner_id
left join custom_domains cd on cd.id = s.custom_domain_id;

comment on view public.share_lookup_all is
  'Everything the proxy needs to answer one recipient request: the share, its gates including verify_email, its stored hostname (handle or custom domain), that domain''s current hostname, state and owner, the owner''s handle, tier and display name, and the document''s title, storage key and version. GRANTED TO NOBODY, deliberately: it is the private base of share_lookup (unverified links only) and share_lookup_for (the new worker''s door). A verified link must not be reachable by a caller that has not said it enforces verification.';

revoke all on public.share_lookup_all from public, anon, authenticated, service_role;

-- The old worker's door. Same name, same columns, same grant — and no verified
-- link in it.
create view public.share_lookup with (security_invoker = off) as
select * from public.share_lookup_all where not verify_email;

comment on view public.share_lookup is
  'The unverified subset of share_lookup_all: everything the proxy needs to answer one recipient request for a link that does NOT require e-mail verification. A link with verify_email set is absent, so a worker build that does not enforce verification finds no row and answers its ordinary not-found page instead of opening the document — the database failing closed rather than trusting the deploy order (055, review finding 3a). A worker that DOES enforce verification reads through share_lookup_for instead. Service role only — it exposes every customer''s handle, domain, address and document storage key.';

revoke all on public.share_lookup from public, anon, authenticated;
grant select on public.share_lookup to service_role;

-- The new worker's door. `p_supports_verification` is the caller saying, in the
-- only way the database can hear it, that it will ask for a code.
create or replace function public.share_lookup_for(
  p_slug                  text,
  p_supports_verification boolean default false
)
returns setof public.share_lookup_all
language sql
stable
security definer
set search_path = ''
as $$
  select *
    from public.share_lookup_all
   where slug = p_slug
     and (coalesce(p_supports_verification, false) or not verify_email);
$$;

comment on function public.share_lookup_for(text, boolean) is
  'The proxy''s one read for a recipient request, by slug. Returns a link that requires e-mail verification only when the caller passes p_supports_verification true, which is the caller stating that it enforces the code; otherwise that link is absent exactly as it is from share_lookup. Service role only.';

revoke all on function public.share_lookup_for(text, boolean) from public, anon, authenticated;
grant execute on function public.share_lookup_for(text, boolean) to service_role;

-- ------------------------------------------------------------
-- 8. The write paths accept the flag.
--
-- Three functions, each recreated with ONE extra trailing argument defaulting
-- to false. The bodies are otherwise byte-for-byte what 052 and 008 left
-- behind; the diff in each is the argument, one column in the insert or update
-- and, in create_share_as, one more value passed through.
--
-- THE OLD SIGNATURE IS DROPPED, not left beside the new one. Two overloads
-- that both accept the old named arguments make the PostgREST call ambiguous
-- and it starts failing with "could not choose the best candidate function" —
-- 033's reason, and 052 repeated it, and it is repeated here.
--
-- THE DEFAULT IS FALSE, so every existing caller — the website's own action,
-- the API, the connector, a self-hoster's script — keeps working unchanged and
-- creates exactly the link it creates today.
-- ------------------------------------------------------------
drop function if exists public.create_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean);

create or replace function public.create_share(
  p_document_id           uuid,
  p_recipient_label       text,
  p_require_email         boolean,
  p_require_password      boolean,
  p_password_plain        text,
  p_allowed_email_domains text[],
  p_allowed_emails        text[],
  p_expires_at            timestamptz,
  p_slug                  text default null,
  p_custom_domain_id      uuid default null,
  p_use_htmlradar_address boolean default false,
  p_verify_email          boolean default false
)
returns document_shares
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user_id    uuid := auth.uid();
  v_doc        documents%rowtype;
  v_slug       text;
  v_hash       text;
  v_domain_id  uuid;
  v_share      document_shares%rowtype;
  v_adjectives text[] := array['swift','silent','bright','golden','crisp','steady','quick','noble','vivid','calm'];
  v_nouns      text[] := array['falcon','river','meadow','signal','beacon','compass','glass','harbor','prism','ember'];
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = 'P0020';
  end if;

  select * into v_doc from documents where id = p_document_id and owner_id = v_user_id and deleted_at is null;
  if not found then
    raise exception 'document_not_found' using errcode = 'P0021';
  end if;

  -- 055: verification without the gate is a link that reads as restricted and
  -- is not. Named, with its own SQLSTATE, so the API and the connector can
  -- turn it into a sentence rather than showing a constraint violation.
  if coalesce(p_verify_email, false) and not coalesce(p_require_email, true) then
    raise exception 'verify_requires_email' using errcode = 'P0055';
  end if;

  v_slug := nullif(lower(trim(coalesce(p_slug, ''))), '');

  if v_slug is null then
    loop
      v_slug := v_adjectives[1 + floor(random() * array_length(v_adjectives, 1))::int]
             || '-' || v_nouns[1 + floor(random() * array_length(v_nouns, 1))::int]
             || '-' || encode(gen_random_bytes(3), 'hex');
      exit when not exists (select 1 from document_shares where slug = v_slug);
    end loop;
    -- Tell the validation trigger this exact slug came from us, so it marks
    -- the row generated and skips the Pro check. Transaction-local: gone at
    -- commit.
    perform set_config('app.generated_slug', v_slug, true);
  end if;

  -- Which host this link is born on. Decided here, written in the insert
  -- below, frozen by trg_validate_share_host from that moment.
  if not coalesce(p_use_htmlradar_address, false) then
    v_domain_id := coalesce(
      p_custom_domain_id,
      (select default_custom_domain_id from profiles where id = v_user_id)
    );

    -- A default that is no longer serving REFUSES, and says so. See 052 for
    -- why a silent fallback to htmlradar.page is the wrong kindness.
    if p_custom_domain_id is null and v_domain_id is not null
       and not exists (
         select 1 from custom_domains
          where id = v_domain_id and owner_id = v_user_id and state = 'live'
       ) then
      raise exception 'share_custom_domain_not_live'
        using errcode = 'P0053',
              hint = 'Your domain is not serving at the moment, so this link cannot be created on it. Reconnect it in Settings, or create this link on the HTMLRadar address.';
    end if;
  end if;

  if p_require_password then
    if p_password_plain is null or length(p_password_plain) < 8 then
      raise exception 'password_too_short' using errcode = 'P0022';
    end if;
    v_hash := crypt(p_password_plain, gen_salt('bf', 10));
  end if;

  insert into document_shares (
    document_id, owner_id, slug, recipient_label,
    require_email, require_password, password_hash,
    allowed_email_domains, allowed_emails, expires_at,
    custom_domain_id, verify_email
  )
  values (
    p_document_id, v_user_id, v_slug, p_recipient_label,
    coalesce(p_require_email, true), coalesce(p_require_password, false), v_hash,
    p_allowed_email_domains, p_allowed_emails, p_expires_at,
    v_domain_id, coalesce(p_verify_email, false)
  )
  returning * into v_share;

  return v_share;
end;
$$;

revoke all on function public.create_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean, boolean) from public, anon;
grant execute on function public.create_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean, boolean) to authenticated;

drop function if exists public.create_share_as(uuid, uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean);

create or replace function public.create_share_as(
  p_user_id               uuid,
  p_document_id           uuid,
  p_recipient_label       text,
  p_require_email         boolean,
  p_require_password      boolean,
  p_password_plain        text,
  p_allowed_email_domains text[],
  p_allowed_emails        text[],
  p_expires_at            timestamptz,
  p_slug                  text default null,
  p_custom_domain_id      uuid default null,
  p_use_htmlradar_address boolean default false,
  p_verify_email          boolean default false
)
returns public.document_shares
language plpgsql security definer set search_path = '' as $$
declare
  v_share       public.document_shares%rowtype;
  v_prev_sub    text := coalesce(pg_catalog.current_setting('request.jwt.claim.sub', true), '');
  v_prev_claims text := coalesce(pg_catalog.current_setting('request.jwt.claims', true), '');
begin
  if p_user_id is null then
    raise exception 'not_authenticated' using errcode = 'P0020';
  end if;

  -- Both forms auth.uid() understands, transaction-local.
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );

  v_share := public.create_share(
    p_document_id,
    p_recipient_label,
    p_require_email,
    p_require_password,
    p_password_plain,
    p_allowed_email_domains,
    p_allowed_emails,
    p_expires_at,
    p_slug,
    p_custom_domain_id,
    p_use_htmlradar_address,
    p_verify_email
  );

  -- Put the connection back as we found it. On an exception the transaction
  -- aborts and the local settings are rolled back anyway, so this only
  -- matters on the success path.
  perform pg_catalog.set_config('request.jwt.claim.sub', v_prev_sub, true);
  perform pg_catalog.set_config('request.jwt.claims', v_prev_claims, true);

  return v_share;
end;
$$;

-- The whole security argument for this function is this grant. A customer who
-- could execute it could pass any p_user_id and create links in anyone's
-- account.
revoke all on function public.create_share_as(uuid, uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.create_share_as(uuid, uuid, text, boolean, boolean, text, text[], text[], timestamptz, text, uuid, boolean, boolean)
  to service_role;

-- update_share (007, widened by 008). Same shape: one trailing argument.
--
-- `coalesce(p_verify_email, verify_email)` rather than a bare assignment, to
-- match how this function already treats `require_email`: a caller that does
-- not name the field leaves it as it was. Turning the e-mail gate OFF turns
-- verification off with it, because the constraint in section 1 would
-- otherwise refuse the update and the customer would see a database error
-- where they expected a switch to move.
drop function if exists public.update_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz);

create or replace function public.update_share(
  p_share_id              uuid,
  p_recipient_label       text,
  p_require_email         boolean,
  p_require_password      boolean,
  p_password_plain        text,
  p_allowed_email_domains text[],
  p_allowed_emails        text[],
  p_expires_at            timestamptz,
  p_verify_email          boolean default null
)
returns document_shares
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user_id uuid := auth.uid();
  v_share   document_shares%rowtype;
  v_hash    text;
  v_email   boolean;
  v_verify  boolean;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = 'P0020';
  end if;

  select * into v_share from document_shares
   where id = p_share_id and owner_id = v_user_id;
  if not found then
    raise exception 'share_not_found' using errcode = 'P0024';
  end if;

  if coalesce(p_require_password, false) then
    if p_password_plain is not null and length(p_password_plain) > 0 then
      if length(p_password_plain) < 8 then
        raise exception 'password_too_short' using errcode = 'P0022';
      end if;
      v_hash := crypt(p_password_plain, gen_salt('bf', 10));
    else
      v_hash := v_share.password_hash;
    end if;
  else
    v_hash := null;
  end if;

  v_email  := coalesce(p_require_email, v_share.require_email);
  v_verify := coalesce(p_verify_email, v_share.verify_email);
  -- Switching the gate off switches verification off with it, rather than
  -- refusing the edit.
  if not v_email then v_verify := false; end if;

  update document_shares
     set recipient_label       = p_recipient_label,
         require_email         = v_email,
         require_password      = coalesce(p_require_password, false),
         password_hash         = v_hash,
         allowed_email_domains = p_allowed_email_domains,
         allowed_emails        = p_allowed_emails,
         expires_at            = p_expires_at,
         verify_email          = v_verify
   where id = p_share_id
  returning * into v_share;

  return v_share;
end;
$$;

revoke all on function public.update_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz, boolean) from public, anon;
grant execute on function public.update_share(uuid, text, boolean, boolean, text, text[], text[], timestamptz, boolean) to authenticated;

commit;
