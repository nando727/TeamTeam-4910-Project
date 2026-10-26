-- Story AA-70: record where a sign-in attempt came from.
--
-- Until now login_attempts held only the date, the username and whether it
-- worked, so the lockout could only count failures per username. That let
-- anyone who knew a username keep that account locked at will: the account was
-- the thing being punished, not the attempt. Keeping the source lets a later
-- change count failures per username and origin instead.
--
-- 45 characters is the longest an IPv6 address can be in text form. NULL is
-- allowed: an attempt whose origin cannot be determined must still be audited.
--
-- Runs after 014 (via `npm run db:migrate`). Safe to rerun: MySQL has no
-- ADD COLUMN IF NOT EXISTS, so the ALTER only runs when the column is missing.

SET @login_source_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_attempts' AND COLUMN_NAME = 'source_ip'
);
SET @login_source_sql := IF(
  @login_source_exists = 0,
  'ALTER TABLE login_attempts ADD COLUMN source_ip VARCHAR(45) NULL',
  'SELECT 1'
);
PREPARE login_source_stmt FROM @login_source_sql;
EXECUTE login_source_stmt;
DEALLOCATE PREPARE login_source_stmt;

-- The lockout will look up failures by username and source together.
SET @login_source_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'login_attempts' AND INDEX_NAME = 'idx_login_attempts_username_source'
);
SET @login_source_index_sql := IF(
  @login_source_index = 0,
  'CREATE INDEX idx_login_attempts_username_source ON login_attempts (username, source_ip, attempted_at)',
  'SELECT 1'
);
PREPARE login_source_index_stmt FROM @login_source_index_sql;
EXECUTE login_source_index_stmt;
DEALLOCATE PREPARE login_source_index_stmt;
