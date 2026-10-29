// Story AA-70: a lockout follows whoever caused it. Counting failures per
// username alone let anyone who knew a username keep that account locked.
//
// The fake login_attempts below answers the real query's shape: failures for
// one (username, source) pair, since that pair's last success.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
const ATTACKER = '203.0.113.7';
const VICTIM = '198.51.100.9';

let passwordHash;
let rows;   // every recorded attempt: { username, success, source, at }

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  rows = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) {
      const [username, source, minutes] = params;
      const mine = rows.filter(r => r.username === username && r.source === source);
      const lastSuccess = mine.filter(r => r.success).map(r => r.at).sort().pop() || 0;
      const since = Date.now() - minutes * 60 * 1000;
      const failures = mine.filter(r => !r.success && r.at > lastSuccess && r.at > since);
      return [{
        failures: failures.length,
        latest_failure: failures.length ? Math.max(...failures.map(r => r.at)) : null,
      }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) {
      rows.push({ username: params[0], success: Boolean(params[1]), source: params[2], at: Date.now() });
      return {};
    }
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    return [];
  });
});

afterEach(() => vi.restoreAllMocks());

const attempt = (password, from) =>
  request(app).post('/login').type('form').set('X-Forwarded-For', from)
    .send({ username: 'driver1', password });

const failFiveTimes = async (from) => {
  for (let i = 0; i < 5; i += 1) await attempt('wrong-password', from);
};

describe('a lockout follows whoever caused it', () => {
  test('the attacker is locked out', async () => {
    await failFiveTimes(ATTACKER);

    const res = await attempt(PASSWORD, ATTACKER);
    expect(res.status).toBe(429);
  });

  test('and the real user still signs in with the right password', async () => {
    // This is the whole story: someone else guessing must not cost me access.
    await failFiveTimes(ATTACKER);

    const res = await attempt(PASSWORD, VICTIM);
    expect(res.status).toBe(302);
  });

  test('the real user is not even slowed down', async () => {
    await failFiveTimes(ATTACKER);

    const res = await attempt('wrong-password', VICTIM);
    expect(res.status).toBe(401);          // the ordinary wrong-password answer
    expect(res.text).not.toMatch(/too many failed/i);
  });
});

describe('the protection still works', () => {
  test('repeated guessing from one place is still blocked', async () => {
    await failFiveTimes(ATTACKER);

    expect((await attempt('wrong-password', ATTACKER)).status).toBe(429);
  });

  test('a signed-in user starts fresh afterwards', async () => {
    await attempt('wrong-password', VICTIM);
    await attempt('wrong-password', VICTIM);
    await attempt(PASSWORD, VICTIM).expect(302);
    await attempt('wrong-password', VICTIM);

    // Three failures in total, but only one since the success.
    expect((await attempt(PASSWORD, VICTIM)).status).toBe(302);
  });

  test("one person's success does not clear someone else's failures", async () => {
    await failFiveTimes(ATTACKER);
    await attempt(PASSWORD, VICTIM).expect(302);

    // The victim signing in must not hand the attacker a fresh five tries.
    expect((await attempt('wrong-password', ATTACKER)).status).toBe(429);
  });
});

describe('attempts with no known origin', () => {
  test('are counted against each other rather than against everyone', async () => {
    // No forwarded header: these arrive with the same (null-ish) source.
    const direct = () => request(app).post('/login').type('form')
      .send({ username: 'driver1', password: 'wrong-password' });

    for (let i = 0; i < 5; i += 1) await direct();

    // Blocked for that origin...
    expect((await direct()).status).toBe(429);
    // ...but not for a request that does identify itself.
    expect((await attempt(PASSWORD, VICTIM)).status).toBe(302);
  });
});
