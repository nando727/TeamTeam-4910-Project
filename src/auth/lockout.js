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
const DEFAULT_FIRST_WAIT_MINUTES = 1;

// Read per call so a demo or a test can use a short window without a restart.
//
// lockoutMinutes is the longest a wait can get, not the only length there is:
// see waitMinutes below.
function lockoutPolicy() {
  const maxFailures = Number.parseInt(process.env.LOGIN_MAX_FAILURES, 10);
  const minutes = Number.parseFloat(process.env.LOGIN_LOCKOUT_MINUTES);
  const firstWait = Number.parseFloat(process.env.LOGIN_FIRST_WAIT_MINUTES);
  const lockoutMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_LOCKOUT_MINUTES;
  const firstWaitMinutes = Number.isFinite(firstWait) && firstWait > 0 ? firstWait : DEFAULT_FIRST_WAIT_MINUTES;
  return {
    maxFailures: Number.isInteger(maxFailures) && maxFailures > 0 ? maxFailures : DEFAULT_MAX_FAILURES,
    lockoutMinutes,
    // A first wait longer than the cap would make the cap meaningless.
    firstWaitMinutes: Math.min(firstWaitMinutes, lockoutMinutes),
  };
}

// Story AA-70: how long a wait is, given how many failures are standing.
//
// The first lock is short and each further failure doubles it, up to
// lockoutMinutes. With the defaults that is 1, 2, 4, 8, then 15 minutes from
// the fifth failure on.
//
// A single fixed block treated two very different visitors the same way. The
// person who mistypes their own password five times is the common case by far,
// and fifteen minutes is a long time to lose over a typo; someone working
// through a password list is not inconvenienced by a flat fifteen minutes at
// all, because they can simply come back and spend five more guesses. A
// doubling wait is gentle on the typo and ruinous for the list: the cost of
// each extra guess grows while the real user never leaves the first step.
//
// 2 ** a large number is Infinity rather than an error, and Math.min still
// returns the cap, so an extreme failure count needs no special case.
function waitMinutes(failures, { maxFailures, lockoutMinutes, firstWaitMinutes }) {
  const failuresPastLimit = failures - maxFailures;
  if (failuresPastLimit < 0) return 0;
  return Math.min(lockoutMinutes, firstWaitMinutes * 2 ** failuresPastLimit);
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
// most recent failure, so guessing again during a lock restarts the wait, and
// because the failure count went up it restarts it longer than before.
//
// Failures are only counted for lockoutMinutes, which is also the longest wait,
// so sitting out the longest wait empties the tally: nobody can end up locked
// out for good.
async function checkLockout(username, source = null) {
  const policy = lockoutPolicy();
  const { maxFailures, lockoutMinutes } = policy;
  const { failures, latestFailure } = await recentFailureCount(username, source ?? null, lockoutMinutes);

  if (failures < maxFailures || !latestFailure) {
    return { locked: false, failures, maxFailures, waitMinutes: 0, minutesRemaining: 0 };
  }

  const wait = waitMinutes(failures, policy);
  const unlocksAt = latestFailure.getTime() + wait * 60 * 1000;
  const msRemaining = Math.max(0, unlocksAt - Date.now());
  return {
    locked: msRemaining > 0,
    failures,
    maxFailures,
    waitMinutes: wait,
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
    retryWarning: 'Trying again before then restarts the wait, and each extra attempt makes the next wait longer.',
    resetPath: RESET_PATH,
    resetText: 'Reset your password to sign in right away.',
    adminText: 'If you cannot use a reset link, ask an administrator to help you back in.',
  };
}

module.exports = { checkLockout, lockoutPolicy, waitMinutes, lockoutMessage, lockoutGuidance, RESET_PATH };
