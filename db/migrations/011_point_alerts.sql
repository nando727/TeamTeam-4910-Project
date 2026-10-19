-- Only new adjustments create alerts; existing sample history is left alone.
CREATE TABLE IF NOT EXISTS point_alerts (
  transaction_id INT PRIMARY KEY,
  dismissed_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (transaction_id) REFERENCES point_transactions(id) ON DELETE CASCADE
);
