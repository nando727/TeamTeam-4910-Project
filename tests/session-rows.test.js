// Story AA-71: with sessions in the sessions table, the features built on top
// of them have to behave exactly as they did in memory. This runs the real app
// with the real store, against a fake sessions table.
//
// The one thing a mocked test can prove here that nothing else can: a session
// row this process never wrote is honoured. That is what makes a deployment
// survivable, and it cannot be seen from the store's own unit tests.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);

// Set before the app is loaded: it picks its session store at import time.
const originalStore = process.env.SESSION_STORE;
const originalSecret = process.env.SESSION_SECRET;
process.env.SESSION_STORE = 'mysql';
process.env.SESSION_SECRET = 'session-rows-test-secret';

const db = require('../src/db');
const signature = require('cookie-signature');
const { hashPassword } = require('../src/auth/password');
const { pruneExpiredSessions, pruneIntervalMs, startPruning } = require('../src/auth/session-store');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
const DRIVER = { id: 1, username: 'driver1', role: 'driver', status: 'active', sponsor_id: null };

let passwordHash;
let sessionRows;      // the fake sessions table: sid -> { data, expiresAt }
let revoked;          // what the sessions_valid_from check answers

const originalIdle = process.env.SESSION_IDLE_MINUTES;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

// Builds the cookie express-session would send for a session id.
function cookieFor(sid) {
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, process.env.SESSION_SECRET)}`)}`;
}

function sessionJson({ lastActivity = Date.now(), issuedAt = Date.now() } = {}) {
  return JSON.stringify({
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax' },
    user: { id: DRIVER.id, username: DRIVER.username, role: DRIVER.role, sponsor_id: null },
    lastActivity,
    issuedAt,
  });
}

beforeEach(() => {
  sessionRows = new Map();
  revoked = 0;

  // The sessions table is emulated faithfully, including the expiry filter
  // that lives in SQL. Everything else a page happens to ask for answers with
  // nothing, since the subject here is the session, not the page.
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT data FROM sessions')) {
      const row = sessionRows.get(params[0]);
      // WHERE expires_at > NOW()
      if (!row || row.expiresAt <= Date.now()) return [];
      return [{ data: row.data }];
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      sessionRows.set(params[0], { data: params[1], expiresAt: params[2] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE sessions')) {
      const row = sessionRows.get(params[1]);
      if (row) row.expiresAt = params[0];
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE session_id')) {
      return { affectedRows: sessionRows.delete(params[0]) ? 1 : 0 };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
      let removed = 0;
      for (const [sid, row] of sessionRows) {
        if (row.expiresAt <= Date.now()) { sessionRows.delete(sid); removed += 1; }
      }
      return { affectedRows: removed };
    }
    if (sql.includes('sessions_valid_from >')) return [{ revoked }];
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      return params[0] === DRIVER.username ? [{ ...DRIVER, password_hash: passwordHash }] : [];
    }
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIdle === undefined) delete process.env.SESSION_IDLE_MINUTES;
  else process.env.SESSION_IDLE_MINUTES = originalIdle;
  delete process.env.SESSION_PRUNE_MINUTES;
});

afterAll(() => {
  if (originalStore === undefined) delete process.env.SESSION_STORE;
  else process.env.SESSION_STORE = originalStore;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
});

async function signIn() {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form')
    .send({ username: DRIVER.username, password: PASSWORD });
  expect(res.status).toBe(302);
  return agent;
}

const onlyRow = () => {
  expect(sessionRows.size).toBe(1);
  const [sid] = [...sessionRows.keys()];
  return { sid, row: sessionRows.get(sid) };
};

describe('signing in', () => {
  test('writes the session to the table', async () => {
    await signIn();

    const { row } = onlyRow();
    expect(JSON.parse(row.data).user).toMatchObject({ id: 1, username: 'driver1', role: 'driver' });
  });

  test('keeps no password anywhere in the stored row', async () => {
    await signIn();

    const { row } = onlyRow();
    expect(row.data).not.toContain(PASSWORD);
    expect(row.data).not.toContain(passwordHash);
  });

  test('gives the row an expiry well past the idle limit', async () => {
    await signIn();

    // The row has to outlive the session itself, or an expired visitor could
    // not be told that their session expired (see session-store.js).
    const { row } = onlyRow();
    expect(row.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });
});

describe('a session this process never created', () => {
  // This is the story: a deployment restarts the process, and the people using
  // the site stay signed in because their session is a row, not a variable.
  test('is honoured, so a restart does not sign anyone out', async () => {
    const sid = 'rowFromAnEarlierProcess0001';
    sessionRows.set(sid, { data: sessionJson(), expiresAt: Date.now() + 60 * 60 * 1000 });

    const res = await request(app).post('/session/keep-alive').set('Cookie', cookieFor(sid));

    expect(res.status).toBe(200);
    expect(res.body.remainingMs).toBeGreaterThan(0);
  });

  test('is read fresh on every request, not cached in the process', async () => {
    const agent = await signIn();
    const { sid } = onlyRow();

    // Rewrite the row as another instance might have, leaving the session
    // untouched for too long. The next request must see that, not its own copy.
    sessionRows.get(sid).data = sessionJson({ lastActivity: Date.now() - 60 * 60 * 1000 });

    const res = await agent.post('/session/keep-alive');
    expect(res.status).toBe(401);
  });

  test('with an expiry in the past is ignored', async () => {
    const sid = 'rowThatAgedOut000000000001';
    sessionRows.set(sid, { data: sessionJson(), expiresAt: Date.now() - 1000 });

    const res = await request(app).post('/session/keep-alive').set('Cookie', cookieFor(sid));
    expect(res.status).toBe(401);
  });
});

describe('the session features still behave', () => {
  test('an idle session expires and its row is removed', async () => {
    process.env.SESSION_IDLE_MINUTES = '0.001';   // about a tenth of a second
    const agent = await signIn();
    expect(sessionRows.size).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 150));
    const res = await agent.post('/session/keep-alive');

    expect(res.status).toBe(401);
    // Story 22204 destroyed the session; with a store that has to reach the
    // table, or expired sessions would linger and stay usable.
    expect(sessionRows.size).toBe(0);
  });

  test('an expired page request is still told the session expired', async () => {
    process.env.SESSION_IDLE_MINUTES = '0.001';
    const agent = await signIn();

    await new Promise(resolve => setTimeout(resolve, 150));
    const res = await agent.get('/');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?expired=1');
  });

  test('the expiry warning still gets its countdown', async () => {
    delete process.env.SESSION_IDLE_MINUTES;
    const agent = await signIn();

    const res = await agent.get('/');

    // Story AA-12: the browser reads these two numbers off the page.
    expect(res.text).toMatch(/data-session-remaining="\d+"/);
    expect(res.text).toMatch(/data-session-warning="\d+"/);
  });

  test('staying signed in keeps the session and its row alive', async () => {
    const agent = await signIn();
    const { sid } = onlyRow();

    const res = await agent.post('/session/keep-alive');

    expect(res.status).toBe(200);
    expect(sessionRows.has(sid)).toBe(true);
  });

  test('signing out of all sessions refuses the session and clears the row', async () => {
    const agent = await signIn();
    revoked = 1;                 // the account's cutoff has moved past this session

    const res = await agent.post('/session/keep-alive');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signed out of all sessions/i);
    expect(sessionRows.size).toBe(0);
  });

  test('signing out normally removes the row too', async () => {
    const agent = await signIn();

    await agent.post('/logout').expect(302);

    expect(sessionRows.size).toBe(0);
  });
});

describe('clearing out expired rows', () => {
  test('expired rows go and live ones stay', async () => {
    sessionRows.set('live', { data: sessionJson(), expiresAt: Date.now() + 60 * 1000 });
    sessionRows.set('stale', { data: sessionJson(), expiresAt: Date.now() - 60 * 1000 });

    expect(await pruneExpiredSessions()).toBe(1);
    expect([...sessionRows.keys()]).toEqual(['live']);
  });

  test('the sweep runs hourly by default and can be tuned', () => {
    delete process.env.SESSION_PRUNE_MINUTES;
    expect(pruneIntervalMs()).toBe(60 * 60 * 1000);

    process.env.SESSION_PRUNE_MINUTES = '5';
    expect(pruneIntervalMs()).toBe(5 * 60 * 1000);
  });

  test('pruning starts straight away and does not hold the process open', async () => {
    sessionRows.set('stale', { data: sessionJson(), expiresAt: Date.now() - 1000 });

    const timer = startPruning();
    try {
      await vi.waitUntil(() => sessionRows.size === 0);
      // An unref'd timer cannot be the reason a process refuses to exit.
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  test('a failed sweep is logged, not thrown at whoever is serving requests', async () => {
    db.query.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const log = { error: vi.fn() };

    const timer = startPruning(log);
    try {
      await vi.waitUntil(() => log.error.mock.calls.length > 0);
      expect(log.error.mock.calls[0].join(' ')).toMatch(/expired sessions.*ETIMEDOUT/);
    } finally {
      clearInterval(timer);
    }
  });
});
