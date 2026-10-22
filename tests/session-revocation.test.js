// Backlog AA-13: a session issued before the account's cutoff is refused,
// wherever it is. This is what makes "sign out of all sessions" reach devices
// the request never touches.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
let passwordHash;

// The cutoff the fake users table reports, set per test.
let cutoff;
let cutoffReads;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  cutoff = null;
  cutoffReads = 0;

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT sessions_valid_from')) {
      cutoffReads += 1;
      // MySQL answers the comparison; see sessionsRevokedSince.
      const [issuedAtMs] = params;
      return [{ revoked: cutoff && cutoff.getTime() > issuedAtMs ? 1 : 0 }];
    }
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
});

async function signIn() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD }).expect(302);
  return agent;
}

describe('with nothing revoked', () => {
  test('a signed-in session keeps working', async () => {
    const agent = await signIn();
    await agent.get('/').expect(200);
  });

  test('signed-out requests never look up a cutoff', async () => {
    await request(app).get('/login').expect(200);
    expect(cutoffReads).toBe(0);
  });
});

describe('after signing out of all sessions', () => {
  test('a session issued before the cutoff is refused', async () => {
    const agent = await signIn();
    await agent.get('/').expect(200);

    cutoff = new Date(Date.now() + 1000); // revoked just after this session began

    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?reason=everywhere');
  });

  test('the login page explains what happened', async () => {
    const res = await request(app).get('/login?reason=everywhere');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/signed out of all sessions/i);
  });

  test('the cookie is cleared, so the dead session is not reused', async () => {
    const agent = await signIn();
    cutoff = new Date(Date.now() + 1000);

    const res = await agent.get('/');
    expect(String(res.headers['set-cookie'])).toMatch(/connect\.sid=;/);
  });

  test('a second request lands on the login page as a stranger', async () => {
    const agent = await signIn();
    cutoff = new Date(Date.now() + 1000);
    await agent.get('/').expect(302);

    const res = await agent.get('/login');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('driver1');
  });

  test('signing in again works, and the new session survives', async () => {
    const agent = await signIn();

    // The cutoff falls between the old session and the next sign-in.
    cutoff = new Date(Date.now() + 300);
    await agent.get('/').expect(302);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const fresh = await signIn();
    await fresh.get('/').expect(200);
  });

  test('every device is affected, not just the one that asked', async () => {
    const laptop = await signIn();
    const phone = await signIn();
    await laptop.get('/').expect(200);
    await phone.get('/').expect(200);

    cutoff = new Date(Date.now() + 1000);

    await laptop.get('/').expect(302);
    await phone.get('/').expect(302);
  });
});

describe('a cutoff later than the session', () => {
  test('refuses it however far ahead the cutoff is', async () => {
    const agent = await signIn();
    cutoff = new Date(Date.now() + 60_000);

    await agent.get('/').expect(302);
  });

  // A session created before this feature carries no issue time at all. That
  // case is covered where the comparison happens, in tests/revoke-sessions:
  // sessionsRevokedSince(id, 0) is true whenever a cutoff exists.
});

describe('background requests', () => {
  test('the keep-alive gets JSON, not a redirect to a page', async () => {
    const agent = await signIn();
    cutoff = new Date(Date.now() + 1000);

    const res = await agent.post('/session/keep-alive');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/all sessions/i);
  });
});
