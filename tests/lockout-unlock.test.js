// Story AA-72: an administrator can let a locked-out user back in before the
// clock runs out.
//
// The lock is counted from login_attempts, so there is no flag to switch off.
// An unlock is its own record and the count starts after it: the audit log is
// never rewritten, and the unlock is itself auditable. The admin page that
// offers the button is covered separately.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { checkLockout, clearLockout } = require('../src/auth/lockout');

const ATTACKER = '203.0.113.7';
const OWN_LAPTOP = '198.51.100.9';
const ADMIN_ID = 7;

let attempts;   // { username, source, success, at }
let unlocks;    // { username, by, at }
let sqlSeen;

// The clock is ours, so "a failure before the unlock" and "a failure after
// it" are never the same instant and the order under test is the real subject.
const tick = (ms = 1000) => vi.advanceTimersByTime(ms);

function fail(username, source) {
  attempts.push({ username, source, success: false, at: Date.now() });
}

function succeed(username, source) {
  attempts.push({ username, source, success: true, at: Date.now() });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
  attempts = [];
  unlocks = [];
  sqlSeen = [];

  // Answers the real query's shape: failures for one (username, source) pair,
  // since that pair's last success and since the username's last unlock.
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    sqlSeen.push(sql);

    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) {
      const [username, source, minutes] = params;
      const mine = attempts.filter(a => a.username === username && a.source === source);
      const lastSuccess = Math.max(0, ...mine.filter(a => a.success).map(a => a.at));
      const lastUnlock = Math.max(0, ...unlocks.filter(u => u.username === username).map(u => u.at));
      const since = Math.max(lastSuccess, lastUnlock, Date.now() - minutes * 60 * 1000);
      const failures = mine.filter(a => !a.success && a.at > since);
      return [{
        failures: failures.length,
        latest_failure: failures.length ? Math.max(...failures.map(a => a.at)) : null,
      }];
    }

    if (sql.startsWith('INSERT INTO login_unlocks')) {
      unlocks.push({ username: params[0], by: params[1], at: Date.now() });
      return { affectedRows: 1 };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const lockFiveTimes = (username, source) => {
  for (let i = 0; i < 5; i += 1) { fail(username, source); tick(10); }
};

describe('unlocking an account', () => {
  test('a locked account can sign in again straight away', async () => {
    lockFiveTimes('driver1', OWN_LAPTOP);
    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(true);

    tick();
    await clearLockout('driver1', ADMIN_ID);

    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(false);
  });

  test('every origin for that username is cleared, not just one', async () => {
    // The admin acts on an account, and cannot be asked which address to clear
    // — the UI must never make anyone type a machine-generated value.
    lockFiveTimes('driver1', OWN_LAPTOP);
    lockFiveTimes('driver1', ATTACKER);

    tick();
    await clearLockout('driver1', ADMIN_ID);

    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(false);
    expect((await checkLockout('driver1', ATTACKER)).locked).toBe(false);
  });

  test('somebody else stays locked', async () => {
    lockFiveTimes('driver1', ATTACKER);
    lockFiveTimes('driver2', ATTACKER);

    tick();
    await clearLockout('driver1', ADMIN_ID);

    expect((await checkLockout('driver2', ATTACKER)).locked).toBe(true);
  });

  test('who unlocked it is recorded', async () => {
    await clearLockout('driver1', ADMIN_ID);

    expect(unlocks).toEqual([{ username: 'driver1', by: ADMIN_ID, at: expect.any(Number) }]);
  });

  test('the username goes in as a query parameter, not as SQL', async () => {
    const hostile = "driver1'; DROP TABLE login_attempts; --";
    await clearLockout(hostile, ADMIN_ID);

    const insert = sqlSeen.find(sql => sql.startsWith('INSERT INTO login_unlocks'));
    expect(insert).not.toContain('DROP TABLE');
    expect(unlocks[0].username).toBe(hostile);
  });
});

describe('what an unlock must not do', () => {
  test('it does not switch the lockout off: the next run of failures locks again', async () => {
    lockFiveTimes('driver1', ATTACKER);
    tick();
    await clearLockout('driver1', ADMIN_ID);
    expect((await checkLockout('driver1', ATTACKER)).locked).toBe(false);

    // Whoever was guessing is still guessing.
    tick();
    for (let i = 0; i < 5; i += 1) { fail('driver1', ATTACKER); tick(10); }

    expect((await checkLockout('driver1', ATTACKER)).locked).toBe(true);
  });

  test('it leaves the audit log exactly as it was', async () => {
    lockFiveTimes('driver1', OWN_LAPTOP);
    const before = JSON.stringify(attempts);

    tick();
    await clearLockout('driver1', ADMIN_ID);

    // The failures are what the admin was reacting to, and the course spec
    // requires them to be logged. Clearing a lock must not rewrite history.
    expect(JSON.stringify(attempts)).toBe(before);
    expect(sqlSeen.some(sql => /DELETE|UPDATE/.test(sql) && sql.includes('login_attempts'))).toBe(false);
  });

  test('it does not revive failures from before it', async () => {
    lockFiveTimes('driver1', OWN_LAPTOP);
    tick();
    await clearLockout('driver1', ADMIN_ID);

    // One more failure after the unlock: one, not six.
    tick();
    fail('driver1', OWN_LAPTOP);

    const result = await checkLockout('driver1', OWN_LAPTOP);
    expect(result.failures).toBe(1);
    expect(result.locked).toBe(false);
  });

  test('a later unlock supersedes an earlier one', async () => {
    await clearLockout('driver1', ADMIN_ID);
    tick();
    lockFiveTimes('driver1', OWN_LAPTOP);
    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(true);

    tick();
    await clearLockout('driver1', ADMIN_ID);

    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(false);
  });

  test('a successful sign-in still clears the tally on its own', async () => {
    // The unlock is an addition to how the count starts over, not a
    // replacement for it.
    lockFiveTimes('driver1', OWN_LAPTOP);
    tick();
    succeed('driver1', OWN_LAPTOP);

    expect((await checkLockout('driver1', OWN_LAPTOP)).locked).toBe(false);
  });
});
