// Story AA-71: sessions are stored in MySQL instead of in the web server's
// memory, so a deployment no longer signs everyone out.
//
// This covers the store itself. That the app still times sessions out, warns
// before expiry and signs out everywhere is covered by the test files named
// for those features.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { MysqlSessionStore, rowLifetimeMs } = require('../src/auth/session-store');

const originalEnv = { ...process.env };

const SID = 'kqX3Vb1t9rLmQ0aZ7wP2sJ8n';
const SESSION = {
  cookie: { httpOnly: true, path: '/', sameSite: 'lax' },
  user: { id: 4, username: 'driver1', role: 'driver', sponsor_id: null },
  lastActivity: 1770000000000,
};

let store;
let calls;        // every [sql, params] the store sent
let rows;         // what the fake sessions table answers with

// Promise-wrapped callbacks, so a test can await the store.
const get = (sid) => new Promise((resolve, reject) =>
  store.get(sid, (err, session) => (err ? reject(err) : resolve(session))));
const set = (sid, session) => new Promise((resolve, reject) =>
  store.set(sid, session, (err) => (err ? reject(err) : resolve())));
const touch = (sid, session) => new Promise((resolve, reject) =>
  store.touch(sid, session, (err) => (err ? reject(err) : resolve())));
const destroy = (sid) => new Promise((resolve, reject) =>
  store.destroy(sid, (err) => (err ? reject(err) : resolve())));

const sqlFor = (fragment) => calls.find(([sql]) => sql.includes(fragment));

beforeEach(() => {
  store = new MysqlSessionStore();
  calls = [];
  rows = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    calls.push([sql, params]);
    return sql.startsWith('SELECT') ? rows : { affectedRows: 1 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ['SESSION_ROW_HOURS', 'SESSION_IDLE_MINUTES']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('reading a session back', () => {
  test('the session comes back as it was stored', async () => {
    rows = [{ data: JSON.stringify(SESSION) }];

    expect(await get(SID)).toEqual(SESSION);
  });

  test('a session that is not there is reported as no session', async () => {
    rows = [];

    expect(await get(SID)).toBeNull();
  });

  test('an expired row is left out by the database, not by Node', async () => {
    await get(SID);

    // Both halves of the comparison stay inside SQL. A DATETIME read into Node
    // is rebuilt in the machine's local zone, which against a UTC database put
    // timestamps hours out — twice in this project already.
    const [sql] = sqlFor('FROM sessions');
    expect(sql).toContain('expires_at > NOW()');
  });

  test('an unreadable row signs the visitor out instead of breaking every page', async () => {
    rows = [{ data: '{not json at all' }];

    expect(await get(SID)).toBeNull();
    // ...and the bad row is cleared away rather than left to fail again.
    expect(sqlFor('DELETE FROM sessions')).toBeTruthy();
  });

  test('a database failure is reported, not swallowed', async () => {
    db.query.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    await expect(get(SID)).rejects.toThrow('ETIMEDOUT');
  });
});

describe('saving a session', () => {
  test('a new session is written and an existing one is replaced in one statement', async () => {
    await set(SID, SESSION);

    const [sql, params] = sqlFor('INSERT INTO sessions');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(params[0]).toBe(SID);
    expect(JSON.parse(params[1])).toEqual(SESSION);
  });

  test('the session id is a query parameter, never part of the SQL', async () => {
    const hostile = "abc' OR '1'='1";
    await set(hostile, SESSION);

    const [sql, params] = sqlFor('INSERT INTO sessions');
    expect(sql).not.toContain(hostile);
    expect(params).toContain(hostile);
  });

  test('the expiry is handed over as epoch milliseconds', async () => {
    await set(SID, SESSION);

    const [sql, params] = sqlFor('INSERT INTO sessions');
    expect(sql).toContain('FROM_UNIXTIME(? / 1000)');
    // Roughly a day out with the default row lifetime.
    const expiry = params[2];
    expect(expiry).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  test('a cookie with its own expiry decides the row expiry', async () => {
    const expires = new Date(Date.now() + 90 * 60 * 1000);
    await set(SID, { ...SESSION, cookie: { ...SESSION.cookie, expires } });

    const [, params] = sqlFor('INSERT INTO sessions');
    expect(params[2]).toBe(expires.getTime());
  });

  test('a cookie expiry that makes no sense falls back to the row lifetime', async () => {
    await set(SID, { ...SESSION, cookie: { ...SESSION.cookie, expires: 'whenever' } });

    const [, params] = sqlFor('INSERT INTO sessions');
    expect(params[2]).toBeGreaterThan(Date.now());
  });
});

describe('keeping a session alive and ending it', () => {
  test('touching a session only moves its expiry', async () => {
    await touch(SID, SESSION);

    const [sql, params] = sqlFor('UPDATE sessions');
    expect(sql).toContain('expires_at = FROM_UNIXTIME(? / 1000)');
    expect(sql).not.toContain('data =');
    expect(params[1]).toBe(SID);
  });

  test('destroying a session removes the row', async () => {
    await destroy(SID);

    const [sql, params] = sqlFor('DELETE FROM sessions');
    expect(sql).toBe('DELETE FROM sessions WHERE session_id = ?');
    expect(params).toEqual([SID]);
  });
});

describe('how long a row is kept', () => {
  test('a day by default', () => {
    delete process.env.SESSION_ROW_HOURS;
    delete process.env.SESSION_IDLE_MINUTES;

    expect(rowLifetimeMs()).toBe(24 * 60 * 60 * 1000);
  });

  test('configurable for a demo', () => {
    process.env.SESSION_ROW_HOURS = '2';
    delete process.env.SESSION_IDLE_MINUTES;

    expect(rowLifetimeMs()).toBe(2 * 60 * 60 * 1000);
  });

  test('never shorter than two idle windows, however it is set', () => {
    // The point of keeping the row past the idle limit is that an expired
    // visitor can be told their session expired instead of being dropped on
    // the login page as if they had never signed in.
    process.env.SESSION_ROW_HOURS = '1';
    process.env.SESSION_IDLE_MINUTES = '600';   // ten hours

    expect(rowLifetimeMs()).toBe(20 * 60 * 60 * 1000);
  });

  test('nonsense settings fall back to the default', () => {
    process.env.SESSION_ROW_HOURS = 'forever';
    delete process.env.SESSION_IDLE_MINUTES;

    expect(rowLifetimeMs()).toBe(24 * 60 * 60 * 1000);
  });
});
