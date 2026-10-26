// Story AA-70: every login attempt records where it came from. Counting
// failures per origin comes later; this is the fact that makes it possible.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
let passwordHash;
let attempts;   // rows the fake login_attempts table received

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  attempts = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) {
      attempts.push({ sql, username: params[0], success: params[1], source: params[2] });
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

const signIn = (body, forwardedFor) => {
  const req = request(app).post('/login').type('form');
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send(body);
};

describe('what gets recorded', () => {
  test('a successful sign-in carries its source', async () => {
    await signIn({ username: 'driver1', password: PASSWORD }).expect(302);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].success).toBe(true);
    expect(attempts[0].source).toBe('127.0.0.1');
  });

  test('a failed sign-in carries its source', async () => {
    await signIn({ username: 'driver1', password: 'wrong-password' }).expect(401);

    expect(attempts[0].success).toBe(false);
    expect(attempts[0].source).toBe('127.0.0.1');
  });

  test('an attempt on a username that does not exist is still attributed', async () => {
    // These are the attempts worth tracing, so they cannot be the ones dropped.
    await signIn({ username: 'nobody-here', password: 'whatever' }).expect(401);

    expect(attempts[0].username).toBe('nobody-here');
    expect(attempts[0].source).toBe('127.0.0.1');
  });

  test('the JSON sign-in route records it too', async () => {
    await request(app).post('/api/login').send({ username: 'driver1', password: PASSWORD }).expect(200);

    expect(attempts[0].source).toBe('127.0.0.1');
  });
});

describe('behind the load balancer', () => {
  test('the client address is recorded, not the proxy', async () => {
    // Elastic Beanstalk forwards the real client in X-Forwarded-For, and
    // app.set('trust proxy', 1) is what makes req.ip read it.
    await signIn({ username: 'driver1', password: 'wrong-password' }, '203.0.113.7').expect(401);

    expect(attempts[0].source).toBe('203.0.113.7');
  });

  test('an address mapped into IPv6 form is stored in one shape', async () => {
    await signIn({ username: 'driver1', password: 'wrong-password' }, '::ffff:198.51.100.9').expect(401);

    expect(attempts[0].source).toBe('198.51.100.9');
  });

  test('an IPv6 client is kept as it is', async () => {
    await signIn({ username: 'driver1', password: 'wrong-password' }, '2001:db8::42').expect(401);

    expect(attempts[0].source).toBe('2001:db8::42');
  });
});

describe('how it is written', () => {
  test('through a parameterized query, never built into the SQL', async () => {
    await signIn({ username: 'driver1', password: 'wrong-password' }, '203.0.113.7');

    expect(attempts[0].sql).toContain('VALUES (?, ?, ?)');
    expect(attempts[0].sql).not.toContain('203.0.113.7');
  });

  test('an address long enough to overflow the column is cut to fit', async () => {
    const tooLong = `2001:db8:${'a'.repeat(80)}`;
    await signIn({ username: 'driver1', password: 'wrong-password' }, tooLong);

    expect(attempts[0].source.length).toBeLessThanOrEqual(45);
  });
});
