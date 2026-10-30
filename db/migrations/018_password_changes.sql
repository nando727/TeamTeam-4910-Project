-- Audit log requirement: password changes are recorded, alongside login
-- attempts, point changes and driver application decisions.
--
-- login_attempts covered sign-ins from the start, but nothing recorded that a
-- password had been set. An administrator's reset, a visitor using a reset
-- link and someone changing their own password all left the same trace: none.
-- password_resets is not that record either -- it holds reset tokens, so it
-- says a link was requested, not that a password was ever changed.
--
-- No password and no hash goes in here. The row says whose password changed,
-- who changed it, how, and when.
--
-- Runs after 017 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS password_changes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Whose password it was.
  user_id INT NOT NULL,
  -- Who did it: the account itself, an administrator, or the administrator
  -- behind an impersonated session. NULL when nobody was signed in, which is
  -- the case for a reset link and for claiming an account with a setup link.
  changed_by_user_id INT NULL,
  -- Which route set it: profile, admin-reset, reset-link, setup-link. VARCHAR
  -- rather than ENUM so a new path does not need a migration to be auditable.
  method VARCHAR(32) NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_password_changes_user (user_id, changed_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);
