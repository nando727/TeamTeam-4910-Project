// Story AA-70: the wait after too many failed sign-ins grows instead of being
// one fixed block. A mistyped password costs a minute; a password list costs
// more on every round.
//
// The per-origin half of the story is in tests/lockout-per-source.test.js.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { checkLockout, lockoutPolicy, waitMinutes } = require('../src/auth/lockout');
const { app } = require('../src/app');

const originalEnv = { ...process.env };
const PASSWORD = 'DriverPass1!';

let passwordHash;
let failureState;

const secondsAgo = (s) => Date.now() - s * 1000;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  failureState = { failures: 0, latest_failure: null };

  vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) return [failureState];
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ['LOGIN_MAX_FAILURES', 'LOGIN_LOCKOUT_MINUTES', 'LOGIN_FIRST_WAIT_MINUTES']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('how long the wait is', () => {
  const policy = { maxFailures: 5, lockoutMinutes: 15, firstWaitMinutes: 1 };

  test('there is no wait below the limit', () => {
    expect(waitMinutes(4, policy)).toBe(0);
    expect(waitMinutes(0, policy)).toBe(0);
  });

  test('it doubles with every failure past the limit', () => {
    expect(waitMinutes(5, policy)).toBe(1);
    expect(waitMinutes(6, policy)).toBe(2);
    expect(waitMinutes(7, policy)).toBe(4);
    expect(waitMinutes(8, policy)).toBe(8);
  });

  test('it stops at the configured maximum', () => {
    expect(waitMinutes(9, policy)).toBe(15);
    expect(waitMinutes(20, policy)).toBe(15);
    // 2 ** 95 is Infinity, which must still come back as the cap and not NaN.
    expect(waitMinutes(100, policy)).toBe(15);
  });

  test('a first wait longer than the maximum is held down to it', () => {
    process.env.LOGIN_LOCKOUT_MINUTES = '5';
    process.env.LOGIN_FIRST_WAIT_MINUTES = '30';

    const tuned = lockoutPolicy();
    expect(tuned.firstWaitMinutes).toBe(5);
    expect(waitMinutes(5, tuned)).toBe(5);
  });

  test('the first wait can be tuned on its own', () => {
    process.env.LOGIN_FIRST_WAIT_MINUTES = '2';
    expect(lockoutPolicy().firstWaitMinutes).toBe(2);
    expect(waitMinutes(6, lockoutPolicy())).toBe(4);
  });
});

describe('a mistyped password', () => {
  test('costs a minute at the limit, not the full fifteen', async () => {
    failureState = { failures: 5, latest_failure: secondsAgo(2) };

    const result = await checkLockout('driver1', '198.51.100.9');

    expect(result.locked).toBe(true);
    expect(result.waitMinutes).toBe(1);
    expect(result.minutesRemaining).toBe(1);
  });

  test('and the minute really does end the lock', async () => {
    failureState = { failures: 5, latest_failure: secondsAgo(70) };

    expect((await checkLockout('driver1', '198.51.100.9')).locked).toBe(false);
  });
});

describe('a visitor who keeps guessing', () => {
  test('waits longer on each round', async () => {
    const waits = [];
    for (const failures of [5, 6, 7, 8]) {
      failureState = { failures, latest_failure: secondsAgo(2) };
      waits.push((await checkLockout('driver1', '203.0.113.7')).waitMinutes);
    }

    expect(waits).toEqual([1, 2, 4, 8]);
  });

  test('is still never locked out for good', async () => {
    // The tally only covers the last lockoutMinutes, which is also the longest
    // wait, so sitting out the longest wait leaves nothing to count.
    failureState = { failures: 40, latest_failure: secondsAgo(16 * 60) };

    expect((await checkLockout('driver1', '203.0.113.7')).locked).toBe(false);
  });
});

describe('what the sign-in page does with it', () => {
  const signIn = () => request(app).post('/login').type('form')
    .set('X-Forwarded-For', '198.51.100.9')
    .send({ username: 'driver1', password: PASSWORD });

  test('a short first wait lets the real user back in a minute later', async () => {
    failureState = { failures: 5, latest_failure: secondsAgo(70) };

    const res = await signIn();
    expect(res.status).toBe(302);
  });

  test('but a long wait is still being served', async () => {
    failureState = { failures: 9, latest_failure: secondsAgo(70) };

    const res = await signIn();
    expect(res.status).toBe(429);
    expect(res.text).toMatch(/wait 1[34] minutes/i);
  });

  test('and the page warns that another try makes the next wait longer', async () => {
    failureState = { failures: 5, latest_failure: secondsAgo(2) };

    const res = await signIn();
    expect(res.text).toMatch(/restarts the wait/i);
    expect(res.text).toMatch(/longer/i);
  });
});
