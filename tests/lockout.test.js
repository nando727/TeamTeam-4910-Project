// Story 22214: the lockout policy and the "failures since last success" count.
// Route enforcement is covered separately.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { checkLockout, lockoutPolicy, lockoutMessage } = require('../src/auth/lockout');

const originalMax = process.env.LOGIN_MAX_FAILURES;
const originalMinutes = process.env.LOGIN_LOCKOUT_MINUTES;
const originalFirstWait = process.env.LOGIN_FIRST_WAIT_MINUTES;

// Stands in for the login_attempts table: the query returns whatever the test
// sets here.
let queryResult;
let lastParams;
let lastSql;

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function secondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000);
}

beforeEach(() => {
  queryResult = { failures: 0, latest_failure: null };
  lastParams = null;
  lastSql = null;

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM login_attempts')) {
      lastParams = params;
      lastSql = sql;
      return [queryResult];
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMax === undefined) delete process.env.LOGIN_MAX_FAILURES;
  else process.env.LOGIN_MAX_FAILURES = originalMax;
  if (originalMinutes === undefined) delete process.env.LOGIN_LOCKOUT_MINUTES;
  else process.env.LOGIN_LOCKOUT_MINUTES = originalMinutes;
  if (originalFirstWait === undefined) delete process.env.LOGIN_FIRST_WAIT_MINUTES;
  else process.env.LOGIN_FIRST_WAIT_MINUTES = originalFirstWait;
});

describe('the policy', () => {
  // Story AA-70: lockoutMinutes is the longest a wait can get; the first wait
  // is short and doubles from there. tests/lockout-backoff.test.js covers the
  // lengths themselves.
  test('defaults to 5 failures, a 1 minute first wait and a 15 minute maximum', () => {
    delete process.env.LOGIN_MAX_FAILURES;
    delete process.env.LOGIN_LOCKOUT_MINUTES;
    delete process.env.LOGIN_FIRST_WAIT_MINUTES;
    expect(lockoutPolicy()).toEqual({ maxFailures: 5, lockoutMinutes: 15, firstWaitMinutes: 1 });
  });

  test('can be tuned for a demo or a test', () => {
    process.env.LOGIN_MAX_FAILURES = '3';
    process.env.LOGIN_LOCKOUT_MINUTES = '0.5';
    // A half-minute maximum holds the first wait down with it.
    expect(lockoutPolicy()).toEqual({ maxFailures: 3, lockoutMinutes: 0.5, firstWaitMinutes: 0.5 });
  });

  test('nonsense settings fall back to the defaults', () => {
    process.env.LOGIN_MAX_FAILURES = 'lots';
    process.env.LOGIN_LOCKOUT_MINUTES = '-5';
    process.env.LOGIN_FIRST_WAIT_MINUTES = 'a while';
    expect(lockoutPolicy()).toEqual({ maxFailures: 5, lockoutMinutes: 15, firstWaitMinutes: 1 });
  });
});

describe('deciding whether an account is locked', () => {
  test('a clean account is not locked', async () => {
    const result = await checkLockout('driver1');
    expect(result.locked).toBe(false);
    expect(result.failures).toBe(0);
  });

  test('below the limit is not locked', async () => {
    queryResult = { failures: 4, latest_failure: minutesAgo(1) };
    expect((await checkLockout('driver1')).locked).toBe(false);
  });

  test('reaching the limit locks the account', async () => {
    queryResult = { failures: 5, latest_failure: secondsAgo(2) };
    const result = await checkLockout('driver1');

    expect(result.locked).toBe(true);
    expect(result.minutesRemaining).toBeGreaterThan(0);
    expect(result.minutesRemaining).toBeLessThanOrEqual(15);
  });

  test('the lock lifts once the window has passed', async () => {
    // Five failures, but the most recent was 20 minutes ago.
    queryResult = { failures: 5, latest_failure: minutesAgo(20) };
    expect((await checkLockout('driver1')).locked).toBe(false);
  });

  test('guessing again during a lock extends it', async () => {
    // Both of these are at the longest wait already, so only the time of the
    // newest failure differs: the wait is measured from it, not from the first.
    queryResult = { failures: 9, latest_failure: minutesAgo(14) };
    const soon = await checkLockout('driver1');

    queryResult = { failures: 10, latest_failure: minutesAgo(0) };
    const afterAnotherTry = await checkLockout('driver1');

    expect(soon.waitMinutes).toBe(afterAnotherTry.waitMinutes);
    expect(afterAnotherTry.minutesRemaining).toBeGreaterThan(soon.minutesRemaining);
  });

  test('the count only covers failures since the last success', async () => {
    await checkLockout('driver1', '203.0.113.7');

    // Story AA-70: [username, source, minutes, username, source] — the success
    // that clears the tally is looked up for the same pair, so one person's
    // sign-in cannot wipe another's failures.
    const [, , , usernameForSuccessLookup, sourceForSuccessLookup, usernameForUnlockLookup] = lastParams;
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain('success = 1');
    expect(usernameForSuccessLookup).toBe('driver1');
    expect(sourceForSuccessLookup).toBe('203.0.113.7');
    // Story AA-72: and an administrator's unlock starts the tally over too.
    expect(sql).toContain('FROM login_unlocks');
    expect(usernameForUnlockLookup).toBe('driver1');
  });

  test('the window and username are passed as query parameters, not built into the SQL', async () => {
    process.env.LOGIN_LOCKOUT_MINUTES = '30';
    await checkLockout("someone' OR '1'='1", "203.0.113.7' OR '1'='1");

    expect(lastParams).toEqual([
      "someone' OR '1'='1", "203.0.113.7' OR '1'='1", 30,
      "someone' OR '1'='1", "203.0.113.7' OR '1'='1",
      "someone' OR '1'='1",
    ]);
    expect(db.query.mock.calls[0][0]).toContain('INTERVAL ? MINUTE');
  });
});

describe('the message shown to a locked-out visitor', () => {
  test('says how long to wait without revealing whether the account exists', () => {
    const message = lockoutMessage({ minutesRemaining: 12 });

    expect(message).toContain('12 minutes');
    expect(message).toMatch(/too many failed sign-in attempts/i);
    expect(message).not.toMatch(/exists|unknown|no such|account not found/i);
  });

  test('uses the singular for one minute', () => {
    expect(lockoutMessage({ minutesRemaining: 1 })).toContain('1 minute,');
  });
});

// The lock's length is measured against the database's clock, not the app's.
describe('how the newest failure is read', () => {
  test('asked for as epoch milliseconds, never as a datetime', async () => {
    queryResult = { failures: 5, latest_failure: minutesAgo(1) };
    await checkLockout('driver1');

    // A DATETIME read into Node is rebuilt in the machine's local zone, which
    // against a UTC database put every failure hours into the future and made
    // a 15 minute lock last more than four hours.
    expect(lastSql).toContain('UNIX_TIMESTAMP(MAX(attempted_at)) * 1000');
    expect(lastSql).not.toMatch(/MAX\(attempted_at\) AS latest_failure/);
  });

  test('a value in the shape MySQL actually sends is understood', async () => {
    // mysql2 returns the product of UNIX_TIMESTAMP as a decimal string.
    const oneMinuteAgo = Date.now() - 60 * 1000;
    // Enough failures to be at the 15 minute maximum, so a misread timestamp
    // shows up as a wrong number of minutes rather than as no lock at all.
    queryResult = { failures: 9, latest_failure: `${oneMinuteAgo}.000` };

    const result = await checkLockout('driver1');

    expect(result.locked).toBe(true);
    expect(result.minutesRemaining).toBe(14);
  });

  test('a lock runs for the configured maximum, not hours longer', async () => {
    process.env.LOGIN_LOCKOUT_MINUTES = '15';
    queryResult = { failures: 9, latest_failure: Date.now() - 60 * 1000 };

    const result = await checkLockout('driver1');

    expect(result.minutesRemaining).toBeLessThanOrEqual(15);
    expect(result.minutesRemaining).toBeGreaterThan(13);
  });

  test('no failures at all still means no lock', async () => {
    queryResult = { failures: 0, latest_failure: null };

    expect((await checkLockout('driver1')).locked).toBe(false);
  });
});
