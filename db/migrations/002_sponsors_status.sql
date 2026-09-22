-- Adds a status column to sponsor organizations so admins can see which are
-- active. Runs after 001 (via `npm run db:migrate`). Safe to rerun: MySQL has
-- no ADD COLUMN IF NOT EXISTS, so the ALTER only runs when the column is
-- missing. Existing sponsors default to 'active'.

SET @sponsors_status_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'status'
);
SET @sponsors_status_sql := IF(
  @sponsors_status_exists = 0,
  "ALTER TABLE sponsors ADD COLUMN status ENUM('active', 'inactive') NOT NULL DEFAULT 'active'",
  'SELECT 1'
);
PREPARE sponsors_status_stmt FROM @sponsors_status_sql;
EXECUTE sponsors_status_stmt;
DEALLOCATE PREPARE sponsors_status_stmt;
