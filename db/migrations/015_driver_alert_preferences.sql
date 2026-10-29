CREATE TABLE IF NOT EXISTS driver_alert_preferences (
  driver_id INT PRIMARY KEY,
  point_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (driver_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sponsor_removal_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  driver_id INT NOT NULL,
  sponsor_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_removal_alert_driver (driver_id, acknowledged_at),
  FOREIGN KEY (driver_id) REFERENCES users(id)
);
