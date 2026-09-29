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

This covers viewing decisions; sponsor decision controls and email notifications
are not included. To test locally in Workbench, find your test application ID:

```sql
SELECT id, driver_id, sponsor_id, status FROM gooddriver.sponsor_applications;
```

Replace `123` below with that test application's ID and run one update at a time:

```sql
UPDATE gooddriver.sponsor_applications
SET status = 'approved', rejection_reason = NULL WHERE id = 123;

UPDATE gooddriver.sponsor_applications
SET status = 'rejected', rejection_reason = 'We are not accepting new drivers at this time.'
WHERE id = 123;

UPDATE gooddriver.sponsor_applications
SET status = 'pending', rejection_reason = NULL WHERE id = 123;
```

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
