-- Minimal schema for the auth stories. The full schema (sponsors, points,
-- applications, catalog) is still unowned — see the team decisions log.
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
