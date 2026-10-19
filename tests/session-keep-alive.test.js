// Story AA-12: the server side of the "your session is about to expire"
// warning — how long is left, how early to warn, and a way to stay signed in.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { warningLeadMs, idleLimitMs } = require('../src/auth/session-timeout');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
let passwordHash;

const originalIdle = process.env.SESSION_IDLE_MINUTES;
const originalWarning = process.env.SESSION_WARNING_MINUTES;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIdle === undefined) delete process.env.SESSION_IDLE_MINUTES;
  else process.env.SESSION_IDLE_MINUTES = originalIdle;
  if (originalWarning === undefined) delete process.env.SESSION_WARNING_MINUTES;
  else process.env.SESSION_WARNING_MINUTES = originalWarning;
});

async function signIn() {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD });
  expect(res.status).toBe(302);
  return agent;
}

describe('how early the warning appears', () => {
  test('defaults to five minutes before expiry', () => {
    delete process.env.SESSION_WARNING_MINUTES;
    delete process.env.SESSION_IDLE_MINUTES;
    expect(warningLeadMs()).toBe(5 * 60 * 1000);
  });

  test('can be configured', () => {
    process.env.SESSION_WARNING_MINUTES = '2';
    expect(warningLeadMs()).toBe(2 * 60 * 1000);
  });

  test('never exceeds half the idle window, so a short demo still warns', () => {
    process.env.SESSION_IDLE_MINUTES = '1';
    process.env.SESSION_WARNING_MINUTES = '5';

    expect(warningLeadMs()).toBe(idleLimitMs() / 2);
    expect(warningLeadMs()).toBeLessThan(idleLimitMs());
  });

  test('nonsense settings fall back to the default', () => {
    process.env.SESSION_WARNING_MINUTES = 'soon';
    delete process.env.SESSION_IDLE_MINUTES;
    expect(warningLeadMs()).toBe(5 * 60 * 1000);
  });
});

describe('keeping a session alive', () => {
  test('a signed-in request extends the session and reports the new window', async () => {
    const agent = await signIn();
    const res = await agent.post('/session/keep-alive');

    expect(res.status).toBe(200);
    expect(res.body.remainingMs).toBe(idleLimitMs());
    expect(res.body.warningMs).toBe(warningLeadMs());
  });

  test('it really does extend: the session still works afterwards', async () => {
    process.env.SESSION_IDLE_MINUTES = '0.01'; // 600ms
    const agent = await signIn();

    // Past the original window, but each request refreshes it.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      expect((await agent.post('/session/keep-alive')).status).toBe(200);
    }

    expect((await agent.get('/')).status).toBe(200);
  });

  test('an expired session cannot be revived', async () => {
    process.env.SESSION_IDLE_MINUTES = '0.01'; // 600ms
    const agent = await signIn();
    await new Promise((r) => setTimeout(r, 900));

    const res = await agent.post('/session/keep-alive');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('a signed-out visitor gets a 401, not a redirect', async () => {
    const res = await request(app).post('/session/keep-alive');

    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
  });
});
