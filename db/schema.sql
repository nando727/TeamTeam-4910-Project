-- Authentication and driver sponsor applications.
-- Runs against local MySQL now; point it at RDS later by changing .env.

-- Organizations are separate from individual sponsor user accounts. Defined
-- first because users.sponsor_id references it.
CREATE TABLE IF NOT EXISTS sponsors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL UNIQUE,
  contact_phone VARCHAR(32) NULL,
  address VARCHAR(255) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('driver', 'sponsor', 'admin') NOT NULL,
  status ENUM('active', 'disabled', 'revoked') NOT NULL DEFAULT 'active',
  -- Sponsor-role users act for one organization (see migration 007).
  sponsor_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_sponsor FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- Audit log: every login attempt (graded requirement).
CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  username VARCHAR(64) NOT NULL,
  success BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS sponsor_applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  full_name VARCHAR(128) NOT NULL,
  contact_email VARCHAR(254) NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(2000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_driver_sponsor (driver_id, sponsor_id),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- Each approved driver belongs to one sponsor and starts with zero points.
CREATE TABLE IF NOT EXISTS driver_sponsors (
  driver_id INT NOT NULL,
  sponsor_id INT NOT NULL,
  point_balance INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (driver_id),
  FOREIGN KEY (driver_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- Story 22255: single-use setup links for newly created accounts. Only the
-- SHA-256 hash of the token is stored, never the raw value.
CREATE TABLE IF NOT EXISTS setup_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One-time password reset links (hash of the token only; see migration 006).
CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_password_resets_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
