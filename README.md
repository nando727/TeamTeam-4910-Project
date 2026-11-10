README

## TeamTeam 4910 Project Repository

* Members
  * Fernando Tello
  * Ford Scott
  * Alec Brinkley
  * Mir Patel

## Stack

Node.js + Express + EJS (server-rendered pages), MySQL via `mysql2`,
`bcryptjs` for password hashing, `express-session` for sessions,
Vitest + supertest for automated tests.

## Getting started

1. Install [Node.js](https://nodejs.org) (v20+) and MySQL Community Server.
2. Install the project dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your local MySQL values
   (for local dev: `DB_HOST=localhost`, `DB_NAME=gooddriver`, your own
   `DB_USER`/`DB_PASSWORD`, any random string for `SESSION_SECRET`).
4. `npm run db:setup` — creates the database and tables
5. `npm run db:migrate` — adds the shared sponsor/contact fields and about data
6. `npm run db:seed` — creates demo users (driver1 / sponsor1 / admin1)
7. `npm run dev` — starts the app at http://localhost:3000

Sessions expire after 30 minutes of inactivity (story 22204). Set
`SESSION_IDLE_MINUTES` in `.env` to change it — a small value such as `0.25`
makes the timeout easy to demonstrate.

Five minutes before that, a warning appears with a countdown (story AA-12).
**Stay signed in** posts to `/session/keep-alive`, which extends the session and
restarts the clock; letting it reach zero lands on the login page with the usual
explanation. Set `SESSION_WARNING_MINUTES` to change the lead time — it is
capped at half the idle window, so `SESSION_IDLE_MINUTES=0.5` still warns.

The browser only mirrors the server's clock: the timings come from the page, and
with scripts disabled the session still expires exactly the same way.

## Where sessions are kept (story AA-71)

Signed-in sessions are rows in the `sessions` table (migration 016), read and
written by `src/auth/session-store.js`.

They used to live in express-session's default store, which is a JavaScript
object inside the running Node process. That is fine on a laptop and wrong
everywhere else:

- **every deployment signed everyone out.** Shipping a change restarts the
  process, and the object goes with it. Anyone using the site was dropped on
  the login page mid-task, for no reason they could see.
- **a second instance would have been worse.** Two instances behind one load
  balancer would each recognise only the sessions they created, so a visitor
  would appear randomly signed out depending on which one answered.

The store is about eighty lines over the existing `src/db.js`, rather than a
new dependency: express-session's store interface is four methods, and this way
the table lives in our own migration and the session id stays a query
parameter like everything else.

**The row lifetime is not the session lifetime.** The obvious version of this
expires the row at the idle limit, and it is a bug: a visitor returning to an
expired session would arrive with no session at all, which the site cannot tell
apart from someone who was never signed in &mdash; so they would be dropped on
the login page with no explanation, losing the "your session expired" message
that story 22208 exists to provide. Rows are kept for `SESSION_ROW_HOURS`
(default 24), never less than two idle windows, and `sessionTimeout` stays the
only thing that decides when a session is over.

Expiries are written with `FROM_UNIXTIME(? / 1000)` and compared against
`NOW()`, so no timestamp is ever rebuilt in Node's local zone. That is the trap
this project has already hit twice (see the lockout notes above), and a session
store is exactly where it would have hit a third time.

Expired rows are cleared out hourly (`SESSION_PRUNE_MINUTES`) by
`startPruning()`, which `src/server.js` starts after the server is listening:
the app itself never starts a timer, so importing it in a test leaves nothing
running. A failed sweep is logged and ignored &mdash; expired rows are already
refused, so not clearing them is untidy rather than harmful.

`SESSION_STORE=memory` asks for the old in-process store. `tests/setup.js` sets
it, because the suite mocks the database query by query and would otherwise
need all 46 files to answer session reads. The default is the database, so the
deployed app cannot quietly end up with the memory store.

One cost worth knowing: the idle window slides forward on every request, which
changes the session, which means a row write on nearly every request. The
alternative is not sliding it, which would log people out while they were
working.

`tests/session-rows.test.js` runs the real app against a fake sessions table.
The test that matters is **a session row this process never wrote is honoured**,
because that is a deployment in miniature, and it fails if the store is not
wired in.

**Checked against the live RDS database**, because mocks hand back `Date`
objects and so cannot see a timestamp crossing between MySQL and Node:

- a session written through the store and read back came out intact, and MySQL
  put its expiry 1440 minutes out &mdash; exactly 24 hours, so there is no zone
  skew hiding in `FROM_UNIXTIME`;
- pruning deleted an hour-old row and left a live one alone;
- with a session row planted as an earlier process would have left it, a
  freshly started server answered the keep-alive `200`, was stopped the way a
  deployment stops it, and the next server answered `200` again. The same
  request against `SESSION_STORE=memory` answered `401`, which is what every
  deployment used to do to everyone signed in.

## Signing out of all sessions (story AA-13)

**Profile → Sign out of all sessions** ends the account's session on every
browser and device, including the one that asked. Other devices land on the
login page with an explanation the next time they ask for a page.

Rather than deleting the account's sessions, each session records when it was
issued and the account carries a cutoff in `users.sessions_valid_from`. Signing out everywhere just stamps that column with
the current time; `src/auth/session-revocation.js` then refuses any session
issued before it. That reaches sessions this request never touches, on any
server instance, and it outlives a restart because the cutoff is in the database.

The cost is one indexed lookup per signed-in request. Signed-out requests, the
login page included, do not query at all.

This was the only option when sessions lived in memory and could not be listed
by user. Story AA-71 moved them into a table, so deleting a user's rows is now
possible &mdash; the cutoff is kept anyway, because it is one check that also
covers a session saved between the delete and the reply, and it refuses a
signed-out session even if its row somehow survives.

Two details are easy to undo by accident, so they are worth knowing:

- **The comparison belongs in SQL.** `sessions_valid_from` is a `DATETIME`,
  which carries no timezone. Reading it into Node turns it into a `Date` in the
  machine's local zone, so a UTC database and an eastern laptop disagree by four
  hours and every session is refused forever. The query hands MySQL the session's
  epoch instead (`sessions_valid_from > FROM_UNIXTIME(? / 1000)`) so both times
  stay in one zone. `tests/revoke-sessions.test.js` guards this.
- **Milliseconds matter.** Migration 013 widens the column to `DATETIME(3)`.
  With whole seconds, a revocation in the same second as a login stored a cutoff
  that compared as *earlier* than the session it was meant to end, and that
  session survived.

Run `npm run db:migrate` to apply migrations 012 and 013. There is no new
setting in `.env`.

### A new password signs the account out elsewhere (story AA-14)

The same cutoff does the work. Changing or resetting a password revokes that
account's sessions, so a password changed because someone else knows it
actually locks them out:

- **Profile → Change password** ends sessions on other devices and keeps the
  one making the change, by stamping it just past the cutoff.
- **A reset link** ends every session for the account. Nobody is signed in
  while using the link, and whoever was is exactly who should be signed out.
- **An admin resetting a password** ends that account's sessions. An admin
  resetting their own keeps the session they are working in.

A password that is rejected &mdash; the wrong current password, or one that
fails the complexity rules &mdash; revokes nothing.

Setting a first password from a setup link is deliberately left out: the
account has no sessions yet, and that flow is covered by story 22255.

## Account lockout (story 22214)

Five failed sign-ins block further attempts for a while. Only failures **since
the last successful sign-in** count, so signing in successfully clears the
tally. While locked, the correct password is refused too — that is the point —
and the message says how many minutes remain. Every blocked attempt is still
recorded in `login_attempts`.

The lock is worked out from that audit table, so there is nothing to reset by
hand and it expires on its own. Set `LOGIN_MAX_FAILURES`,
`LOGIN_FIRST_WAIT_MINUTES` and `LOGIN_LOCKOUT_MINUTES` in `.env` to change the
policy; `LOGIN_LOCKOUT_MINUTES=1` makes it easy to demonstrate.

### Counted per origin, not per account (story AA-70)

Counting failures by username alone meant anyone who knew a username could keep
that account locked for as long as they cared to — the account was punished for
what somebody else did, and a password nobody can use is as good as no account.
Failures are now counted per `(username, source_ip)` pair, so a lock lands on
whoever caused it and the real user still signs in from their own machine.

Two details are easy to undo by accident:

- `source_ip <=> ?` is **NULL-safe** equality. Attempts whose origin could not
  be worked out are counted against each other; with plain `=` they would match
  nothing and never lock at all.
- The success that clears the tally is looked up **for the same pair**. A global
  one would hand an attacker a fresh five guesses every time the real user
  signed in. `tests/lockout-per-source.test.js` names that case.

The origin comes from `req.ip` (`requestSource` in `src/auth/routes.js`), which
needs `app.set('trust proxy', 1)` to be the visitor's address rather than the
load balancer's behind Elastic Beanstalk. An IPv4 address arriving in IPv6 form
is trimmed back to `203.0.113.7` so the same visitor is one bucket, not two.

A shared office or campus NAT does put colleagues in one bucket, which is the
known trade-off: being slowed down alongside your neighbours is recoverable,
being locked out by a stranger is not.

Checked against the live RDS database with `LOGIN_MAX_FAILURES=3`, because
mocked tests cannot see a timestamp crossing between MySQL and Node (the note
at the end of this section): guessing from one address answered `429` while the
real user signed in from another with `302`.

### The wait grows instead of being one fixed block (story AA-70)

The lock at the limit is **1 minute**, and each further failure doubles it — 1,
2, 4, 8, then 15 — up to `LOGIN_LOCKOUT_MINUTES`. One flat block treated two
unlike visitors the same: fifteen minutes is a long time to lose over a typo,
while someone working through a password list is barely inconvenienced by it and
simply comes back for five more guesses. A doubling wait is cheap for the typo
and expensive for the list.

Failures are only counted for `LOGIN_LOCKOUT_MINUTES`, which is also the longest
wait, so sitting out the longest wait empties the tally: **nobody can be locked
out permanently**, however high the count went. `waitMinutes` relies on
`2 ** n` being `Infinity` rather than an error, which `Math.min` turns back into
the cap — there is no special case for an absurd failure count, and
`tests/lockout-backoff.test.js` pins that down.

The lengths themselves are plain arithmetic on a failure count, so the mocked
tests do cover them; the one value that crosses between MySQL and Node here is
the newest failure's timestamp, which this change did not touch.

### Getting back in (story 22215)

Being refused is only half of it, so the sign-in page lists the three ways back
in rather than just the minutes: wait out the remaining time, reset the password
(offered as a link to `/forgot-password`, not as prose), or ask an
administrator. It also says the thing nobody would guess: **another attempt
before the wait is over restarts it**, because the lock runs from the most
recent failure. Someone retrying every minute never gets in and would otherwise
never learn why.

The wording lives in `lockoutMessage` and `lockoutGuidance`
(`src/auth/lockout.js`). The JSON sign-in route gets the one-line version, since
a client cannot follow a link. Both stay vague about whether the account exists:
the lock is checked before any password is, and `login_attempts` records
usernames that were never real, so a locked reply reads identically either way.
`tests/lockout-message.test.js` and `tests/lockout-login.test.js` hold that
property in place — a locked response for an invented username is compared
character for character against one for a real account.

### An administrator can unlock an account (story AA-72)

**Locked users** (`/admin/locked-users`, in the Users menu) lists the accounts
that cannot sign in right now, each with an **Unlock** button behind the same
form token as every other admin action. Unlocking says so and returns to the
page it was done from; unlocking an account that is not locked changes nothing
and says that instead.

**Manage users** marks a locked account with a red `locked` chip that links to
that page, but does not carry the button itself: the question "who is locked
out?" comes up when somebody calls for help, and answering it should not mean
reading every row. Both pages get their answer from the same
`lockedUsernames()`, so they cannot disagree.

That split also took the user list from nine columns to six. Two pairs were the
same fact twice: **Status** and **Change status** (the dropdown already shows
the current status, so it is now the badge as well, coloured green, grey or red
by status), and **Password** and **Setup link** (an account either has a
password or is still waiting to set one &mdash; each column was offering the
other's action to accounts that could not use it).

Clearing the lock needed a decision, because the lock is not stored anywhere:
it is counted from `login_attempts`. There is no flag to switch off, and the
two obvious ways are both wrong:

- **deleting the failed attempts** destroys the audit log the course spec
  requires, along with the evidence of whatever the admin was reacting to;
- **inserting a successful attempt** puts a lie in that same log.

So an unlock is its own row in `login_unlocks` (migration 017), and the count
starts after the latest one: nothing is rewritten, and the unlock is itself
auditable &mdash; which administrator, and when. `tests/lockout-unlock.test.js`
asserts that no `DELETE` or `UPDATE` ever touches `login_attempts`.

Two consequences worth keeping:

- **It cannot be used to switch the lockout off.** Only failures after the
  unlock count towards a new lock, so the next run of failures locks the
  account again.
- **An unlock covers every origin for that username.** The lock is keyed on
  `(username, source_ip)` since story AA-70, but an administrator acts on an
  account and must never be asked to type an address.

The list asks one grouped question for the whole page rather than running a
lockout check per row, and both that query and the sign-in check hand their
result to the same `lockFrom()` &mdash; so the badge on the page and the refusal
at the sign-in form cannot drift apart.

**Checked against the live RDS database**, because mocked tests match on the
SQL string and never parse it &mdash; a bad correlated subquery would pass every
one of them and fail on the deployed site. Five failures planted for a username
nobody owns locked it, the grouped lookup listed it, the unlock cleared it, and
the row recorded the right administrator. The synthetic rows were deleted
afterwards; nothing else in `login_attempts` was touched.

`unlocked_at` and `attempted_at` are both `TIMESTAMP`, which MySQL keeps to
whole seconds, so a failed attempt in the same second as an unlock is not
counted. That is deliberate: the cost is a guess or two inside one second, on
an account an administrator has just decided to let back in, and the
alternative is widening the audit table's own column for nothing else's
benefit.

**The newest failure is read as epoch milliseconds, deliberately**
(`UNIX_TIMESTAMP(MAX(attempted_at)) * 1000`). A `DATETIME` comes back from MySQL
with no timezone attached and Node rebuilds it in the machine's local zone: with
a UTC database and an eastern laptop, every failure looked four hours in the
future, so a fifteen-minute lock lasted four hours and the page told people to
wait 255 minutes. The mocked tests could not see it, because a mock hands back a
`Date`, which is already unambiguous. The same trap caught `sessions_valid_from`
earlier; if you touch a timestamp that crosses between MySQL and Node, compare
it in SQL or carry it as an epoch.

## Role permissions (stories 22251, 22252, 22253)

Every route group guards itself in two steps: no session sends the visitor to
the login page, and a session with the wrong role is refused.

- **No session** → `rememberAndRedirect()` from `src/auth/return-to.js` saves the
  page they asked for and redirects to `/login`. After signing in they land back
  on that page rather than the home page.
- **Wrong role** → `denyAccess()` from `src/auth/deny.js` renders `views/403.ejs`
  with a 403: a real page in the site layout naming the role the page needs and
  the role the account has, plus a link home.

Use `denyAccess(req, res, { needs: 'admin' })` rather than
`res.status(403).send('...')` so every refusal reads the same. Pass `detail` for
a case the role name alone does not explain, e.g. a sponsor account that is not
linked to an organization yet.

`tests/protected-routes.test.js` checks one page per route group, so a new group
added without a guard fails there. `tests/denied-access.test.js` covers the
wrong-role page for each role.

### The JSON API (`/api/*`)

API routes use `requireApiLogin` and `requireApiRole(...)` from
`src/auth/api-guard.js` instead, so a refused call gets a status and a JSON body
rather than a login page it cannot read: **401** when signed out, **403** for the
wrong role. `POST /api/users` and `POST /api/sponsors` are admin-only;
`GET /api/about` is public.

Endpoints that act on "your" account take the id from `req.session.user.id`,
never from the request body, so a caller cannot aim them at someone else.
Covered by `tests/api-permissions.test.js`.

## Sprint one: driver sponsor applications

Run `npm run db:setup` to add the sponsor and application tables to an existing
database, then `npm run db:migrate` to update existing tables for the admin API.
Run `npm run db:seed` to add a demo sponsor (this also resets the demo
user passwords). Log in as `driver1` and choose **Apply to join a sponsor**.
Drivers select a sponsor, fill in application information, review and edit it,
and submit once per sponsor (stories 22127, 2212, 22129, and 22130).
Required information: full name, contact email, and reason for applying.
Reviewing saves a temporary session draft; only the final submit stores an application.
Approval and rejection belong to sprint two.

## Sprint two: driver application status

Run `npm run db:migrate` to add application status and rejection reason fields.
Existing and new applications start as `pending`. Drivers select **View application
status** on their homepage to see pending, approved, or rejected applications.
Rejected applications also show the sponsor's reason, or a message if none was
recorded. The driver's original `reason` for applying stays separate from
`rejection_reason`. Refresh the page to see a changed decision.

Sponsor users can now approve or reject pending applications from their homepage.
Their account's `users.sponsor_id` must identify the organization they manage.
Use these controls to test decisions: approval also creates the driver's membership.
Updating only the application status manually bypasses that step.

## Submission confirmation, sponsor memberships, and points

After submission, drivers see a success message and a saved application reference
on the Sponsors page. That reference remains visible after refreshing or signing
in again. Confirmation means received; it does not mean approved.

Run `npm run db:migrate` before using **My sponsor and points**. Migration 008
creates `driver_sponsors` and adds memberships for already-approved applications.
New memberships start with 0 points. `npm run db:migrate` runs 008 only while
that table does not exist, so rerunning it preserves balances and does not bring
back removed sponsorships. A driver may now belong to several sponsors (migration
014). `users.sponsor_id` continues to identify the organization managed by a
sponsor-role account.

Approving a pending application saves its decision and membership together.
Completed decisions cannot be submitted again. Approval by a second sponsor is
blocked without changing the original membership or balance. Drivers can see
only their own approved program and current balance at `/driver/programs`.
An inactive sponsor is labeled as inactive, and its balance remains visible.
Point awards, deductions, redemption, and email confirmations are outside these
stories. To demonstrate a nonzero balance locally, update a test membership's
`point_balance` in Workbench and refresh the page.

The React frontend in `client/` is separate from these Express/EJS driver pages.
Continue using http://localhost:3000 for the driver application flow.

## Creating users (story 22255)

An admin creates users at **/admin/create-user**. Leaving the password blank
creates the account without a usable password and issues a one-time setup link,
shown on the page and written to the server log as an email (the mailer's
default `console` transport — nothing is actually sent). The new user opens the
link, chooses their own password, and is sent to the login page.

Links expire after 48 hours; set `SETUP_LINK_HOURS` in `.env` to change that.
A link works once: reusing it shows a "no longer works" page.

### Reset links are emailed (story 22222)

**Forgot your password?** on the sign-in page takes a username, and a link to
choose a new password is emailed to the address on the account. The link is
random, stored only as a SHA-256 hash, expires after 30 minutes and works
once; issuing one retires any earlier unused link, so at most one is live.

Mail goes through `sendMail()` (`src/mail/mailer.js`), which has a real `smtp`
transport using nodemailer. `MAIL_TRANSPORT` chooses: `console` stays the
default so a fresh checkout needs no mail settings and still shows the link in
the server log. With `smtp` selected but settings missing, the app **says which
ones are missing and falls back to the log** &mdash; a link that reaches
neither the inbox nor the log is the worst of both. Only the names of the
settings are ever logged, never the values; one of them is the password.

The connection has explicit timeouts (10s connect, 10s greeting, 15s socket).
A visitor is waiting on this request, and an SMTP server that accepts the
connection and then goes quiet would otherwise hold the page open for minutes.
A send that fails is logged and recorded as undelivered, and the thing that
triggered it still succeeds: an account is created whether or not its mail got
out.

Every successful send logs one line, `[mail] Sent "<subject>" to r***@example.com
<message id>`, so the live log shows what went out. An account with no email
address on file is not handed to the SMTP server, which could only refuse it:
the log says `[mail] "<subject>" was not sent: no email address on file.` The
create-user pages and bulk upload say whether each setup email was sent, and
always show the setup link too, so a link can be passed on by hand.

**The deployed site sends through Gmail.** The Elastic Beanstalk environment
uses `MAIL_TRANSPORT=smtp`, `MAIL_HOST=smtp.gmail.com`, `MAIL_PORT=587`, and the
team's Gmail account. Things that matter with Gmail:

- `MAIL_PASSWORD` must be a **Google app password** for `MAIL_USER`, the 16
  letters Google shows once, not the account's normal password. App passwords
  need 2-Step Verification on the account, and changing the account's Google
  password revokes them, so a new one is needed after that.
- `MAIL_FROM` should be the same Gmail address. Gmail replaces any other From
  address with the account's own unless it is set up as an alias.
- A wrong password fails with `535 Username and Password not accepted`, logged
  as `Could not send mail to ...`.
- Personal Gmail accounts can send to roughly 500 recipients a day.
- Mail to a university or work address may land in spam the first time.

#### Checking it reaches a real inbox

`npm run mail:test -- you@example.com` sends the account notices (story
22227) to an address you choose, through the SMTP settings in `.env`. Add
`password` or `email` to send just one of them.

It touches no database and changes nobody's password: the notice functions are
handed a made-up account row whose address is the recipient, so the text that
arrives is composed by the same code the app runs. It refuses up front when a
`MAIL_*` setting is missing &mdash; naming only the settings, never the values
&mdash; because `sendMail()` would otherwise fall back to the log and the
script would report a success that delivered nothing. A send that Gmail
refuses exits non-zero and says so, with a hint when the cause is the app
password.

#### The form cannot be used to fill an inbox

Anyone can post a username to `/forgot-password` as often as they like, and
every post used to be another email to somebody who never asked for one. An
account can now be sent **3 links per 15 minutes** (`RESET_LINK_MAX_REQUESTS`,
`RESET_LINK_WINDOW_MINUTES`); a few in a row are legitimate, since the first
may have gone to spam.

The count comes from the `password_resets` rows the requests already leave
behind, so there is no new table and nothing to clean up, and the comparison
stays in SQL against the database's own clock.

**A refused request looks exactly like an accepted one.** "Too many requests"
would answer the question the rest of this page works to refuse: whether that
account exists. The refusal is visible in the server log instead, and
`tests/forgot-password-limit.test.js` compares the two responses body for body,
and against the response for a username that was never real.

What this does not cover: someone cycling through *different* usernames. That
needs the request's origin, which `password_resets` does not record &mdash; a
column and a migration, worth its own story rather than being tacked on here.

### Password changes are recorded (audit log requirement)

Every password that gets set writes a row to `password_changes` (migration
019): whose password it was, who changed it, how, and when. **Never the
password and never its hash.**

Nothing recorded this before. `password_resets` looks like it does, but it
holds reset *tokens* &mdash; it says a link was requested, not that a password
was ever changed, and it knows nothing about an administrator's reset or
someone changing their own.

`method` is one of `profile`, `admin-reset`, `reset-link` or `setup-link`.
Anything else is written as `unknown` rather than dropped: a password change
nobody can account for is precisely what the log exists to surface, so it must
never be the quiet case. A caller that passes no method at all gets the same
treatment, which is what makes this safe to rely on when a fifth path appears.

`changed_by_user_id` is NULL where nobody was signed in &mdash; a reset link or
a setup link, where the link itself is the credential. Where somebody was, it
is **the person at the keyboard**: an administrator who is impersonating a
driver and changes that driver's password is recorded as the administrator,
not as the driver whose session it technically is. A log that names the wrong
person is worse than no log.

The row is written after the password, so the log only claims changes that
happened. The two statements are not in one transaction: if the insert fails,
the request errors with the password already changed and nothing recorded. A
transaction is the honest fix and would need a helper in `src/db.js`, which
every other feature would then want too &mdash; worth its own story rather than
being smuggled in here.

### The owner is told when a password changes (story 22227)

Every password change emails the account: **what changed, when, and how**, with
nothing a thief could use &mdash; never the password, never its hash, never a
token. The wording differs per method, because "was that reset mine?" can only
be answered if a change the owner made reads differently from one made for
them: from your profile page, by an administrator, or using a reset link.

Without this, a stolen reset is silent. An attacker with access to an inbox
resets the password, and the real user's first clue is their own password
failing &mdash; after the attacker has already been in.

Like the audit row and the setup-link voiding, the notice hangs off
`updateUserPassword()` rather than the four routes that set a password: a
notice each route has to remember is one that goes missing the first time a
fifth path appears, and the path that forgets would be the one worth using.
The wording lives in `src/auth/password-notice.js`, which never touches the
database &mdash; the store passes it the account row it has already loaded.

A **setup link is the one quiet method**: whoever used it is the person
choosing the password and is still in front of the form. Everything else is
announced, including a method this code does not recognise, so silence is never
the default. An account with no address on file logs a line and sends nothing,
rather than mailing the `(no email on file)` placeholder at a real SMTP server.

Sending cannot fail the change. `sendMail()` already turns a dead mail server
into a logged error, so a password the owner asked to change stays changed even
when the notice does not go out &mdash; `tests/password-change-notice.test.js`
covers that with a transport that throws.

The timestamp is this process's clock, formatted in UTC and labelled as such.
Reading `changed_at` back out of the audit row would mean a MySQL `DATETIME`
crossing into Node, which has already cost this app two fixes; the mail is
composed within a second of the write, which is close enough for a human
deciding whether they recognise the change.

The "this was not you" link needs `APP_BASE_URL`, since there is no request
here to borrow a host from. Without it the mail names the **Forgot password**
link on the sign-in page instead of pointing at a `localhost` URL the reader
cannot open.

#### A changed address is announced to the old one

The notice above is only worth something if the address it goes to cannot be
swapped quietly first. It could: someone with a session points the account at
their own inbox, uses **Forgot your password?**, and receives both the reset
link and the warning about it. The owner hears nothing at any point.

So changing the email on an account mails **the address being replaced**, which
is the last one that still reaches the owner. It shows both addresses, says a
signed-in session made the change, and says to tell an administrator &mdash;
not to reset the password, which no longer helps once the links go elsewhere.

`notifyEmailChanged()` (`src/auth/contact-notice.js`) hangs off
`updateUserContact()`, the one function all three editing paths go through (the
profile page, the JSON profile endpoint, and the member page). It needs no
query of its own: that function already loads the account before and after the
write, so the notice is handed both rows. Nothing is sent when only the name
changed, when the address was resubmitted unchanged, when the account had no
address to begin with, or when the write was refused as a duplicate &mdash;
`tests/email-change-notice.test.js` covers each.

### Setting a password voids the setup link (story 22225)

An unused setup link dies the moment the account gets a password, however that
happens: the admin's **Reset**, the user changing their own password, a reset
by emailed link, or claiming the account through a different link.

It used to survive. An account created with a link and then given a password
another way &mdash; most likely the visitor ignoring the link and using "forgot
password" instead &mdash; kept a working setup link until it expired, and
anyone holding that link (a forwarded email, a shared inbox, the server log it
is printed to) could set the password again and take the account over.

The voiding lives in `updateUserPassword()` (`src/users/store.js`), not in the
four routes that call it. Claiming an account used to write its own hash and
its own `UPDATE`, so the first commit of this story routed that through the
same function: there is now exactly one place in the codebase where a password
is written, and anything that must happen whenever one is set has one home. A
fifth path cannot forget it.

**The link is spent before the new password is stored**, deliberately. If the
write fails in between, the worst case is a spent link an administrator can
resend. The other order fails the wrong way round: a failed void leaves a live
link to an account whose password has just changed, which is the hole this
closes. `tests/setup-link-voided.test.js` pins the order down, because it reads
like an arbitrary choice and is not one.

Voiding marks the row used; it never deletes it. The record that a link was
issued is part of the account's history.

### Setting a password voids a pending reset link (story AA-27, 22229)

The same thing, for the other kind of link. Someone asks for a reset link, then
gets back into the account another way &mdash; remembers the password, or an
administrator resets it &mdash; and changes the password. The emailed link was
still sitting in the inbox, and until this story it still worked.

It lives in the same place and for the same reason:
`invalidateResetTokens()` (`src/auth/password-reset.js`) is called from
`updateUserPassword()`, so all four password paths get it without knowing about
it. The link being used *right now* is already spent by the time that runs, so
a reset through a link voids only the others.

`tests/reset-link-voided.test.js` keeps real `password_resets` rows with a real
`used_at`, so a voided link genuinely returns 404 rather than merely proving a
statement ran. It also pins what a void must **not** break: a refused change
(wrong current password, or one that fails the rules) leaves the link alive,
and one account's change never touches another's link.

### A password cannot be reused (stories AA-29 22232, AA-79 28211)

A new password has to be a new password. The rule is **the password in force
now, plus the last five that account has had**, and it is one question asked in
one place: `matchesRecentPassword()` in `src/users/store.js`, called from
`updateUserPassword()` before anything is written.

The current password is read from `users` and the rest from `password_history`,
even though the current hash is normally the newest history row too. `users` is
the authority on what the password *is*, so the half of the rule that matters
most does not depend on the newer table being complete: an account created with
a password, or one whose rows predate migration 021, is still refused its
current password.

**Where the old hashes live.** `password_history` (migration 021) is the one
table in the app that keeps hashes a password no longer in use.
`password_changes` deliberately holds none &mdash; an audit log read by
administrators should not double as a pile of material to crack. The cost of
having such a table is worth being plain about: a stolen copy is a set of
bcrypt hashes someone can work on offline. Three things keep it small.

* Hashes only, written by the same helper as the live password, so bcrypt cost
  12 protects them equally.
* Bounded. `PASSWORD_HISTORY_LIMIT` (`src/auth/password-policy.js`) is five, and
  it does both jobs: the app compares against five and keeps five, deleting
  older rows as it goes, so the table cannot hold an old hash the rule would
  never look at.
* Migration 021 seeds each account's current hash once, so the password an
  account had *before* the table existed cannot be set straight back after one
  change. `NOT EXISTS` makes that fill safe to rerun, which matters because
  `npm run db:migrate` applies every file on every run &mdash; see
  [Database changes come first, and on RDS](#database-changes-come-first-and-on-rds).

**Two forms check earlier than the store does.** The emailed-link form
(`POST /reset-password/:token`) asks before it spends the token, because the
link is the only way back onto that page: getting this wrong has to cost a
retry, not the link. The profile form compares the two strings it was given,
because it is the one form that knows the current password, and so can name
that mistake precisely instead of reporting the general rule. Both are
shortcuts to a friendlier message, not the rule itself &mdash; the store still
refuses it if a route forgets.

**What it costs.** Every accepted password change now runs up to six bcrypt
comparisons before the hash itself, which is a second or two on a small
instance. That is the main reason the limit is five and not fifty. A password
change is rare enough to afford it; nothing else in the app pays it.

**An account also remembers the password it was created with.** `createUser()`
is the one place other than `updateUserPassword()` that writes a hash, and it
has to be: there is no account to update yet. So it records too, straight after
the `INSERT` that gives it an id. Without that, the password an administrator
typed on the create-user page was forgotten the moment the user chose their own
and could be set straight back &mdash; the current-password half of the rule
covered it only until the first change. An account created *without* a password
(a bulk upload, or "send a setup link instead") records nothing: the
`!no-password-set` placeholder it stores is not a hash of anything, so a row
for it could never match.

**What the rule does not reach** is anything past the fifth. Those rows are
deleted, so there is nothing left to compare against and the password becomes
usable again. The limit is a real edge, and
`tests/password-reuse-refused.test.js` tests it as one rather than pretending
otherwise.

**It tells you that a password was used.** The admin reset page says so of the
account it is resetting, and the emailed-link page says so of the account that
link belongs to. That is a deliberate trade: the message has to be actionable,
and both audiences can already take the account over by other means &mdash; an
administrator through impersonation, a link holder through the link. It is
still a way to confirm a guessed password, which matters if the person reuses
that password elsewhere.

Tests: `tests/password-history.test.js` for the recording and the pruning, with
an in-memory table so pruning is real; `tests/password-reuse-refused.test.js`
for the refusals on all three forms plus the two edges above;
`tests/same-password-refused.test.js` for the current-password half on its own.

## Driver point history (DF-17, DF-20, DF-22)

Drivers can open **View my point history** from their homepage or **My sponsor
and points**. The page at `/driver/points/history` shows all of the signed-in
driver's recorded transactions, newest first, including the UTC date, sponsor,
positive or negative point change, and reason. History remains available even
without a current sponsor membership. Other drivers' records are not accessible.

This uses the existing `point_transactions` table from migration 009 and the
shared report query. No new migration is required; if 009 has not been applied,
run `npm run db:migrate` before using the page. Direct edits to `point_balance`
do not create transaction history; earlier unrecorded changes cannot be recovered
by this page. Awarding or deducting points is outside these viewing stories.

Sponsor affiliation (DF-12) was already implemented on **My sponsor and points**
and is unchanged.

## Driver product catalog (DF-27 to DF-31)

Drivers open **Product catalog** (`/driver/catalog`) to browse available selections
from their current sponsors, grouped by sponsor. Product names open detail pages
with the sponsor's saved title and the provider's description. Cards and details
also show the saved product image (when present) and dollar price, matching the
sponsor's saved catalog. This price is a saved value, not a live price quote or
a point-redemption cost. Admin-added
memberships also work. Ford's `/my-catalog` URL redirects to this same page.

Both sponsor editing and driver browsing use Ford's `catalog_items` table. No
copy into `products` or `sponsor_catalog` is needed. Migration 020 now creates
`catalog_items` for new databases and does not change an existing table. The old
empty tables from the earlier draft are unused and can be left alone.

The driver pages reuse `src/fakestore/client.js`. Only saved selections still
present in the provider's normalized product list are shown; missing products
return 404 on the detail page. FakeStore does not provide an inventory/stock
flag, so presence in its usable product list is the available signal. Its cache
lasts five minutes; provider removals can take that long to appear. Once the cache
expires, driver pages report provider failures instead of using stale products.
Removing a sponsor selection or membership takes effect on the next request.

To test: as a sponsor, open **Add to your catalog**, save a product, then log in
as one of that sponsor's drivers and open **Product catalog**. Click its name to
check the detail page. Remove the selection as the sponsor and refresh the driver
page: the item disappears and its old detail URL returns 404. Other sponsors'
selections are inaccessible unless the driver also belongs to those sponsors.
Mocked tests cover provider removals and outages without changing the live API.

**Product images (sprint 8).** Every saved image is a `https://fakestoreapi.com`
URL. The content security policy used to allow images from this app only, so
the browser blocked them all and showed broken-image icons. The policy now also
allows that one host (`PRODUCT_IMAGE_HOST` in `src/security-headers.js`), and
nothing else outside. Catalog images render through
`src/views/partials/product-image.ejs`: a product with no image shows a "No image"
placeholder, and `public/product-images.js` swaps the same placeholder in for
an image that fails to load. If products ever come from another host, add it to
that one constant.

## Sponsor purchases for a driver (sprint 8)

Sponsors spend a driver's points on an item from their own catalog: **Item
catalog -> Your catalog -> Buy for a driver**. They pick one of their own active
drivers, each listed with the balance they hold with this sponsor, then review
the cost and the balance before and after, then **Confirm purchase**. If the
driver is short, the page says by how much, for example "Dana Driver has 40
points with Demo Sponsor. This item costs 250 points, so they need 210 more
points." and offers no confirm button.

The purchase goes through `adjustPoints()` with its `purchase` option, which in
one transaction locks the driver's balance, refuses if it is short, writes the
negative `point_transactions` row (reason `Catalog purchase: <item>`, made by the
sponsor user), updates the balance, adds the driver's point alert, and inserts
the `purchases` row with the item's saved price and points. So the purchase shows
in the driver's point history and alerts, and in the Sales by Sponsor, Sales by
Driver, Sponsor fees, and Invoices reports. The review is held in the session
with a one-time id: a double click, a replayed form, or a confirmation for a
different driver or item buys nothing. The item's saved price and points are
used, not a live price.

Drivers still cannot buy for themselves. Whoever builds that should call
`adjustPoints()` with `purchase` the same way.

## Framing and script injection (story 28199, AA-74)

Every response carries four headers, set in `src/security-headers.js` and
mounted ahead of every route in `src/app.js`:

| Header | What it stops |
| --- | --- |
| `Content-Security-Policy` | Framing, and any script the app did not serve |
| `X-Frame-Options: DENY` | Framing, for an older browser that ignores the policy |
| `X-Content-Type-Options: nosniff` | A response being treated as a script because of how it looks |
| `Referrer-Policy: no-referrer` | A reset or setup link leaking in a Referer header |

The policy allows scripts only from this app (`script-src 'self'`), with no
inline exception. That is what makes it worth having: a value that escapes
escaping and lands in a page as `<script>` or `onclick=` has nothing that will
run it. Keeping that true has one rule for everyone working on the views:

**No `<script>` blocks and no `on...=` attributes in templates.** Put the
behavior in a file under `public/` and reach it from the markup with a `data-`
attribute. Examples in `public/site.js`: `data-autosubmit` on a filter dropdown,
`data-confirm="..."` on a form that asks before deleting, `data-select-on-focus`
on a setup link, and `data-submit-once` on the purchase confirmation. The
invoice's print button uses `data-print` in `public/report.js`.

Images are allowed from this app, `data:` URIs, and the product service's image
host only (see the catalog section).

Inline `style="..."` attributes are still allowed (`style-src` keeps
`'unsafe-inline'`), because several pages use them and the risk from a style is
far smaller than from a script. Tightening that is a later story.

To see it work: `curl -I http://localhost:3000/login` shows the headers, and an
`<iframe src="http://localhost:3000/login">` on any page renders empty with a
console message naming `frame-ancestors`.

One known gap: Express answers an unmatched URL with its own 404 handler, which
replaces the policy with its own stricter `default-src 'none'`. That one has no
`frame-ancestors`, so a 404 page is protected by `X-Frame-Options` alone.
`tests/security-headers.test.js` pins that behavior so a change to it is noticed.

## Automated Testing

Story 23794 uses Vitest and supertest for automated testing. Test files go in `tests/`
(lowercase) and end in `.test.js`. No database is needed; tests mock the db layer.

### Run all tests
```bash
npm run test-run
```

### Run tests in watch mode during development
```bash
npm run test
```

## Driver Point Tracking report (stories AD-18 to AD-22)

Sponsors and admins open **Reports** in the header (or `/reports/points`) to see
every point award and deduction: driver, date, change, the sponsor it belongs
to, who made it, and the reason, with each driver's current total above the
table. A sponsor sees only drivers in their own organization; an admin sees all
drivers and can narrow to one sponsor. Filter by one driver or all, and by a
date range (date pickers plus quick ranges). **Download CSV** exports exactly
the rows on screen with the same filters.

Point history lives in `point_transactions` (migration 009). The driver's
current total is still `driver_sponsors.point_balance`, so anything that awards
or deducts points must insert a `point_transactions` row and update that
balance in the same database transaction. No page awards points yet.

The report header lists the filters in effect (sponsor, driver, dates, sort,
result count). Columns sort by clicking their headers, results page at 25 rows,
and a chart above the table shows net points per day (bars) with a running
total (line) for the filtered range. The CSV always exports every filtered row
in the on-screen sort order, not just the current page. When a range has no
changes the page says so explicitly rather than showing an empty table.

Sample data: `npm run db:seed:points` creates a second demo driver
(`driver2` / `DriverPass2!`, approved under Demo Sponsor) and inserts point
changes for both demo drivers over the last 60 days. It skips drivers that
already have history, so it is safe to rerun.

## Sponsor fee report and the purchases table (story AD-11)

Admins open **Reports -> Sponsor fees** (`/reports/fees`) to see, for one
calendar month, each sponsor's driver purchases and the **1% fee** it owes,
rounded to the cent, with a CSV download for billing.

The figures come from the `purchases` table (migration 010): one row per
completed purchase with `driver_id`, `sponsor_id`, `description`,
`amount_cents` (dollar value in cents, so sums are exact), `points_spent`, and
`purchased_at`. Sponsors buying for a driver write these rows through
`adjustPoints()` with its `purchase` option (sprint 8), in the same transaction
as the negative `point_transactions` row and the balance update, so the fee
report, the point report, and the driver's balance all agree. Driver
self-redemption is not built yet and must do the same.

The fee itself is calculated in the database by the `sponsor_monthly_fees`
procedure (story INF-33, migration 018), so billing logic stays in one place:

```sql
CALL sponsor_monthly_fees('2026-10-01', NULL);  -- every sponsor, October 2026
CALL sponsor_monthly_fees('2026-10-01', 2);     -- one sponsor
```

It takes the first day of the month and a sponsor id or `NULL`, and returns each
sponsor's purchases, total, and fee, rounded to the cent. The page and CSV show
what it returns, and the grand total adds up the sponsors' fees. To change the
rate, put the new procedure in a new migration and in `db/schema.sql`, and update
`FEE_PERCENT` in `src/reports/routes.js`, which only labels the page. The procedure
must be on the database before any code that calls it is deployed.

Sample data: `npm run db:seed:purchases` adds purchases for the demo drivers
under Demo Sponsor spread over the last three months. It skips a sponsor that
already has purchases, so it is safe to rerun.

## Sprint 6: alert settings and sponsor removal

Apply `db/migrations/015_driver_alert_preferences.sql` to the app database before
using these features. This adds tables without changing existing memberships or points.

Drivers can open **My points → Alert settings** to disable or enable addition and
deduction alerts. Alerts default to enabled and the setting persists across logins.
Disabled alerts are hidden; enabling them again shows undismissed changes.
Point history and balances are unaffected by the setting.

Sponsors can use **Adjust points → Remove a driver**, then confirm the removal.
The existing admin membership-removal screen also creates the same required alert.
Removing one sponsor leaves other memberships and point history intact. Removal
and notification are saved together. Drivers see the sponsor name and removal date
even with point alerts disabled, and can acknowledge the message after reading it.

Check with a test driver: disable point alerts, add/deduct points, and verify that
history and balance still change but point alerts are hidden. Re-enable to see them.
Disable again, remove that driver using the sponsor or admin screen, then log in as
the driver and verify the required removal message. Acknowledge it and refresh.

Testing story 23 was already covered in `tests/point-adjustments.test.js` (awards,
deductions, history and balance writes, ownership, validation, and rollback).
Sprint 6 extends those tests for preferences and adds membership-removal alert tests.

## Sprint 5: driver point updates

Apply `db/migrations/011_point_alerts.sql` to the application's database before
using the new point controls (or use `npm run db:migrate` for all migrations).
Deployment does not apply this migration automatically.

Sponsors can open **Adjust points**, select one of their drivers, and enter a
signed whole-number adjustment and reason. The history entry and current balance
are saved in one transaction. Negative balances are allowed; no zero-floor rule
has been specified. Existing balances and sample history are not reset.

Additions and deductions also create an in-app alert showing the amount, sponsor,
reason, date (UTC), and a link to that history entry. Drivers see it when opening
or refreshing a page, until they dismiss it. Old sample history does not generate
alerts, and there is no email or background polling.

To check: note a driver's balance, add 25 points as their sponsor, then sign in
as the driver and check the alert, history, and balance. Dismiss the alert and
refresh to confirm it stays dismissed. Deduct 10 points as the sponsor and check
that the driver's balance is now 15 above the starting balance, with a -10 history
entry and a new points-deducted alert.

## Sales by Sponsor report (stories AD-25 to AD-29)

Admins open **Reports -> Sales by sponsor** (`/reports/sales`) to review driver
purchases from the `purchases` table. Choose **Summary** for one row per sponsor
(number of sales, total dollars, points spent, with a grand total row) or
**Detailed** for one row per purchase (date, sponsor, driver, item, amount,
points spent). Filter by all sponsors or one, and by a date range with quick
ranges; the header strip states the filters, version, and sort in effect.
Columns sort by clicking their headers, results page at 25 rows, and the CSV
exports every filtered row for the chosen version in the on-screen sort,
ending with the grand total row. Sponsors and drivers get the denied-access page.

Sample data: `npm run db:seed:sales` adds a second sponsor (Northstar Freight,
sponsor user `sponsor2` / `SponsorPass2!`, driver `driver3` / `DriverPass3!`)
and more purchases for both sponsors. Run it after the points and purchases
seeds. It skips anything that already exists.

Charts (stories AD-30 and AD-31): both versions show the sales totals by sponsor,
largest first, and sales dollars over time, by day for up to a month, by week for
up to six months, then by month. They cover every filtered row, not the current
page, and redraw with the filters. A sponsor with no sales in the range is left
out of the first chart, and when only one sponsor has sales its total is shown as
a figure, since a single bar compares nothing. Each chart has hover and keyboard
tooltips and a **Show this chart as a table** link. They are inline SVG with no
library; `src/reports/charts.js` does the arithmetic.

## Sales by Driver report (stories AD-32 to AD-34)

Admins open **Reports -> Sales by driver** (`/reports/sales-by-driver`). **Summary**
has one row per driver with a purchase: the sponsors those purchases were with,
number of sales, total dollars, points spent, and last purchase, plus a grand
total row. **Detailed** has one row per purchase. Filter by **All Sponsors** or one,
**All Drivers** or one, and a date range with quick ranges. The driver list narrows
to the chosen sponsor after **Apply**, and a driver left selected from another
sponsor is dropped with a message saying so. The rest matches Sales by Sponsor:
the filter summary, sortable columns, 25-row pages, the loading indicator, the
empty message, both charts (the top 10 drivers, with the rest folded into one
bar), and a CSV of every filtered row in the on-screen version and sort.

A driver can belong to several sponsors. The totals read the `purchases` table and
never join `driver_sponsors`, so a driver with two sponsors is one row with each
purchase counted once, and past purchases stay on the report after a sponsorship
is removed. Choosing a sponsor counts only the purchases made with that sponsor.

When nothing matches (story AD-39), the message names the chosen driver with their
own capitalization, for example "Theo Trucker has no sales with Demo Sponsor from
2026-10-01 to 2026-10-31.", followed by a line saying the report ran successfully.
With no driver chosen it says "No sales ... for these filters." Versions (AD-36),
the date range (AD-35), the fields per version (AD-37), and the CSV (AD-38) are the
features described above.

## Invoices (story AD-40)

Admins open **Reports -> Invoices** (`/reports/invoices`). It defaults to the last
complete month, the one being billed, and lists every sponsor with an invoice
number, purchases, purchase total, and amount due, plus a CSV. The current month
is marked as not final. The Sponsor fees page links each row to its invoice.

Each invoice (`/reports/invoices/<sponsor id>?month=YYYY-MM`) is a printable bill:
invoice number `INV-YYYYMM-<sponsor id>`, billing period, issue date (the first
day after the month, or today while the month is in progress), the sponsor's name,
address, email, and phone, one line per purchase (date, driver, item, points,
amount), the purchase subtotal, the 1% program fee, and the amount due.
**Print or save as PDF** prints just the invoice, without the site's header and
buttons. A CSV of the lines is offered too.

The fee and totals come from `CALL sponsor_monthly_fees('<month>-01', <sponsor id>)`,
so an invoice always matches the Sponsor fees page. The line items are read
separately over the same dates. If a purchase lands between the two reads and
they disagree, the invoice says so instead of printing a wrong bill. Invoices
are not stored; each one is built from the purchases when it is opened. Admins
only for now.

## Health check (story INF-10)

`GET /health` is public and tells the team whether the web service is running and
can reach the database. It runs `SELECT 1` and answers in JSON with no session:

| Situation | Status | Body |
|---|---|---|
| Database answers | 200 | `{"status":"ok","app":"ok","database":"ok"}` |
| Database is down, or silent for 3 seconds | 503 | `{"status":"unavailable","app":"ok","database":"unavailable"}` |

The reason for a failure goes to the server log only, never into the response.
Set `HEALTH_DB_TIMEOUT_MS` to change the wait. The deploy's smoke test requests
this page. The Beanstalk health check URL is deliberately left blank: a database
problem should not mark a working web server as unhealthy.

## Bulk upload (requirement change RC#1)

Admins open **Users -> Bulk upload** (`/admin/bulk-upload`) and upload a
pipe-delimited text file. The format lives in ONE place, the `FORMAT` object at
the top of `src/bulk/parser.js`; the upload page, the sample file, and the
tests follow it. Current layout, no header line, bracketed fields optional:

```
O|organization name
S|organization name|first name|last name|email
D|organization name|first name|last name|email|[points]|[reason]
```

Rules: an `O` row creates the organization so later rows can use it; a row
naming an organization that does not exist and was not created earlier in the
file is skipped; points without a reason (or a reason without points) is an
error; there is no row type for admin users. Every bad row is reported with its
line number and skipped, and processing continues. New users get an
unguessable password plus the existing setup link, shown on the results page
and written to the mail log. Points on a `D` row go through the shared point
adjustment, so the `point_transactions` row, the balance, and the driver alert
are written together.

The file is streamed and processed line by line (`busboy`), so there is no size
limit in the app, and `.platform/nginx/conf.d/upload-size.conf` lifts the
Elastic Beanstalk proxy's 1 MB default. Organizations created from an `O` row
get placeholder contact details until a sponsor edits them. The sponsor-side
upload (Ford and Fernando) reuses `src/bulk/parser.js` and `src/bulk/loader.js`
with a sponsor-scoped actor, which refuses `O` rows and other organizations.

Sample file: `docs/bulk-upload-sample.txt` (also downloadable from the page).

## Multiple sponsors per driver (requirement change RC#2)

Migration 014 changes the `driver_sponsors` key to `(driver_id, sponsor_id)`,
so a driver can belong to several sponsors, each with its own point balance.
Admins open **Manage users -> Sponsors** on a driver row to see every
sponsorship, add one, or remove one (confirmed first) while leaving the rest in
place. Removing a sponsorship deletes that balance; the point history stays in
`point_transactions`. The sponsor approval flow still creates a membership on
approval; its "one sponsor at a time" message now only applies to the same
sponsor twice.

## Deployment (GitHub Actions to AWS Elastic Beanstalk) (story INF-06)

The app runs on AWS Elastic Beanstalk (application `gooddriver`, environment
`team13-gooddriver`, Node.js 22, region `us-east-1`, one instance) and uses the
team's MySQL database on RDS. Any teammate with write access to this repository
can deploy by following these steps. Nobody needs to deploy from their own
computer.

### Deploying a change

1. **Run any database change first** (see the next section), if the change has
   one. A deploy never touches the database.
2. **Open a pull request into `master`.** Pull requests do not deploy anything
   and do not run the workflow, so run `npm run test-run` on your branch before
   asking for a merge.
3. **Merge it.** Every push or merge to `master` starts the deploy on its own.
4. **Watch it in the Actions tab.** On GitHub, open **Actions**, then the newest
   **Test and deploy** run. It has two jobs:
   - **Test** runs `npm ci` and the full test suite. If a test fails, nothing
     reaches AWS.
   - **Deploy to Elastic Beanstalk** zips the commit with `git archive`, uploads
     it, registers an application version named `gh-<commit>-<run>.<attempt>`,
     updates the environment, waits for it to be Ready on that version, and then
     smoke tests the live `/health` page. A 200 there means the new code is
     serving requests and can reach the database.
5. **Check the result.** A green run means the site is live on your commit. Open
   `/health` on the live site and expect `{"status":"ok","app":"ok","database":"ok"}`.
   With only one instance, the site can be briefly unavailable during an update.

Only one deploy runs at a time. A second merge waits for the running one instead
of overlapping it, and if several pile up, GitHub keeps only the newest.

**Deploying without a new commit:** on GitHub, open **Actions**, choose
**Test and deploy** in the list on the left, click **Run workflow**, choose
branch `master`, and click the green **Run workflow** button. Use it to redeploy
what is already on `master`, such as after changing an AWS secret. It runs the
tests either way, but only `master` is ever deployed: starting it from another
branch tests that branch and stops.

### Database changes come first, and on RDS

A deploy does not apply migrations, so new code that needs a new table, column,
or procedure fails if it reaches the site before the database has it.

1. Put the change in a new numbered file in `db/migrations/`, written so it is
   safe to rerun, and make the same change in `db/schema.sql`.
2. Get the team's OK. RDS is shared, so a change there affects everyone at once.
3. With your `.env` pointing at RDS, run:
   ```bash
   npm run db:migrate
   ```
   It applies every migration file in order and prints each one. It is safe to
   repeat, because each file checks before it acts. Migration 008, which filled
   memberships from approved applications once, is skipped once the table exists
   so that it cannot bring back sponsorships an admin has removed. It only runs
   on a database that has no `driver_sponsors` table yet, so a very old local
   database that runs `npm run db:setup` first, which creates that table empty,
   needs the backfill run by hand from that file.
4. Check the change is there, then merge the code.

Keep the change additive while the old code is still live, because the running
site must keep working until the deploy finishes. To remove or rename something,
deploy the code that stops using it first, and change the database after.

### Secrets and settings

No secrets are stored in the repository or the bundle. `.env` is gitignored, and
the workflow refuses to deploy if an env file is ever committed.

- **AWS access** comes from the repository secrets `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`, under **Settings -> Secrets and variables -> Actions**
  on GitHub. Changing them needs owner or admin access to the repository. They
  are not available to pull requests, so code from a fork can never reach them. If they
  are replaced, redeploy with **Run workflow** to confirm the new ones work.
- **Database and session settings** live on the Beanstalk environment, not in
  code: in the AWS console, open the environment, then **Configuration -> Updates,
  monitoring, and logging -> Environment properties**. Changing one restarts the
  app, which is the only step needed.
- **Upload size:** `.platform/nginx/conf.d/upload-size.conf` lifts the proxy's
  1 MB default for bulk uploads and ships with every deploy.

### If a deploy fails

Open the failed run in the Actions tab and find the first red step. Then check
what the site is actually running, because a failure does not always mean the
old version is still live:

```bash
aws elasticbeanstalk describe-environments --application-name gooddriver \
  --environment-names team13-gooddriver --region us-east-1 \
  --query 'Environments[0].[Status,Health,VersionLabel]' --output text
```

| Red step | What it means | What to do |
|---|---|---|
| **Run the full test suite** | A test failed. AWS was not touched and the site is unchanged. | Fix it on a branch and merge again. |
| **Build the deploy bundle** | An env file was committed. Nothing was uploaded. | Remove the file from git and change every secret that was in it, since it is in the history. |
| **Configure AWS credentials** | The AWS secrets are wrong or expired. The site is unchanged. | Replace them as described above, then use **Run workflow**. |
| **Upload the bundle** or **Deploy the version** | AWS refused the version, the update failed, or it did not finish within about 20 minutes. | Read the events the step printed, or the environment's **Events** and **Logs -> Request logs** pages in the AWS console. If the problem was temporary, use **Re-run jobs** on the run. |
| **Smoke test the live health check** | The new version is live, but `/health` did not answer 200. **The site may be down.** | Open `/health` yourself. A 503 means the app is up but cannot reach the database, so check RDS and the environment properties. No answer means the app did not start, so read the logs. Roll back if it will take a while. |

**To roll back,** pick whichever is quicker:

- **Redeploy the last good version.** In the AWS console open the application's
  **Application versions** page, select the previous `gh-...` version, and click
  **Deploy**. The same thing from the command line:
  ```bash
  aws elasticbeanstalk update-environment --environment-name team13-gooddriver \
    --region us-east-1 --version-label <previous-version-label>
  ```
- **Revert the merge on GitHub.** Merging the revert into `master` runs the
  normal tests and deploy, and it also keeps the code on `master` matching the
  site. If you rolled back with the first option, do this as well, or the next
  deploy brings the problem back.

Rolling back does not undo a database change. That is another reason to keep
changes additive, so the old code still runs against the new database.
