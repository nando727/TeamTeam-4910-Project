-- Point history for the Driver Point Tracking report (stories AD-18 to AD-22).
-- One row per change: positive for an award, negative for a deduction.
-- changed_by_user_id is the sponsor or admin user who made the change, NULL
-- for a future automated adjustment. driver_sponsors.point_balance stays the
-- driver's current total, so anything that awards or deducts points must insert
-- a row here and update that balance in the same transaction.
-- Runs after 008 (via `npm run db:migrate`). Safe to rerun: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS point_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  changed_by_user_id INT NULL,
  points_change INT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_point_tx_driver_date (driver_id, created_at),
  INDEX idx_point_tx_sponsor_date (sponsor_id, created_at),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id),
  FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);
