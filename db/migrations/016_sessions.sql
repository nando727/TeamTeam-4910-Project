-- Story AA-71: keep signed-in sessions in the database instead of in the web
-- server's memory.
--
-- express-session's default store is a plain object inside the Node process.
-- Every deployment restarts that process, so every signed-in user was thrown
-- out whenever we pushed; and if the class environment ever runs a second
-- instance, each one would only recognise the sessions it created itself.
--
-- Runs after 015 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS sessions (
  -- express-session's own session id, which is what the cookie carries.
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  -- The session as JSON: the signed-in user's id, username and role, plus
  -- bookkeeping like lastActivity. No password or password hash goes in here.
  data TEXT NOT NULL,
  -- Rows outlive the idle limit on purpose: the row is what lets an expired
  -- visitor be told their session expired rather than silently signed out.
  -- src/auth/session-store.js explains the sizing.
  expires_at DATETIME NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Pruning deletes by expiry, so it should not read the whole table.
  INDEX idx_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
