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
//
// The newest failure comes back as epoch milliseconds rather than a DATETIME:
// read as a datetime it arrives with no zone attached, and Node rebuilds it in
// the machine's local zone. Against a UTC database that put every failure
// hours into the future, so a fifteen-minute lock lasted four hours and the
// visitor was told to wait 255 minutes.
// Story AA-70: counted per username AND source, not per username alone.
// Keying on the username by itself meant anyone who knew a username could keep
// that account locked for as long as they cared to: the account was punished
// for what someone else did. Keying on the pair puts the failures on whoever
// produced them, so the real user still signs in from their own machine.
//
// <=> is NULL-safe equality, so attempts whose source could not be determined
// are counted against each other rather than matching nothing.
//
// The success that clears the tally is scoped to the same pair as well. A
// global one would let the victim's own successful sign-in wipe an attacker's
// count every time they logged in.
async function recentFailureCount(username, source, lockoutMinutes) {
  const rows = await db.query(
    'SELECT COUNT(*) AS failures, UNIX_TIMESTAMP(MAX(attempted_at)) * 1000 AS latest_failure ' +
      'FROM login_attempts ' +
      'WHERE username = ? AND source_ip <=> ? AND success = 0 ' +
      '  AND attempted_at > NOW() - INTERVAL ? MINUTE ' +
      '  AND attempted_at > COALESCE((' +
      '    SELECT MAX(attempted_at) FROM login_attempts s ' +
      '     WHERE s.username = ? AND s.source_ip <=> ? AND s.success = 1' +
      "  ), '1970-01-01 00:00:00')",
    [username, source, lockoutMinutes, username, source]
  );
  const row = rows[0] || {};
  return {
    failures: Number(row.failures || 0),
    // Number() covers both what MySQL sends (a decimal string) and a Date.
    latestFailure: row.latest_failure == null ? null : new Date(Number(row.latest_failure)),
  };
}

// Whether this username may attempt a sign-in right now. The lock runs from the
// most recent failure, so guessing again during a lock extends it.
async function checkLockout(username, source = null) {
  const { maxFailures, lockoutMinutes } = lockoutPolicy();
  const { failures, latestFailure } = await recentFailureCount(username, source ?? null, lockoutMinutes);

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

// Story 22215: being told the sign-in is blocked is only half of it. These
// also say how to get back in, because a lock that explains nothing just looks
// like a broken password.
//
// Both stay deliberately vague about whether the account exists: the same
// wording is used for a locked real account and a locked username that was
// never real, so neither can be told apart by trying.

const RESET_PATH = '/forgot-password';

function minutesLabel(minutesRemaining) {
  const unit = minutesRemaining === 1 ? 'minute' : 'minutes';
  return `${minutesRemaining} ${unit}`;
}

// One sentence, for callers that can only show text: the JSON sign-in route,
// and anything that logs the refusal.
function lockoutMessage({ minutesRemaining }) {
  return `Too many failed sign-in attempts. Try again in ${minutesLabel(minutesRemaining)}, `
    + 'or reset your password. Trying again before then restarts the wait.';
}

// The same advice in pieces, so a page can offer the reset as a link instead
// of as prose. Rendered by src/views/login.ejs.
function lockoutGuidance({ minutesRemaining }) {
  return {
    summary: 'Too many failed sign-in attempts, so sign-in is blocked for now.',
    minutesRemaining,
    waitText: `Wait ${minutesLabel(minutesRemaining)} and try again.`,
    // The lock runs from the most recent failure (see checkLockout), so each
    // attempt during it pushes the wait back. Nobody guesses that by itself.
    retryWarning: 'Trying again before then restarts the wait.',
    resetPath: RESET_PATH,
    resetText: 'Reset your password to sign in right away.',
    adminText: 'If you cannot use a reset link, ask an administrator to help you back in.',
  };
}

module.exports = { checkLockout, lockoutPolicy, lockoutMessage, lockoutGuidance, RESET_PATH };
