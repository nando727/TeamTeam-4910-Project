// Backlog AA-13: the store side of "sign out of all sessions at once".
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { revokeSessions, sessionsValidFrom } = require('../src/users/store');

// Stands in for the users table.
let rows;

beforeEach(() => {
  rows = { 1: { id: 1, sessions_valid_from: null } };

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) {
      const [id] = params;
      if (!rows[id]) return { affectedRows: 0 };
      rows[id].sessions_valid_from = new Date();
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT sessions_valid_from')) {
      const [id] = params;
      return rows[id] ? [{ sessions_valid_from: rows[id].sessions_valid_from }] : [];
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('revoking an account\'s sessions', () => {
  test('starts out with nothing revoked', async () => {
    expect(await sessionsValidFrom(1)).toBeNull();
  });

  test('stamps the account with the current time', async () => {
    const before = Date.now();
    const stamped = await revokeSessions(1);

    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test('the stamp is readable afterwards', async () => {
    await revokeSessions(1);
    expect(await sessionsValidFrom(1)).not.toBeNull();
  });

  test('the database clock sets it, not the app clock', async () => {
    await revokeSessions(1);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain('NOW()');
  });

  test('it is scoped to one account', async () => {
    await revokeSessions(1);

    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([1]);
  });

  test('an unknown account reads back as nothing revoked', async () => {
    expect(await sessionsValidFrom(999)).toBeNull();
  });
});
