-- Story AA-72: an administrator can let a locked-out user back in.
--
-- The lock is not stored anywhere: it is counted from login_attempts, as
-- "failures since the last success, within the window". So there is no flag to
-- switch off, and the two obvious ways to clear it are both wrong:
--
--   * deleting the failed attempts destroys the audit log the course spec
--     requires, and with it the evidence of what the admin was reacting to;
--   * inserting a fake successful attempt puts a lie in that same log.
--
-- Instead an unlock is its own record, and the count starts after the latest
-- one. Nothing is rewritten, the audit log keeps every attempt that really
-- happened, and the unlock itself is auditable: who did it, and when.
--
-- Keyed on the username rather than a user id because login_attempts records
-- usernames that were never real (deliberately, so a lock cannot be used to
-- discover accounts), and those can be locked too.
--
-- Runs after 016 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS login_unlocks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  -- The administrator who did it. NULL only if that account is later removed.
  unlocked_by INT NULL,
  unlocked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_unlocks_username (username, unlocked_at),
  FOREIGN KEY (unlocked_by) REFERENCES users(id)
);
