-- Additive migration for the new /api/sponsors, /api/users, and /api/about
-- routes. Run after db/schema.sql (via `npm run db:migrate`). Only adds
-- tables/columns, never touches existing ones.
--
-- Requires MySQL 8.0.29+ for `ADD COLUMN IF NOT EXISTS` (RDS default is
-- MySQL 8.0.x, so this should be safe once the DB connection is available).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS name VARCHAR(255) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL AFTER name;

CREATE TABLE IF NOT EXISTS sponsors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL UNIQUE,
  contact_phone VARCHAR(32) NULL,
  address VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS about (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_name VARCHAR(255) NOT NULL,
  app_version VARCHAR(32) NOT NULL,
  release_date DATE NOT NULL,
  description TEXT NOT NULL
);

INSERT INTO about (team_name, app_version, release_date, description)
SELECT 'F26-Team13', '1.0.0', '2026-09-15',
  'A driver incentive web app that lets sponsor companies reward truck drivers with points redeemable for products, with admin tools to manage sponsors, drivers, and applications.'
WHERE NOT EXISTS (SELECT 1 FROM about);
