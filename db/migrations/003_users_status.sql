-- Adds a status column to user accounts so admins can disable or revoke
-- access. Runs after 002 (via `npm run db:migrate`). Safe to rerun: MySQL has
-- no ADD COLUMN IF NOT EXISTS, so the ALTER only runs when the column is
-- missing. Existing users default to 'active'.

SET @users_status_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status'
);
SET @users_status_sql := IF(
  @users_status_exists = 0,
  "ALTER TABLE users ADD COLUMN status ENUM('active', 'disabled', 'revoked') NOT NULL DEFAULT 'active'",
  'SELECT 1'
);
PREPARE users_status_stmt FROM @users_status_sql;
EXECUTE users_status_stmt;
DEALLOCATE PREPARE users_status_stmt;
