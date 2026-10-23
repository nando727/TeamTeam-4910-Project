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

## Signing out of all sessions (story AA-13)

**Profile → Sign out of all sessions** ends the account's session on every
browser and device, including the one that asked. Other devices land on the
login page with an explanation the next time they ask for a page.

Sessions are held in memory, so there is no list of them to delete — express's
default store cannot be asked "which sessions belong to this user?". Instead
each session records when it was issued, and the account carries a cutoff in
`users.sessions_valid_from`. Signing out everywhere just stamps that column with
the current time; `src/auth/session-revocation.js` then refuses any session
issued before it. That reaches sessions this request never touches, on any
server instance, and it outlives a restart because the cutoff is in the database.

The cost is one indexed lookup per signed-in request. Signed-out requests, the
login page included, do not query at all.

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

Five failed sign-ins lock an account for 15 minutes. Only failures **since your
last successful sign-in** count, so signing in successfully clears the tally.
While locked, the correct password is refused too — that is the point — and the
message says how many minutes remain. Every blocked attempt is still recorded in
`login_attempts`.

The lock is worked out from that audit table, so there is nothing to reset by
hand and it expires on its own. Set `LOGIN_MAX_FAILURES` and
`LOGIN_LOCKOUT_MINUTES` in `.env` to change the policy; `LOGIN_LOCKOUT_MINUTES=1`
makes it easy to demonstrate.

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
New memberships start with 0 points. Rerunning the migration preserves balances.
A driver can belong to one sponsor at a time. The migration stops if a driver
already has multiple approved applications, so those decisions can be resolved
without silently choosing a sponsor. `users.sponsor_id` continues to identify
the organization managed by a sponsor-role account.

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
`purchased_at`. **No catalog or redemption page exists yet.** Whoever builds
driver redemption must insert a `purchases` row for every completed purchase,
in the same database transaction as the matching negative `point_transactions`
row and the `driver_sponsors.point_balance` update, so the fee report, the point
report, and the driver's balance all agree.

Sample data: `npm run db:seed:purchases` adds purchases for the demo drivers
under Demo Sponsor spread over the last three months. It skips a sponsor that
already has purchases, so it is safe to rerun.

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

## Deployment (GitHub Actions to AWS Elastic Beanstalk)

The app is hosted on AWS Elastic Beanstalk (application `gooddriver`,
environment `team13-gooddriver`, Node.js 22, region `us-east-1`) and reads from
the team's MySQL database on RDS.

Every push or merge to `master` runs `.github/workflows/deploy.yml`:

1. **Test** - `npm ci`, then the full suite with `npm run test-run`.
2. **Deploy** - only if every test passed. The workflow zips the commit with
   `git archive`, uploads it to Beanstalk's S3 bucket, registers it as a new
   application version (`gh-<commit>-<run>`), updates the environment, and waits
   until it is Ready on that version.
3. **Smoke test** - requests the live `/about` page, which reads from the
   database, and fails the run unless it returns 200.

Things to know:

- **No secrets are deployed or stored in the repo.** `.env` is gitignored, so it
  is never in the bundle, and the workflow refuses to deploy if an env file is
  ever committed. Database and session settings are set on the Beanstalk
  environment (Configuration -> Updates, monitoring, and logging -> Environment
  properties). Change them there, not in code.
- **AWS access** comes from the repository secrets `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`. Pull requests do not trigger the workflow.
- **One deploy at a time.** A second push waits for the running deploy to
  finish instead of overlapping it.
- **Redeploy without pushing:** GitHub -> Actions -> "Test and deploy" ->
  Run workflow -> branch `master`.
- **If a deploy fails**, Beanstalk keeps serving the previous version. Open the
  failed run in the Actions tab to see which step failed; a failed test never
  reaches AWS.
- Database schema changes are not applied by a deploy. Run new migrations
  against RDS separately, after the team agrees.
