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
  -- Sessions issued before this are refused; see migrations 012 and 013.
  -- Milliseconds matter: a revocation can land in the same second as a login.
  sessions_valid_from DATETIME(3) NULL,
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
  success BOOLEAN NOT NULL,
  -- Where the attempt came from, so a lockout can count per origin as well as
  -- per username (migration 015). NULL when it could not be determined.
  source_ip VARCHAR(45) NULL,
  INDEX idx_login_attempts_username_source (username, source_ip, attempted_at)
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
  PRIMARY KEY (driver_id, sponsor_id),
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

-- Point history (see migration 009). driver_sponsors.point_balance is the
-- current total; every award or deduction writes a row here and updates it.
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

-- Dismissible alerts for changes saved through the point adjustment form.
CREATE TABLE IF NOT EXISTS point_alerts (
  transaction_id INT PRIMARY KEY,
  dismissed_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (transaction_id) REFERENCES point_transactions(id) ON DELETE CASCADE
);

-- Driver purchases made with points (see migration 010). The admin fee report
-- bills each sponsor 1% of its drivers' purchases per month, so the catalog and
-- redemption flow must insert one row here per completed purchase.
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

CREATE TABLE IF NOT EXISTS rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sponsor_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description VARCHAR(2000) NOT NULL,
  points INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);
-- Signed-in sessions (see migration 016). Kept in the database rather than in
-- the Node process so a deployment does not sign everyone out.
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Administrator unlocks (see migration 017). The lockout counts failures since
-- the last success or unlock, whichever is later, so clearing a lock adds a
-- record instead of deleting attempts from the audit log.
CREATE TABLE IF NOT EXISTS login_unlocks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  unlocked_by INT NULL,
  unlocked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_unlocks_username (username, unlocked_at),
  FOREIGN KEY (unlocked_by) REFERENCES users(id)
);

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
