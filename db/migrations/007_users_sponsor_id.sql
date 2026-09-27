-- Links a sponsor-role user to the sponsor organization they act for. The
-- sponsor homepage lists that organization's driver applications. Runs after
-- 006 (via `npm run db:migrate`). Safe to rerun: the column and the foreign
-- key are each added only when missing. Existing sponsor users start NULL and
-- must be assigned by an admin.

SET @users_sponsor_id_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'sponsor_id'
);
SET @users_sponsor_id_sql := IF(
  @users_sponsor_id_exists = 0,
  'ALTER TABLE users ADD COLUMN sponsor_id INT NULL',
  'SELECT 1'
);
PREPARE users_sponsor_id_stmt FROM @users_sponsor_id_sql;
EXECUTE users_sponsor_id_stmt;
DEALLOCATE PREPARE users_sponsor_id_stmt;

SET @users_sponsor_fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    AND CONSTRAINT_NAME = 'fk_users_sponsor' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @users_sponsor_fk_sql := IF(
  @users_sponsor_fk_exists = 0,
  'ALTER TABLE users ADD CONSTRAINT fk_users_sponsor FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)',
  'SELECT 1'
);
PREPARE users_sponsor_fk_stmt FROM @users_sponsor_fk_sql;
EXECUTE users_sponsor_fk_stmt;
DEALLOCATE PREPARE users_sponsor_fk_stmt;
