-- A driver may belong to more than one sponsor (requirement change RC#2).
-- The membership key becomes (driver_id, sponsor_id) instead of driver_id
-- alone. Runs after 013 (via `npm run db:migrate`). Safe to rerun: the ALTER
-- only runs while the primary key is still the single column.

SET @single_key := (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'driver_sponsors' AND CONSTRAINT_NAME = 'PRIMARY'
);
SET @multi_sql := IF(
  @single_key = 1,
  'ALTER TABLE driver_sponsors DROP PRIMARY KEY, ADD PRIMARY KEY (driver_id, sponsor_id)',
  'SELECT 1'
);
PREPARE multi_stmt FROM @multi_sql;
EXECUTE multi_stmt;
DEALLOCATE PREPARE multi_stmt;
