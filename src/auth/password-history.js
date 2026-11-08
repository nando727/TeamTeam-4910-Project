const db = require('../db');
const { PASSWORD_HISTORY_LIMIT } = require('./password-policy');

// Story 28211 (AA-79): the passwords an account has already used, as hashes,
// so none of them can be set again. See db/migrations/021_password_history.sql
// for why old hashes are kept in one table and nowhere else.
//
// This module only remembers them. Comparing a new password against them is
// the other half of the story and is not here yet.

// Remembers the hash that is now in force, then forgets anything past the
// limit. Called from updateUserPassword in src/users/store.js, which is the
// single place a password is written, so every route gets this without
// knowing about it.
async function recordPasswordUsed(userId, passwordHash) {
  await db.query(
    'INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)',
    [userId, passwordHash]
  );
  return forgetBeyondLimit(userId);
}

// Keeps the newest PASSWORD_HISTORY_LIMIT rows for the account and deletes
// everything older, so the table stays a short list per account.
//
// Two statements rather than one DELETE with a subquery: MySQL refuses a LIMIT
// inside IN (...), and the derived-table trick that gets around it is harder to
// read than this. Both are parameterized, the limit included -- a prepared
// statement takes a placeholder in LIMIT.
async function forgetBeyondLimit(userId) {
  // One more than the limit, which is the cheapest way to learn whether there
  // is anything to drop at all. An account that has changed its password a few
  // times sits at exactly the limit from then on, and asking for the limit
  // itself cannot tell that apart from being over it -- so every change after
  // that would run a DELETE that deletes nothing. ids only: this query has no
  // reason to read a hash, so it does not.
  const newest = await db.query(
    'SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, PASSWORD_HISTORY_LIMIT + 1]
  );
  if (newest.length <= PASSWORD_HISTORY_LIMIT) return 0;
  const oldestKept = newest[PASSWORD_HISTORY_LIMIT - 1].id;
  const result = await db.query(
    'DELETE FROM password_history WHERE user_id = ? AND id < ?',
    [userId, oldestKept]
  );
  return result.affectedRows || 0;
}

module.exports = { recordPasswordUsed, forgetBeyondLimit };
