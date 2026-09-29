// Story 22214: the login routes refuse a locked account.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let passwordHash;

// How many failures the fake login_attempts table reports, and when the most
// recent one happened.
let failureState;
let recordedAttempts;

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

beforeAll(async () => {
  passwordHash = await hashPassword('DriverPass1!');
});

beforeEach(() => {
  failureState = { failures: 0, latest_failure: null };
  recordedAttempts = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) {
      return [failureState];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) {
      recordedAttempts.push({ username: params[0], success: params[1] });
      return [];
    }
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logIn(body) {
  return request(app).post('/login').type('form').send(body);
}

describe('a locked account', () => {
  beforeEach(() => {
    failureState = { failures: 5, latest_failure: minutesAgo(1) };
  });

  test('is refused even with the correct password', async () => {
    const res = await logIn({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(429);
    expect(res.text).toMatch(/too many failed sign-in attempts/i);
    expect(res.text).toMatch(/\d+ minutes?/);
  });

  test('gets no session, so the homepage stays out of reach', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver1', password: 'DriverPass1!' });

    const home = await agent.get('/');
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe('/login');
  });

  test('never has its password checked', async () => {
    await logIn({ username: 'driver1', password: 'DriverPass1!' });

    // The user row is never fetched, so the hash is never compared.
    const lookedUp = db.query.mock.calls.some(([sql]) => sql.startsWith('SELECT id, username, password_hash'));
    expect(lookedUp).toBe(false);
  });

  test('still records the blocked attempt in the audit log', async () => {
    await logIn({ username: 'driver1', password: 'DriverPass1!' });
    expect(recordedAttempts).toEqual([{ username: 'driver1', success: false }]);
  });

  test('is refused on the JSON route too', async () => {
    const res = await request(app).post('/api/login').send({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/too many failed/i);
  });

  test('says the same thing for a username that does not exist', async () => {
    const real = await logIn({ username: 'driver1', password: 'DriverPass1!' });
    const madeUp = await logIn({ username: 'nobody-at-all', password: 'whatever' });

    expect(madeUp.status).toBe(429);
    // Identical wording, so the lock can't be used to discover usernames.
    const strip = (t) => t.match(/Too many failed[^<]*/)[0];
    expect(strip(madeUp.text)).toBe(strip(real.text));
  });
});

describe('an account that is not locked', () => {
  test('logs in normally', async () => {
    const res = await logIn({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('is unaffected by failures below the limit', async () => {
    failureState = { failures: 4, latest_failure: minutesAgo(1) };
    const res = await logIn({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(302);
  });

  test('can sign in once the lock window has passed', async () => {
    failureState = { failures: 9, latest_failure: minutesAgo(30) };
    const res = await logIn({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(302);
  });

  test('still gets the ordinary error for a wrong password', async () => {
    const res = await logIn({ username: 'driver1', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('Incorrect username or password.');
    expect(res.text).not.toMatch(/too many failed/i);
  });

  test('blank fields are still refused before any lockout check', async () => {
    const res = await logIn({ username: '', password: '' });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
