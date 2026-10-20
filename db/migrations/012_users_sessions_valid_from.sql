-- Signing out of every session at once (backlog AA-13).
--
-- Sessions live in memory, so there is no list of them to delete. Instead each
-- session records when it was issued, and anything issued before this
-- timestamp is refused. Setting it to NOW() ends every session for that
-- account, on every device and every server instance.
--
-- Runs after 011 (via `npm run db:migrate`). Safe to rerun: MySQL has no
-- ADD COLUMN IF NOT EXISTS, so the ALTER only runs when the column is missing.
-- NULL means "nothing has been revoked", so existing sessions keep working.

SET @sessions_valid_from_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'sessions_valid_from'
);
SET @sessions_valid_from_sql := IF(
  @sessions_valid_from_exists = 0,
  'ALTER TABLE users ADD COLUMN sessions_valid_from DATETIME NULL',
  'SELECT 1'
);
PREPARE sessions_valid_from_stmt FROM @sessions_valid_from_sql;
EXECUTE sessions_valid_from_stmt;
DEALLOCATE PREPARE sessions_valid_from_stmt;
