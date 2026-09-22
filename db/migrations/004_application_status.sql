-- Driver application status. Existing submissions start as pending.
-- Check each column so db:migrate can safely run more than once.
SET @application_status_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsor_applications' AND COLUMN_NAME = 'status'
);
SET @application_status_sql := IF(
  @application_status_exists = 0,
  "ALTER TABLE sponsor_applications ADD COLUMN status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending'",
  'SELECT 1'
);
PREPARE application_status_stmt FROM @application_status_sql;
EXECUTE application_status_stmt;
DEALLOCATE PREPARE application_status_stmt;

SET @application_reason_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsor_applications' AND COLUMN_NAME = 'rejection_reason'
);
SET @application_reason_sql := IF(
  @application_reason_exists = 0,
  'ALTER TABLE sponsor_applications ADD COLUMN rejection_reason VARCHAR(2000) NULL',
  'SELECT 1'
);
PREPARE application_reason_stmt FROM @application_reason_sql;
EXECUTE application_reason_stmt;
DEALLOCATE PREPARE application_reason_stmt;
