# PR note: the sponsor Drivers page now reads points from the membership

One change was made to a page Ford owns (`/drivers`, the sponsor's "Your
Drivers" page). Nothing else of his was touched: the application approval
code, the driver edit and status forms, and the delete action are all exactly
as they were.

## What changed

`listDriversForSponsor` in `src/sponsors/accounts.js` now reads each driver's
point balance from `driver_sponsors.point_balance` instead of `users.balance`.

```
- SELECT u.id, u.name, u.email, u.username, u.status, u.balance
+ SELECT u.id, u.name, u.email, u.username, u.status, ds.point_balance AS balance
```

The two balance filters on that page changed with it, so "Balance from / to"
now compares the same number the column shows:

```
- u.balance >= ?   /   u.balance <= ?
+ ds.point_balance >= ?   /   ds.point_balance <= ?
```

The result is still called `balance`, so `src/views/sponsor/drivers.ejs` and
every caller are unchanged.

## Why

* **`users.balance` is not in our schema.** It is not in `db/schema.sql` and
  no migration creates it. It exists on the shared RDS database only, added
  by hand at some point. A database built from this repository with
  `npm run db:setup` has no such column, so the Drivers page could only fail
  there with `Unknown column 'u.balance'`.
* **One number per driver is the wrong shape.** A driver can belong to several
  sponsors (RC#2, migration 014), and points are held per membership. A single
  column on the user cannot say how many points a driver holds *with this
  sponsor*, which is what this page is asking.
* **Everything else already uses the membership.** The point adjustment form,
  the catalog purchase, the driver's own "My points" page, the point report,
  and the new driver cart all read and write `driver_sponsors.point_balance`.
  This page was the only thing reading a different number, so it could
  disagree with all of them.

## What to check

Sign in as a sponsor user and open **Your drivers**: each driver's balance
should match what the same driver shows on the Driver point report and on
their own "My sponsor and points" page. Filtering by "Balance from / to"
should narrow the list by that same number.

## Not included

The stray `users.balance` column on RDS was left in place, along with the
`products` and `sponsor_catalog` tables that are also on RDS but in no
migration. Nothing in `src/` reads any of them now. Dropping them is a
separate decision for the team.
