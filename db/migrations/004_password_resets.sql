-- One-time password reset links for the "forgot password" flow. Runs after
-- 003 (via `npm run db:migrate`). Safe to rerun: IF NOT EXISTS.
-- Only a SHA-256 hash of the token is stored, never the token itself. A row is
-- spent once used_at is set or expires_at has passed (30 minutes after issue).

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
