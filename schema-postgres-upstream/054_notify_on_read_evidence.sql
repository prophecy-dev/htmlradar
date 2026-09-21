-- 054_notify_on_read_evidence.sql
-- ------------------------------------------------------------
-- The "someone opened your document" email waits for evidence that somebody
-- read something.
--
-- WHAT WAS WRONG. `trg_notify_on_first_open` fired AFTER INSERT on sessions,
-- so the email went out the instant a session row appeared — before the
-- tracker had reported a single second of reading, a single pixel of scroll or
-- anything else. A session row means only that a browser ran our script, was
-- still there five seconds later and did not report itself hidden. A corporate
-- mail scanner that renders links (Microsoft Safe Links and its equivalents)
-- clears that bar. Measured on production on 21 September 2026, excluding our
-- own accounts: of 63 recipient sessions since 1 September, 8 recorded zero
-- reading time AND zero scroll AND never sent the tracker's first report at
-- all, and 6 of those 8 sent the sender an email.
--
-- WHAT THIS CHANGES. The same function, unchanged, now runs on the first
-- tracker report that carries evidence instead of on the insert. The trigger
-- becomes AFTER UPDATE of the two columns `update_session` writes, with a
-- WHEN clause that fires on the transition from "nothing recorded" to
-- "something recorded" and therefore at most once per session.
--
-- WHAT COUNTS AS EVIDENCE, and why it is these two columns and not one. The
-- obvious rule is non-zero active reading time alone. It is wrong here,
-- because the tracker's session-level idle watchdog listens to keydown,
-- touchstart and scroll while its section-level watchdog also listens to
-- mousedown and wheel, so a reader working a mouse accrues section dwell but
-- no active time. Two sessions on production prove it: one held a document
-- open for 250 seconds with a full scroll and 19.8 seconds of qualified
-- section dwell, and another for nearly two hours, and BOTH recorded
-- active_time_seconds = 0. Gating on reading time alone would have told
-- neither sender their document had been read. Scroll is the second half, and
-- together the pair covers every session on production that looks like a
-- human while excluding every one of the 8 that recorded nothing.
--
-- TIMING. The tracker creates the session five seconds after load and sends
-- its first report one heartbeat later, fifteen seconds after that, so a
-- genuine read still notifies about twenty seconds in.
--
-- WHAT ELSE HAD TO CHANGE, and it is the one thing moving the trigger is not
-- safe without. 049's dedup treats ANY other session for the same reader on
-- the same document as proof the sender was already told. On an INSERT trigger
-- that held; on an evidence trigger it does not, and it silences real reads —
-- see the long note above the function below. The dedup now matches only
-- sessions that actually notified, and the decision is serialised per
-- (document, reader) with a transaction-scoped advisory lock.
--
-- WHAT IS DELIBERATELY UNTOUCHED. The internal-viewer guard, the per-share
-- `notify_first_open` switch, the Vault check, the `share.first_view` event
-- and the email body are all what they were in 049. The read report keeps
-- showing every session including the empty ones, because it reads the
-- `sessions` table and nothing here writes to it. The disabled-link notice
-- (028) is a different function on a different path and is not touched.
--
-- KNOWN LIMIT. A document that fits entirely in one window has its
-- max_scroll_depth set to 1 by the tracker with no reader action at all, so on
-- such a document the evidence reduces to "the tracker sent a report", which a
-- machine that stays twenty seconds would also produce. Every empty session
-- measured on production sent no report at all, so this costs nothing today.
--
-- ------------------------------------------------------------
-- APPLY. Paste the WHOLE file into the Supabase SQL editor and run once, or
-- `psql -f` it. It carries its own BEGIN and COMMIT, so it applies as one
-- transaction and there is never a moment with no trigger on `sessions`.
-- Idempotent: `create or replace` on the function, a guarded drop and a
-- create on the trigger, so re-running leaves exactly the same pair behind.
--
-- ORDER RELATIVE TO THE WORKER DEPLOY. This file and the proxy/tracker deploy
-- that restores returning-reader identity are independent, and there is no
-- ordering that produces a double or a missing email:
--
--   * The drop and the create are one transaction, so at every instant
--     exactly one trigger governs `sessions`. No session can be seen by both.
--   * A session inserted before this runs that already emailed carries
--     `notification_sent_at`, which the WHEN clause below excludes, so its
--     later reports send nothing a second time.
--   * A session inserted before this runs that was deliberately skipped (a
--     repeat open, an internal viewer, a share with the switch off) re-enters
--     the same function on its first evidence report, fails the same check
--     and is skipped again — one extra `skipped` row in notifications_log and
--     no email.
--   * A session inserted after this runs is governed only by the new rule.
--
-- RECOMMENDED ORDER ANYWAY: apply this FIRST, then deploy the worker. This
-- file alone stops the empty-session emails immediately; the worker deploy
-- alone would still leave them being sent.
--
-- THE ONE EDGE WORTH KNOWING. A session inserted before this runs whose email
-- was skipped because the Vault secrets were briefly missing will retry on its
-- first evidence report and may send then. That is one email where none was
-- sent, never a duplicate.
--
-- CONFIRM, after applying:
--   select pg_get_triggerdef(t.oid) from pg_trigger t
--     join pg_class c on c.oid = t.tgrelid
--    where c.relname = 'sessions' and t.tgname = 'trg_notify_on_first_open';
--   -- must read AFTER UPDATE OF active_time_seconds, max_scroll_depth
-- ------------------------------------------------------------

-- ONE TRANSACTION. Between a bare DROP and a bare CREATE there is a window
-- with no trigger on the table at all, and a first evidence report landing in
-- it would permanently miss its notification — permanently, because the WHEN
-- clause fires on a transition that happens once. A failed CREATE would leave
-- that window open for good. DDL is transactional in Postgres, so BEGIN and
-- COMMIT close both cases: either the new function and trigger are both there
-- or the old trigger never left.
begin;

-- ------------------------------------------------------------
-- 1. The function, which is 049's body with ONE change, marked "054" below.
--
-- WHAT CHANGED IN 049's LOGIC, AND WHY. 049 treats ANY other session for the
-- same recipient on the same document as proof that the sender has already
-- been told, and skips. That was true when the trigger ran on INSERT, because
-- a session row only existed after an email had been considered for it. It is
-- false now that the trigger waits for evidence, and it turns the fix into a
-- worse bug: open a document briefly, close it before the tracker reports,
-- come back later and read properly, and the second session finds the first
-- and stays silent. Nobody is ever told. Two sessions opened before either
-- reports silence each other the same way.
--
-- So the dedup now matches only sessions that ACTUALLY notified —
-- `notification_sent_at is not null`. A session that was never reported on
-- cannot suppress anything, because it never told anyone anything. This is
-- also closer to what the dedup always meant: "has this person already been
-- announced to this sender for this document?"
--
-- AND THE DECISION IS SERIALISED. Two evidence reports for one reader can land
-- at the same instant — two tabs, or a heartbeat racing a pagehide flush — and
-- both would read a table in which neither had yet written
-- `notification_sent_at`, so both would send. A transaction-scoped advisory
-- lock on (document, reader) makes the second wait for the first to commit and
-- then see its stamp. It is released at commit either way, so a failure cannot
-- strand it.
-- ------------------------------------------------------------

create or replace function notify_on_first_open()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_share document_shares%rowtype;
  v_viewer viewers%rowtype;
  v_doc documents%rowtype;
  v_owner profiles%rowtype;
  v_prior_session_id uuid;
  v_resend_key text;
  v_from text;
  v_payload jsonb;
  v_subject text;
  v_body text;
  v_request_id bigint;
  v_owner_first text;
  v_viewer_label text;
  v_avatar_letter text;
  v_referrer_label text;
  v_when_label text;
  v_dashboard_url text;
begin
  select * into v_share from document_shares where id = new.share_id;
  select * into v_viewer from viewers where id = new.viewer_id;
  select * into v_doc from documents where id = v_share.document_id;
  select * into v_owner from profiles where id = v_doc.owner_id;

  -- 049: a share can switch the first-open email off with
  -- config.notify_first_open = false. Added for the public demo share,
  -- where every anonymous open would otherwise email its owner.
  if coalesce(v_share.config->>'notify_first_open', 'true') = 'false' then
    insert into notifications_log (session_id, email_to, status, error_message)
    values (new.id, v_owner.email, 'skipped', 'first-open email disabled on this share');
    return new;
  end if;

  -- 054: serialise the whole decision per (document, reader). Taken BEFORE the
  -- dedup read, so a second concurrent report blocks here and, once through,
  -- sees the first one's committed stamp instead of racing it. The identity is
  -- the same one the dedup below matches on: the email when there is one, the
  -- fingerprint otherwise. `viewers` requires one or the other, so the
  -- coalesce never falls through to a per-session key by accident.
  perform pg_advisory_xact_lock(
    hashtextextended(
      v_doc.id::text || '|' ||
      coalesce(lower(v_viewer.email), v_viewer.fingerprint, new.viewer_id::text),
      0
    )
  );

  -- TRUE per-document first-open dedup. Match prior sessions across
  -- ALL shares of this document, identifying the recipient by email
  -- (case-insensitive) when one is present, else by fingerprint.
  -- When an email is on the new viewer, we ignore fingerprint-only
  -- prior sessions — the email IS the identity claim and using it
  -- avoids false matches from shared browsers.
  --
  -- 054: `s.notification_sent_at is not null` on both branches. Only a session
  -- that actually announced this reader may silence a later one.
  if v_viewer.email is not null then
    select s.id into v_prior_session_id
    from sessions s
    join viewers v on v.id = s.viewer_id
    join document_shares ds on ds.id = s.share_id
    where ds.document_id = v_doc.id
      and s.notification_sent_at is not null
      and v.email is not null
      and lower(v.email) = lower(v_viewer.email)
      and s.id <> new.id
    limit 1;
  else
    -- Anonymous viewer — match across shares of the same doc by
    -- fingerprint. Misses if the recipient cleared their cookies or
    -- switched browsers between shares; we accept that edge case.
    select s.id into v_prior_session_id
    from sessions s
    join viewers v on v.id = s.viewer_id
    join document_shares ds on ds.id = s.share_id
    where ds.document_id = v_doc.id
      and s.notification_sent_at is not null
      and v.fingerprint is not null
      and v_viewer.fingerprint is not null
      and v.fingerprint = v_viewer.fingerprint
      and s.id <> new.id
    limit 1;
  end if;

  -- share.first_view event fires on EVERY open that reaches here (analytics
  -- signal). is_repeat_open flag distinguishes downstream — used by any future
  -- repeat-open digest without changing this trigger. Since 054 it means "this
  -- reader has already been announced for this document", which is what the
  -- name always implied.
  insert into app_events (distinct_id, event, properties, user_id)
  values (
    v_owner.id::text,
    'share.first_view',
    jsonb_build_object(
      'slug', v_share.slug,
      'document_id', v_doc.id,
      'recipient_label', v_share.recipient_label,
      'viewer_country', v_viewer.country_code,
      'viewer_device', v_viewer.device_type,
      'has_email_gate', v_share.require_email,
      'has_password_gate', v_share.require_password,
      'viewer_is_internal', coalesce(v_viewer.is_internal, false),
      'is_repeat_open', v_prior_session_id is not null
    ),
    v_owner.id
  );

  -- Silent on repeat opens (per-document scope).
  if v_prior_session_id is not null then
    insert into notifications_log (session_id, email_to, status, error_message)
    values (new.id, v_owner.email, 'skipped', 'repeat open by same recipient on this document');
    return new;
  end if;

  -- Internal viewer guard (carried from 013).
  if coalesce(v_viewer.is_internal, false) then
    insert into notifications_log (session_id, email_to, status, error_message)
    values (new.id, v_owner.email, 'skipped', 'viewer marked internal');
    return new;
  end if;

  begin
    select decrypted_secret into v_resend_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
    select decrypted_secret into v_from
    from vault.decrypted_secrets where name = 'resend_from' limit 1;
  exception when others then
    v_resend_key := null;
    v_from := null;
  end;
  if v_resend_key is null or v_from is null then
    insert into notifications_log (session_id, email_to, status, error_message)
    values (new.id, v_owner.email, 'skipped', 'resend secrets not in Vault');
    return new;
  end if;

  v_owner_first := coalesce(
    nullif(split_part(coalesce(v_owner.display_name, ''), ' ', 1), ''),
    split_part(v_owner.email, '@', 1)
  );
  v_viewer_label := coalesce(v_viewer.email, 'An anonymous viewer');
  v_avatar_letter := upper(coalesce(nullif(substring(v_viewer.email from 1 for 1), ''), '?'));
  v_referrer_label := coalesce(
    nullif(regexp_replace(coalesce(v_viewer.referrer, ''), '^https?://([^/]+).*$', '\1'), ''),
    'Direct link'
  );

  -- Render the timestamp in the sender's timezone (from 020). The
  -- third arg `true` on set_config scopes the TZ to this transaction
  -- so we don't leak it to other queries.
  perform set_config('TimeZone', coalesce(v_owner.timezone, 'UTC'), true);
  v_when_label := to_char(now(), 'Mon DD, HH24:MI TZ');

  v_dashboard_url := 'https://htmlradar.com/dashboard/' || v_share.slug;
  v_subject := format('%s opened %s', v_viewer_label, v_doc.title);

  -- Body template carried from 025 unchanged.
  v_body := format($html$
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>%s</title>
</head>
<body style="margin:0;padding:0;background:#FBF1E8;font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,'Segoe UI',Roboto,sans-serif;color:#1F1108;-webkit-font-smoothing:antialiased;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%%" style="background:#FBF1E8;">
  <tr><td align="center" style="padding:48px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:#FBF1E8;">
      <tr><td style="padding:0 8px 28px 8px;">
        <span style="display:inline-block;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#5A1521;font-weight:600;">HTML<span style="color:#7A1F2E;font-style:italic;font-weight:500;">Radar</span></span>
      </td></tr>
      <tr><td style="padding:0 8px 12px 8px;">
        <p style="margin:0;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:#876959;">First open</p>
      </td></tr>
      <tr><td style="padding:0 8px 18px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="middle" style="padding-right:12px;">
              <div style="width:36px;height:36px;border-radius:9999px;background:#7A1F2E;color:#FBF1E8;display:inline-block;text-align:center;line-height:36px;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;font-size:15px;font-weight:600;">%s</div>
            </td>
            <td valign="middle">
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;font-size:15px;color:#1F1108;font-weight:600;line-height:1.3;">%s</p>
              <p style="margin:2px 0 0 0;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;letter-spacing:0.06em;color:#876959;">just opened &middot; %s</p>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 8px 28px 8px;">
        <p style="margin:0;font-family:'Newsreader',Georgia,serif;font-size:26px;line-height:1.2;color:#1F1108;font-weight:400;font-style:italic;letter-spacing:-0.01em;"><a href="%s" style="color:inherit;text-decoration:none;">&ldquo;%s&rdquo;</a></p>
      </td></tr>
      <tr><td style="padding:0 8px 12px 8px;">
        <a href="%s" style="display:inline-block;background:#7A1F2E;color:#FBF1E8;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;letter-spacing:0.01em;">See the read &rarr;</a>
      </td></tr>
      <tr><td style="padding:24px 8px 0 8px;border-top:1px solid #E8D5BD;">
        <p style="margin:0;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;color:#876959;letter-spacing:0.02em;">Referrer &middot; <a href="https://htmlradar.com" style="color:#5A1521;text-decoration:none;">%s</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
$html$,
    v_subject,
    v_avatar_letter,
    v_viewer_label,
    v_when_label,
    v_dashboard_url,
    v_doc.title,
    v_dashboard_url,
    v_referrer_label
  );

  v_payload := jsonb_build_object(
    'from', v_from,
    'to', array[v_owner.email],
    'subject', v_subject,
    'html', v_body
  );

  select net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_resend_key,
      'Content-Type', 'application/json'
    ),
    body := v_payload
  ) into v_request_id;

  insert into notifications_log (session_id, email_to, request_id, status)
  values (new.id, v_owner.email, v_request_id, 'queued');

  update sessions set notification_sent_at = now() where id = new.id;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 2. The trigger.
-- ------------------------------------------------------------

drop trigger if exists trg_notify_on_first_open on sessions;

create trigger trg_notify_on_first_open
  after update of active_time_seconds, max_scroll_depth on sessions
  for each row
  when (
    -- Nothing had been recorded before this report...
    old.active_time_seconds = 0
    and old.max_scroll_depth = 0
    -- ...and this report carries something. The pair is the transition, which
    -- is what makes this fire at most once per session however many heartbeats
    -- follow.
    and (new.active_time_seconds > 0 or new.max_scroll_depth > 0)
    -- Belt to that brace, and the thing that stops a session which already
    -- emailed under the old AFTER INSERT rule from emailing a second time
    -- across this migration.
    and new.notification_sent_at is null
  )
  execute function notify_on_first_open();

-- Why the function's own `update sessions set notification_sent_at = now()`
-- does not re-enter this trigger: that statement does not name either column
-- in the UPDATE OF list above, so the trigger is never considered for it. The
-- WHEN clause would refuse it in any case, because by then the old values are
-- no longer both zero.

commit;
