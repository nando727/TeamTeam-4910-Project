// Backlog AA-13: the store side of "sign out of all sessions at once".
//
// The fake below mimics what MySQL does with the real column: it keeps a
// timestamp and answers the comparison itself, because that comparison lives
// in SQL on purpose (see sessionsRevokedSince).
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { revokeSessions, sessionsRevokedSince } = require('../src/users/store');

let cutoff;      // what the users table holds for account 1
let lastSql;

beforeEach(() => {
  cutoff = null;

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    lastSql = sql;
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) {
      if (params[0] === 1) cutoff = new Date();
      return { affectedRows: params[0] === 1 ? 1 : 0 };
    }
    if (sql.startsWith('SELECT sessions_valid_from')) {
      const [issuedAtMs, id] = params;
      if (id !== 1) return [];
      // MySQL's answer: NULL > anything is NULL, which is not true.
      return [{ revoked: cutoff && cutoff.getTime() > issuedAtMs ? 1 : 0 }];
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('before anything is revoked', () => {
  test('no session is treated as revoked', async () => {
    expect(await sessionsRevokedSince(1, Date.now())).toBe(false);
  });

  test('not even one with no issue time', async () => {
    expect(await sessionsRevokedSince(1, 0)).toBe(false);
  });
});

describe('after revoking', () => {
  test('a session issued earlier is revoked', async () => {
    const issuedAt = Date.now() - 5000;
    await revokeSessions(1);

    expect(await sessionsRevokedSince(1, issuedAt)).toBe(true);
  });

  test('a session issued afterwards is not', async () => {
    await revokeSessions(1);

    expect(await sessionsRevokedSince(1, Date.now() + 5000)).toBe(false);
  });

  test('a session with no issue time is revoked', async () => {
    await revokeSessions(1);

    expect(await sessionsRevokedSince(1, 0)).toBe(true);
  });

  test('it is scoped to one account', async () => {
    await revokeSessions(1);

    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([1]);
  });
});

describe('how the comparison is made', () => {
  test('the database stamps the cutoff, not the app', async () => {
    await revokeSessions(1);
    expect(lastSql).toContain('NOW(3)');
  });

  test('milliseconds are kept, since a revocation can share a second with a login', async () => {
    await revokeSessions(1);
    expect(lastSql).not.toMatch(/NOW\(\)/);
  });

  test('the two times are compared in SQL, never parsed into a JS Date', async () => {
    // Reading a DATETIME into Node reinterprets it in the machine's local
    // zone: on a UTC database and an eastern laptop that lands hours out and
    // refuses every session. Letting MySQL compare keeps one zone.
    await sessionsRevokedSince(1, Date.now());
    expect(lastSql).toContain('FROM_UNIXTIME');
  });

  test('an unknown account is not treated as revoked', async () => {
    expect(await sessionsRevokedSince(999, 0)).toBe(false);
  });
});
