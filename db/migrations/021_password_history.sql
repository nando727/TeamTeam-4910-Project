-- Story 28211 (AA-79): a password cannot be reused. Enforcing that needs a
-- record of the ones an account has already used, and nothing in the database
-- was one. users holds only the hash in force right now, and password_changes
-- (migration 019) deliberately holds no hash at all -- an audit log read by
-- administrators should not double as a pile of material to crack.
--
-- So this table, and only this table, keeps old hashes. What that costs is
-- worth being plain about: a stolen copy is a set of bcrypt hashes someone can
-- work on offline at their leisure. Three things keep the cost small.
--   * Hashes only. No password, and no hint of one.
--   * bcrypt at cost 12, the same work factor that protects the live password,
--     because these rows are written by the same hashing helper.
--   * Bounded. The app keeps only the newest few rows per account and deletes
--     the rest as it goes (PASSWORD_HISTORY_LIMIT in
--     src/auth/password-policy.js), so this is a short list per account and
--     not a lifetime archive.
--
-- Runs after 020 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS password_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Whose password it was.
  user_id INT NOT NULL,
  -- A bcrypt hash, the same column type as users.password_hash. Never a
  -- password: nothing here can be read back into one.
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The only question asked of this table is "the newest few for this user",
  -- which is exactly what this index answers.
  INDEX idx_password_history_user (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One-time fill: the password each account is using at this moment. Without
-- it, an account's first change would be the only password it remembers, and
-- the one it had before this table existed could be set straight back.
--
-- '!no-password-set' is the placeholder an unclaimed account carries; it is not
-- a bcrypt hash, so the LIKE skips it. NOT EXISTS is what makes this safe to
-- rerun: `npm run db:migrate` applies every file on every run, and after the
-- first run every account this would fill already has a row.
INSERT INTO password_history (user_id, password_hash)
SELECT u.id, u.password_hash
  FROM users u
 WHERE u.password_hash LIKE '$2%'
   AND NOT EXISTS (SELECT 1 FROM password_history h WHERE h.user_id = u.id);
