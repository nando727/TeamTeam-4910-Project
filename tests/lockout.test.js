// Story 22214: the lockout policy and the "failures since last success" count.
// Route enforcement is covered separately.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { checkLockout, lockoutPolicy, lockoutMessage } = require('../src/auth/lockout');

const originalMax = process.env.LOGIN_MAX_FAILURES;
const originalMinutes = process.env.LOGIN_LOCKOUT_MINUTES;

// Stands in for the login_attempts table: the query returns whatever the test
// sets here.
let queryResult;
let lastParams;

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(() => {
  queryResult = { failures: 0, latest_failure: null };
  lastParams = null;

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM login_attempts')) {
      lastParams = params;
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
});

describe('the policy', () => {
  test('defaults to 5 failures and 15 minutes', () => {
    delete process.env.LOGIN_MAX_FAILURES;
    delete process.env.LOGIN_LOCKOUT_MINUTES;
    expect(lockoutPolicy()).toEqual({ maxFailures: 5, lockoutMinutes: 15 });
  });

  test('can be tuned for a demo or a test', () => {
    process.env.LOGIN_MAX_FAILURES = '3';
    process.env.LOGIN_LOCKOUT_MINUTES = '0.5';
    expect(lockoutPolicy()).toEqual({ maxFailures: 3, lockoutMinutes: 0.5 });
  });

  test('nonsense settings fall back to the defaults', () => {
    process.env.LOGIN_MAX_FAILURES = 'lots';
    process.env.LOGIN_LOCKOUT_MINUTES = '-5';
    expect(lockoutPolicy()).toEqual({ maxFailures: 5, lockoutMinutes: 15 });
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
    queryResult = { failures: 5, latest_failure: minutesAgo(1) };
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
    queryResult = { failures: 6, latest_failure: minutesAgo(14) };
    const soon = await checkLockout('driver1');

    queryResult = { failures: 7, latest_failure: minutesAgo(0) };
    const afterAnotherTry = await checkLockout('driver1');

    expect(afterAnotherTry.minutesRemaining).toBeGreaterThan(soon.minutesRemaining);
  });

  test('the count only covers failures since the last success', async () => {
    await checkLockout('driver1');

    const [, , usernameForSuccessLookup] = lastParams;
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain('success = 1');
    expect(usernameForSuccessLookup).toBe('driver1');
  });

  test('the window and username are passed as query parameters, not built into the SQL', async () => {
    process.env.LOGIN_LOCKOUT_MINUTES = '30';
    await checkLockout("someone' OR '1'='1");

    expect(lastParams).toEqual(["someone' OR '1'='1", 30, "someone' OR '1'='1"]);
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
