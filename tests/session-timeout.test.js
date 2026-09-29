// Story 22204: sessions expire after inactivity.
// Story 22208: the login page explains why you were signed out.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let driverHash;
const originalIdle = process.env.SESSION_IDLE_MINUTES;

// 0.002 minutes = 120ms, short enough to wait out in a test.
const SHORT_MS = 120;
const SHORT_MINUTES = String(SHORT_MS / 60000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  driverHash = await hashPassword('DriverPass1!');
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('SELECT')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: driverHash, role: 'driver', status: 'active' }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIdle === undefined) delete process.env.SESSION_IDLE_MINUTES;
  else process.env.SESSION_IDLE_MINUTES = originalIdle;
});

async function signIn() {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({
    username: 'driver1',
    password: 'DriverPass1!',
  });
  expect(res.status).toBe(302);
  return agent;
}

describe('session expiry (22204)', () => {
  test('an active session keeps working', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();

    const res = await agent.get('/');
    expect(res.status).toBe(200);
  });

  test('a session left idle past the limit is signed out', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();
    await wait(SHORT_MS * 2);

    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?expired=1');
  });

  test('activity slides the window, so a busy user stays signed in', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();

    // Three requests, each within the window but together well past it.
    for (let i = 0; i < 3; i += 1) {
      await wait(SHORT_MS * 0.6);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
    }
  });

  test('the expired session is destroyed, not just redirected', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();
    await wait(SHORT_MS * 2);

    await agent.get('/');
    // The same cookie on a later request is now an anonymous visitor:
    // plain /login, with no repeat of the expiry explanation.
    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('an API request after the limit gets JSON, not a redirect', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();
    await wait(SHORT_MS * 2);

    const res = await agent.get('/api/profile');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('expired');
  });

  test('the default window is 30 minutes, so a normal session survives', async () => {
    delete process.env.SESSION_IDLE_MINUTES;
    const agent = await signIn();
    await wait(150);

    const res = await agent.get('/');
    expect(res.status).toBe(200);
  });
});

describe('expiry explanation (22208)', () => {
  test('the login page explains the sign-out and names the window', async () => {
    process.env.SESSION_IDLE_MINUTES = '30';
    const res = await request(app).get('/login?expired=1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('You were signed out after 30 minutes of inactivity.');
    expect(res.text).toContain('Please log in again.');
  });

  test('the explanation reflects a shorter configured window', async () => {
    process.env.SESSION_IDLE_MINUTES = '0.25';
    const res = await request(app).get('/login?expired=1');
    expect(res.text).toContain('15 seconds of inactivity');
  });

  test('a normal visit to the login page shows no explanation', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('signed out after');
  });

  test('an expired user who follows the redirect sees the explanation', async () => {
    process.env.SESSION_IDLE_MINUTES = SHORT_MINUTES;
    const agent = await signIn();
    await wait(SHORT_MS * 2);

    const redirect = await agent.get('/');
    const res = await agent.get(redirect.headers.location);
    expect(res.text).toContain('signed out after');
  });
});
