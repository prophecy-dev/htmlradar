# The golden journeys

These are browser scripts that behave like real people using HTMLRadar, and
then check what the product actually **recorded** — not only what appeared on
the screen. They exist because the design overhaul is about to change a lot of
screens, and the promise attached to it is zero regression. Fourteen hundred
unit tests prove that functions behave; none of them proves that a person can
still sign in, share a deck and see who read it.

Read this page before you run them. Everything here touches real data.

## What each journey does

| Journey | The person, and what has to be true afterwards                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **J1**  | A sender signs in through the real e-mail link — the confirm page, the button — uploads a deck, makes a link with the e-mail gate on, copies it and lands on the link's page. The clipboard really holds the link.                                                                                                       |
| **J2**  | A recipient, in a browser that has never seen this site, opens the link, gives an e-mail and reads all three sections with a real pause on each.                                                                                                                                                                         |
| **J2b** | The sender opens their own preview of the link. This is setup for the last assertion in J3.                                                                                                                                                                                                                              |
| **J3**  | The sender's report shows exactly one reader, with that address, a believable reading time and the three sections. The database agrees. Exactly one "opened" notification was queued, it went to the sender, and the sender's own preview queued nothing.                                                                |
| **J4a** | The same reader comes back. The product records one reader with two sessions, and does not mail the sender a second time.                                                                                                                                                                                                |
| **J4b** | The same thing for an anonymous reader, on a link with no gate. Also checks that the recipient's host serves the same tracker build as `htmlradar.page`, because the recognition depends on it.                                                                                                                          |
| **J4c** | Someone opens the link and leaves without reading. The sender is not mailed. Passes: the product already gets this right.                                                                                                                                                                                                |
| **J5**  | A password link refuses the wrong password and accepts the right one; an expired link and a revoked link each show their own page; and none of the three refusals is recorded as a read.                                                                                                                                 |
| **J6**  | Somebody who is not signed in converts a PDF on `/convert`, asks for a tracked link, is sent through sign-in, and comes back to find the converted deck in their account.                                                                                                                                                |
| **J7**  | A link on the account's own custom hostname serves and records a read. Skips with a clear message when the account has no live domain.                                                                                                                                                                                   |
| **J8**  | A free account that has used both its links is refused a third and shown the upgrade prompt; the upgrade page renders and the pay button points at Polar. No checkout is ever started.                                                                                                                                   |
| **J9**  | The four public API calls an integration makes, with their response shapes compared against `api-shapes.json`.                                                                                                                                                                                                           |
| **J10** | The reading clock, in five parts: a silent reader gets the warm-up plus the thirty-second allowance and no more; one key press renews the allowance; a reader who walks away is capped; a hidden tab accrues nothing; section totals never exceed the session; and the report prints the same number the database holds. |

## Before you run anything

Set these in the environment, or in the repository's `.env.local`, which the
suite reads the same way `e2e/smoke.spec.ts` does. **Nothing here is ever
printed by the suite.**

| Variable                                                | What it is                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAYWRIGHT_BASE_URL`                                   | The application to test. Defaults to `https://htmlradar.com`. Point it at `http://localhost:3000` or at a Cloudflare preview URL.                                                           |
| `PLAYWRIGHT_SHARE_BASE`                                 | The content domain. Defaults to `https://htmlradar.page`. Rarely changed: the proxy has no local mode, so recipient links are served from production even when the app under test is local. |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | How the journeys read what the product recorded.                                                                                                                                            |
| `GOLDEN_JOURNEY_EMAIL`                                  | The account the journeys act as. It **must be Pro or comped**, and its address **must be a mail sink** — see the next section. There is no fallback to `JOURNEY_EMAIL`, on purpose.         |
| `HTMLRADAR_API_KEY`                                     | An API key on that same account, for J5, J7, J9 and J10.                                                                                                                                    |
| `GOLDEN_FREE_EMAIL`                                     | _Optional._ A **free** account that has already used both of its tracked links, for J8. Without it, J8 skips. Also must be a mail sink.                                                     |

## Accounts, and why they are mail sinks

**A journey does not simulate a read. It performs one**, and the product then
does what it does for any real read: it e-mails the owner _"somebody opened
your document"_, and on a revoked or expired link it e-mails them that too.
That is not a side effect to be suppressed — J3 asserts those e-mails, and a
suite that stopped them would stop proving the thing senders pay for.

So the owner account must be an address that **accepts the mail and throws it
away**. On 21 September 2026 it was not: it was the founder's own address, and
a day of runs put thirty-one notifications in his personal inbox.

Resend, the sending provider, documents test addresses for exactly this.
`delivered@resend.dev` accepts and discards, and every test address supports a
label after a `+`, so one sink serves both accounts. Verified against Resend's
"Send test emails" documentation on 21 September 2026.

`lib.ts` refuses to run — it throws, it does not skip — if either owner address
is not on `SINK_DOMAINS`. Nobody can point this suite at a real inbox again.

### Creating the two accounts

Do this once, by hand, with the service-role key. Placeholders in angle
brackets.

**1. The Pro account** (`delivered+golden-pro@resend.dev`):

```bash
curl -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"delivered+golden-pro@resend.dev","email_confirm":true}'
```

The `handle_new_user` trigger creates the `profiles` row. Then make it comped,
so it is never capped and never billed — the same flag the founder's own
account carries, **not** a Polar subscription:

```sql
update profiles set tier = 'pro', is_comped = true
where email = 'delivered+golden-pro@resend.dev';
```

Confirm the column names against `schema/032_comped_accounts.sql` before
running it; if `is_comped` is named differently there, that file wins.

Then create an API key on this account for J5, J7, J9 and J10 (see
`schema/034_api_keys.sql` for the shape) and put it in `HTMLRADAR_API_KEY`.

**2. The free account at its cap** (`delivered+golden-free@resend.dev`):

Create it the same way, leave `tier = 'free'`, then use up its two lifetime
links so J8 has something to be refused. Two ordinary shares through the API
as that account is enough; they may be revoked afterwards, because the cap
counts revoked links too (`schema/027_free_tier_share_cap.sql`), which is what
makes this account permanently and repeatably "at cap".

**3. Point the suite at them:**

```bash
GOLDEN_JOURNEY_EMAIL=delivered+golden-pro@resend.dev
GOLDEN_FREE_EMAIL=delivered+golden-free@resend.dev
```

The journeys sign in with links minted through the Supabase admin API and
never read a mailbox, so no inbox access is needed for either account.

## Running them

Everything goes through one script.

```bash
export PATH=/Users/abhinandan/.nvm/versions/node/v22.22.2/bin:$PATH
cd packages/app
```

**Before a change** — on whatever the product is today:

```bash
PLAYWRIGHT_BASE_URL=https://htmlradar.com \
  node scripts/golden-journeys.mjs run ../../parity-before.json
```

**After the change** — on the preview deployment that carries it:

```bash
PLAYWRIGHT_BASE_URL=https://<preview>.pages.dev \
  node scripts/golden-journeys.mjs run ../../parity-after.json
```

**Then ask the only question that matters:**

```bash
node scripts/golden-journeys.mjs compare ../../parity-before.json ../../parity-after.json
```

A full run takes about fifteen minutes. Most of that is deliberate waiting:
a section has to be looked at for four seconds to count as read, and J10 sits
at an untouched tab for three minutes to prove the thirty-second allowance
caps it. There is no way to prove a clock measures reading except by reading.

To run one journey while you work on it, pass it through:

```bash
node scripts/golden-journeys.mjs run /tmp/x.json e2e/journeys/j5-link-controls.spec.ts
```

or, without a parity record, `pnpm qa:journeys`.

## The parity record

A run writes a JSON file. For each journey it holds the facts the product
recorded in its database and the numbers it printed on the screen. Ids, slugs
and timestamps are deliberately left out: they differ between two honest runs
and would bury the comparison in noise.

```json
{
  "baseUrl": "https://htmlradar.com",
  "recordedAt": "2026-09-21T09:14:22.101Z",
  "journeys": {
    "j3": {
      "db": {
        "readers": 1,
        "sessions": 1,
        "section_events": 3,
        "notifications_queued": 1,
        "notifications_skipped": 1,
        "active_seconds": 13,
        "section_titles": [
          "What this deck is for",
          "Why three sections",
          "What a failure here means"
        ]
      },
      "screen": { "viewers": 1, "sessions": 1, "active_seconds": 13, "reader_named": true },
      "events": ["document.created", "share.created", "share.copied", "share.first_view"]
    }
  }
}
```

## Reading a failure

**`compare` prints `NOT PARITY` and a list of lines.** Each line is one fact
the product recorded differently after the change:

```
  j3.db.section_events: 3 → 2 (tolerance 1)
```

That reads: before the change three section rows were written for the read,
after it two, and the allowance is one. The recipient's tracking changed —
which the design overhaul is not supposed to touch at all.

```
  j3.screen.viewers: 1 → 2
```

One reader became two on the screen while the database still says one. That is
the report's own arithmetic, not the tracker.

If a difference is **intended**, widen or add its tolerance in
`tolerances.mjs` with a comment saying why. Never delete the fact — a fact
that stops being recorded is a hole in the net, and the comparison will not
notice it a second time.

**A journey fails during the run** instead. The message says what the person
could not do. Playwright keeps a trace of the failure; open it with
`npx playwright show-trace test-results/<…>/trace.zip` and you see the screens
exactly as they were.

## Tests that are meant to fail

**None, as of 21 September 2026.** J4b carried Playwright's `test.fail()`
annotation while returning anonymous readers were unrecognised; the fix landed
and the annotation is gone. If a journey ever needs one again, mark it with
`test.fail()` and a comment naming the defect: the suite then stays green while
the defect stands, and the day a fix lands Playwright reports **failed —
expected to fail but passed**, which is the signal to delete the annotation
line, not the test.

**J4c was written expecting that treatment and did not need it.** The
theory was that `notify_on_first_open` fires on the insert of a session row
and never looks at how long the person stayed, so a glance should mail the
sender. Measured on 21 September 2026 it does not: an open with no dwell and
no scroll writes no session row at all, so the trigger never runs. The test
therefore asserts the correct behaviour plainly, and records the session count
for a glance in the parity record — so if a later change starts writing a
session there, and with it starts mailing senders about people who did not
read, the comparison shows it as `0 → 1`.

## Which host a journey uses, and why it matters

A recipient link is served from the hostname stored on its own row, and the
tracker — where the reading clock and the returning-reader identity both live
— is fetched from `/v1/tracker.js` **on that same host**. So two links of the
same document can behave differently if one host is serving a stale build.

That is not hypothetical. On 21 September 2026 `htmlradar.page` served the
post-fix bundle and the journey account's own domain served a bundle from
before it, cached by Cloudflare. The same silent reader recorded 35 seconds on
one and 0 on the other.

The suite therefore splits the two questions:

- **J10 pins its link to `htmlradar.page`** (`domain_id: null`), so a failure
  there means the clock itself changed.
- **J4b compares the bundle each host serves**, so a failure there means a
  host is behind and says which one.

## Safety

The suite is safe to run against production, and that is the whole design:

- It acts only as the journey account.
- Every document it creates is titled `golden-journey …`, and cleanup deletes
  on the account id **and** that prefix — never on one of them alone. J6's
  document is named by the product from the file, so it is deleted by its own
  id instead.
- Cleanup runs in an `afterAll`, so a journey that fails halfway still tidies
  up after itself, and cleanup never throws: a housekeeping error is not the
  product being broken.
- J8 reads the destination of the pay button and never follows it.

### What e-mail a run causes, and where it goes

Every one of these goes to the **owner account**, which is a mail sink that
accepts and discards. Readers are on `example.com` and receive nothing,
because HTMLRadar never mails a recipient.

| Journey    | E-mail the product sends                                                                                | How many per run |
| ---------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| J2 → J3    | _"&lt;reader&gt;@example.com opened golden-journey j1 …"_                                               | 1                |
| J2b        | none — the sender's own preview is skipped as an internal viewer                                        | 0                |
| J4a        | none — the returning reader is already known                                                            | 0                |
| J4b        | _"An anonymous viewer opened golden-journey j1 …"_                                                      | 1                |
| J4c        | none — an open with no reading time writes no session                                                   | 0                |
| J5         | _"golden j5 expired tried to open … but the link is past its expiry"_ and the same for the revoked link | 2                |
| J6, J8, J9 | none                                                                                                    | 0                |
| J7         | _"An anonymous viewer opened golden-journey j7 …"_                                                      | 1                |
| J10        | one per reader that reads: silent, nudge, away, hidden                                                  | 4                |

About nine e-mails per full run, all to the sink. Sign-in links are **not**
sent at all: the journeys mint the token through the Supabase admin API,
which hands back the token without sending anything.

## The one hook we want

Nothing in the application carries a test attribute today, so J3 finds the
headline numbers on the read report by the label printed above them —
"Viewers", "Sessions", "Avg tab-open". That is deliberate for now: a renamed
headline stat **is** a change to what the sender reads, and a person should
confirm it rather than a suite absorbing it in silence.

But it means a milestone that only rewords a label turns this journey red for
a reason that is not a regression. If that happens more than once, the
smallest product change that fixes it is a `data-testid` on each of the four
stat tiles in `src/components/ShareAnalytics.tsx` and on the reader rows in
`SessionsList.tsx` — about six attributes, no behaviour. This suite did not
add them, because the brief for it was not to touch product code.
