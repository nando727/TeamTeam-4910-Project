-- Driver purchases made with points (story AD-11: the 1% monthly fee each
-- sponsor owes is 1% of its drivers' purchases that month).
-- No catalog or redemption flow exists yet; whoever builds it must insert one
-- row here per completed purchase. amount_cents is the dollar value in cents
-- so sums are exact. Runs after 009 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  amount_cents INT NOT NULL,
  points_spent INT NOT NULL,
  purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_purchases_sponsor_date (sponsor_id, purchased_at),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);
