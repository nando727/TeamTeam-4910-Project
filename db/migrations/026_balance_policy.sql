-- Sponsors choose what happens to a driver's points when the driver leaves.
-- Safe to rerun (npm run db:migrate runs every file every time).
SET @has_policy = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'balance_policy');
SET @ddl = IF(@has_policy = 0,
  'ALTER TABLE sponsors ADD COLUMN balance_policy ENUM(''forfeit'', ''hold'') NOT NULL DEFAULT ''forfeit''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Points set aside for a driver who left a sponsor that uses the 'hold' policy.
CREATE TABLE IF NOT EXISTS held_balances (
  driver_id  INT NOT NULL,
  sponsor_id INT NOT NULL,
  points     INT NOT NULL,
  PRIMARY KEY (driver_id, sponsor_id),
  FOREIGN KEY (driver_id)  REFERENCES users (id)    ON DELETE CASCADE,
  FOREIGN KEY (sponsor_id) REFERENCES sponsors (id) ON DELETE CASCADE
);