-- Story 22255: single-use setup links for newly created accounts.
-- Runs after 004 (via `npm run db:migrate`). Safe to rerun.
--
-- Only the SHA-256 hash of a token is stored, never the raw value, so a
-- database dump cannot be used to claim someone's account.

CREATE TABLE IF NOT EXISTS setup_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
