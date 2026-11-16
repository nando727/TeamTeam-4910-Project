-- Sprint 9: an audit log of what administrators do to accounts.
--
-- The app already audits two specific things: every sign-in attempt
-- (login_attempts) and every password change (password_changes). Neither
-- covers "an administrator changed this account", which is the question asked
-- when somebody's role or access is suddenly different from what they expect.
-- Role changes in particular delete rows -- sponsorships, applications,
-- preferences -- and without a record there is nothing left to say who did it
-- or what went with it.
--
-- One row per action. `action` is a short fixed word the app chooses, never
-- user text, so the page can group and filter on it. `detail` is a sentence
-- for a human: what changed, and what was removed with it. Nothing secret
-- goes in it -- no passwords, no tokens, no reset links -- for the same
-- reason password_changes holds no hash: an audit log read by administrators
-- must not double as a pile of material worth stealing.
--
-- Both user columns are nullable and keep their foreign keys: an action is
-- still worth having after one of the accounts is deleted, and MySQL would
-- otherwise refuse the delete. The app passes the ids it knows.
--
-- Runs after 021 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS admin_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- The administrator who did it. NULL only if that account is later removed.
  admin_user_id INT NULL,
  -- The account it was done to. NULL for an action that is not about one.
  target_user_id INT NULL,
  action VARCHAR(32) NOT NULL,
  detail VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The log is read newest first, and filtered by account or by action.
  INDEX idx_admin_actions_created (created_at),
  INDEX idx_admin_actions_target (target_user_id, created_at),
  FOREIGN KEY (admin_user_id) REFERENCES users(id),
  FOREIGN KEY (target_user_id) REFERENCES users(id)
);
