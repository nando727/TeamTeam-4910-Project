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

Sample data: `npm run db:seed:points` creates a second demo driver
(`driver2` / `DriverPass2!`, approved under Demo Sponsor) and inserts point
changes for both demo drivers over the last 60 days. It skips drivers that
already have history, so it is safe to rerun.

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
