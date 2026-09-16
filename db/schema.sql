-- Authentication and driver sponsor applications.
-- Runs against local MySQL now; point it at RDS later by changing .env.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('driver', 'sponsor', 'admin') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Audit log: every login attempt (graded requirement).
CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  username VARCHAR(64) NOT NULL,
  success BOOLEAN NOT NULL
);

-- Organizations are separate from individual sponsor user accounts.
CREATE TABLE IF NOT EXISTS sponsors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL UNIQUE,
  contact_phone VARCHAR(32) NULL,
  address VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sponsor_applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  full_name VARCHAR(128) NOT NULL,
  contact_email VARCHAR(254) NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_driver_sponsor (driver_id, sponsor_id),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);
