-- Driver memberships are separate from users.sponsor_id, which identifies
-- the organization a sponsor-role user manages. A driver can join one sponsor.
CREATE TABLE IF NOT EXISTS driver_sponsors (
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  point_balance INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (driver_id),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- Include already-approved drivers without overwriting existing balances.
INSERT INTO driver_sponsors (driver_id, sponsor_id)
SELECT a.driver_id, a.sponsor_id FROM sponsor_applications a
JOIN users u ON u.id = a.driver_id AND u.role = 'driver'
WHERE a.status = 'approved'
ON DUPLICATE KEY UPDATE driver_id = driver_sponsors.driver_id;
