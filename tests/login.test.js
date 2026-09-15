// Story 22199: log in with username + password, no user type selection.
// The db module is stubbed so these tests run without a MySQL server.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// The app is CommonJS. vi.mock() does not intercept require(), so the app and
// the db module are loaded through Node's require to share one module instance
// that vi.spyOn can patch.
const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let driverHash;

beforeAll(async () => {
  driverHash = await hashPassword('DriverPass1!');
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT')) {
      const [username] = params;
      if (username === 'driver1') {
        return [{ id: 1, username: 'driver1', password_hash: driverHash, role: 'driver' }];
      }
      return [];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loginAttemptCalls() {
  return db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO login_attempts'));
}

describe('GET /login', () => {
  test('shows the login form without asking for a user type', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="username"');
    expect(res.text).toContain('name="password"');
    // Role must come from the database, never from the form.
    expect(res.text).not.toMatch(/name="(role|type|user_?type)"/i);
    expect(res.text).not.toMatch(/<select/i);
  });
});

describe('POST /login', () => {
  test('valid credentials log in and redirect to the homepage', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'driver1', password: 'DriverPass1!' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('driver1');

    const [, params] = loginAttemptCalls()[0];
    expect(params).toEqual(['driver1', true]);
  });

  test('wrong password shows an error and logs a failed attempt', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'driver1', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('Incorrect username or password.');

    const [, params] = loginAttemptCalls()[0];
    expect(params).toEqual(['driver1', false]);
  });

  test('unknown username gets the same generic error', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'nobody', password: 'whatever' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('Incorrect username or password.');

    const [, params] = loginAttemptCalls()[0];
    expect(params).toEqual(['nobody', false]);
  });

  test('missing fields are rejected without a database lookup', async () => {
    const res = await request(app).post('/login').type('form').send({ username: '' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('user lookup uses a parameterized query', async () => {
    await request(app)
      .post('/login')
      .type('form')
      .send({ username: "x' OR '1'='1", password: 'x' });

    const selectCall = db.query.mock.calls.find(([sql]) => sql.startsWith('SELECT'));
    expect(selectCall[0]).toContain('username = ?');
    expect(selectCall[1]).toEqual(["x' OR '1'='1"]);
  });
});

describe('GET / without a session', () => {
  test('redirects to the login page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
