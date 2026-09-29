// Story 22214: too many failed sign-ins in a row locks an account for a while,
// so a password can't be found by guessing.
//
// The lock is derived from the login_attempts audit log rather than stored on
// the user row: there is no new column to migrate, nothing to reset by hand,
// and a lock expires on its own. Counting starts after the most recent
// successful sign-in, so a stray typo last week plus one today cannot add up
// to a lock.

const db = require('../db');

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCKOUT_MINUTES = 15;

// Read per call so a demo or a test can use a short window without a restart.
function lockoutPolicy() {
  const maxFailures = Number.parseInt(process.env.LOGIN_MAX_FAILURES, 10);
  const minutes = Number.parseFloat(process.env.LOGIN_LOCKOUT_MINUTES);
  return {
    maxFailures: Number.isInteger(maxFailures) && maxFailures > 0 ? maxFailures : DEFAULT_MAX_FAILURES,
    lockoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_LOCKOUT_MINUTES,
  };
}

// Failures since the last success, within the lockout window. MySQL's clock is
// used for both, so the app's clock can't drift away from the stored rows.
async function recentFailureCount(username, lockoutMinutes) {
  const rows = await db.query(
    'SELECT COUNT(*) AS failures, MAX(attempted_at) AS latest_failure ' +
      'FROM login_attempts ' +
      'WHERE username = ? AND success = 0 ' +
      '  AND attempted_at > NOW() - INTERVAL ? MINUTE ' +
      '  AND attempted_at > COALESCE((' +
      '    SELECT MAX(attempted_at) FROM login_attempts s WHERE s.username = ? AND s.success = 1' +
      "  ), '1970-01-01 00:00:00')",
    [username, lockoutMinutes, username]
  );
  const row = rows[0] || {};
  return {
    failures: Number(row.failures || 0),
    latestFailure: row.latest_failure ? new Date(row.latest_failure) : null,
  };
}

// Whether this username may attempt a sign-in right now. The lock runs from the
// most recent failure, so guessing again during a lock extends it.
async function checkLockout(username) {
  const { maxFailures, lockoutMinutes } = lockoutPolicy();
  const { failures, latestFailure } = await recentFailureCount(username, lockoutMinutes);

  if (failures < maxFailures || !latestFailure) {
    return { locked: false, failures, maxFailures, minutesRemaining: 0 };
  }

  const unlocksAt = latestFailure.getTime() + lockoutMinutes * 60 * 1000;
  const msRemaining = Math.max(0, unlocksAt - Date.now());
  return {
    locked: msRemaining > 0,
    failures,
    maxFailures,
    minutesRemaining: Math.max(1, Math.ceil(msRemaining / 60000)),
  };
}

// Deliberately vague about whether the account exists: the same message is
// shown for a locked real account and a locked non-existent username.
function lockoutMessage({ minutesRemaining }) {
  const unit = minutesRemaining === 1 ? 'minute' : 'minutes';
  return `Too many failed sign-in attempts. Try again in ${minutesRemaining} ${unit}, or reset your password.`;
}

module.exports = { checkLockout, lockoutPolicy, lockoutMessage };
