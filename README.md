README

# TeamTeam 4910 Project Repository

* Members
  * Fernando Tello
  * Ford Scott
  * Alec Brinkley
  * Mir Patel

## Stack

Node.js + Express + EJS (server-rendered pages), MySQL via `mysql2`,
`bcryptjs` for password hashing, `express-session` for sessions,
Jest + supertest for automated tests.

## Getting started

1. Install [Node.js](https://nodejs.org) (v20+) and MySQL Community Server.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your local MySQL values
   (for local dev: `DB_HOST=localhost`, `DB_NAME=gooddriver`, your own
   `DB_USER`/`DB_PASSWORD`, any random string for `SESSION_SECRET`).
4. `npm run db:setup` — creates the database and tables
5. `npm run db:seed` — creates demo users (driver1 / sponsor1 / admin1)
6. `npm run dev` — starts the app at http://localhost:3000

## Tests

`npm test` — no database needed; the db layer is mocked.

## Project rules (short version)

* Never commit `.env` or any real credentials.
* All SQL goes through `src/db.js` with `?` placeholders — no string-built SQL.
* All password hashing goes through `src/auth/password.js`.
