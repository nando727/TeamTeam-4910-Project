-- Backlog AA-13: give the revocation cutoff millisecond precision.
--
-- Migration 012 added this as a plain DATETIME, which keeps whole seconds. A
-- session issued at 20:30:45.300 and revoked at 20:30:45.800 then stores a
-- cutoff of 20:30:45, which compares as EARLIER than the session it is meant
-- to end — so the session survived its own revocation. DATETIME(3) keeps
-- milliseconds, which is finer than two requests can be apart.
--
-- Runs after 012 (via `npm run db:migrate`). Safe to rerun: the ALTER only
-- runs when the column is not already DATETIME(3). Existing values are kept.

SET @needs_ms := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'sessions_valid_from' AND DATETIME_PRECISION <> 3
);
SET @needs_ms_sql := IF(
  @needs_ms = 1,
  'ALTER TABLE users MODIFY COLUMN sessions_valid_from DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE needs_ms_stmt FROM @needs_ms_sql;
EXECUTE needs_ms_stmt;
DEALLOCATE PREPARE needs_ms_stmt;
