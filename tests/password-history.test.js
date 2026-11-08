// Story 28211 (AA-79): a password cannot be reused. Nothing could enforce that
// before, because nothing remembered a password once it had been replaced --
// users holds the hash in force now and password_changes holds no hash at all.
// This is the remembering half: every password that is set is recorded as a
// hash, and the record is kept short on purpose.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const { PASSWORD_HISTORY_LIMIT } = require('../src/auth/password-policy');
const { updateUserPassword } = require('../src/users/store');
const { recordPasswordUsed, forgetBeyondLimit } = require('../src/auth/password-history');

const PASSWORD = 'Password1!';
const NEW_PASSWORD = 'FreshStart9#';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: 'd@example.com' },
];

let passwordHash;
let stored;    // user id -> the hash now in users
let history;   // password_history rows, kept honestly so pruning is real
let nextId;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  stored = { 1: passwordHash, 3: passwordHash };
  history = [];
  nextId = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT COUNT(*) AS count FROM login_attempts')) return [{ count: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: stored[user.id] }] : [];
    }
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      const user = users.find(u => u.id === params[0]);
      return user ? [{ id: user.id, username: user.username, password_hash: stored[user.id] }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null }));
    }

    // --- password_history, the table this story adds ---
    if (sql.startsWith('INSERT INTO password_history')) {
      const [user_id, password_hash] = params;
      history.push({ id: ++nextId, user_id, password_hash });
      return { insertId: nextId };
    }
    if (sql.startsWith('SELECT id FROM password_history')) {
      const [user_id, limit] = params;
      return history
        .filter(r => r.user_id === user_id)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(r => ({ id: r.id }));
    }
    if (sql.startsWith('DELETE FROM password_history')) {
      const [user_id, below] = params;
      const before = history.length;
      history = history.filter(r => !(r.user_id === user_id && r.id < below));
      return { affectedRows: before - history.length };
    }

    // --- passwords ---
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const [hash, id] = params;
      if (!users.some(u => u.id === id)) return { affectedRows: 0 };
      stored[id] = hash;
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) return { affectedRows: 0 };
    if (sql.startsWith('UPDATE password_resets SET used_at')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO password_changes')) return { insertId: 1 };

    // --- sessions ---
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const hashesFor = id => history.filter(r => r.user_id === id).map(r => r.password_hash);
// Everything that was ever handed to the database, flattened, so a plaintext
// password can be looked for in all of it at once.
const everyParam = () => db.query.mock.calls.flatMap(([, params]) => params || []).map(String);

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}
const hidden = (page, name) => page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];

async function changeOwnPassword(agent, newPassword) {
  const page = await agent.get('/profile/password').expect(200);
  return await agent.post('/profile/password').type('form').send({
    token: hidden(page, 'token'),
    currentPassword: PASSWORD, newPassword, confirmPassword: newPassword,
  });
}

describe('a password that is set is remembered', () => {
  test('changing your own password records the hash that was stored, and no password', async () => {
    expect((await changeOwnPassword(await login('driver1'), NEW_PASSWORD)).status).toBe(200);

    expect(hashesFor(1)).toEqual([stored[1]]);
    expect(await verifyPassword(NEW_PASSWORD, hashesFor(1)[0])).toBe(true);
    // The row is a hash of it, which is not the same thing as a copy of it.
    expect(hashesFor(1)[0]).not.toContain(NEW_PASSWORD);
    expect(everyParam()).not.toContain(NEW_PASSWORD);
  });

  test('every path that sets a password records one, because the store does it', async () => {
    // Not four routes driven four ways: the point of this story riding on
    // updateUserPassword is that the route cannot opt out.
    const byMethod = [
      ['profile', 'Profile1!'], ['admin-reset', 'AdminSet2@'],
      ['reset-link', 'ResetLink3#'], ['setup-link', 'SetupLink4$'],
    ];
    for (const [method, password] of byMethod) {
      expect(await updateUserPassword(1, password, { method, changedBy: 3 })).toBe(true);
    }

    expect(hashesFor(1)).toHaveLength(4);
    expect(new Set(hashesFor(1)).size).toBe(4);   // a fresh hash each time
    // Four passwords set means eight bcrypt operations at cost 12 -- four
    // hashes and the four comparisons story AA-29 makes first. That is slower
    // than vitest's 5s default allows for when the whole suite is running.
  }, 30_000);

  test('a change that was refused records nothing', async () => {
    // The same password as the one on the account: story AA-29 refuses it
    // before anything is written, and that has to include this table.
    await expect(updateUserPassword(1, PASSWORD, { method: 'profile' })).rejects.toThrow();
    expect(history).toEqual([]);
  });

  test('a write that changed no row records nothing', async () => {
    expect(await updateUserPassword(999, NEW_PASSWORD, { method: 'admin-reset' })).toBe(false);
    expect(history).toEqual([]);
  });
});

describe('the record is kept short', () => {
  const setMany = async (userId, count) => {
    for (let i = 0; i < count; i++) await recordPasswordUsed(userId, `$2b$12$hash-number-${i}`);
  };

  test(`an account keeps its newest ${PASSWORD_HISTORY_LIMIT} and no more`, async () => {
    await setMany(1, PASSWORD_HISTORY_LIMIT + 4);

    const kept = hashesFor(1);
    expect(kept).toHaveLength(PASSWORD_HISTORY_LIMIT);
    // The ones it dropped are the oldest, not an arbitrary few.
    expect(kept[0]).toBe(`$2b$12$hash-number-${4}`);
    expect(kept.at(-1)).toBe(`$2b$12$hash-number-${PASSWORD_HISTORY_LIMIT + 3}`);
  });

  test('nothing is deleted while the account is still under the limit', async () => {
    await setMany(1, PASSWORD_HISTORY_LIMIT);

    expect(hashesFor(1)).toHaveLength(PASSWORD_HISTORY_LIMIT);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM password_history'))).toBe(false);
  });

  test('pruning one account never touches another', async () => {
    await setMany(3, 2);
    await setMany(1, PASSWORD_HISTORY_LIMIT + 3);

    expect(hashesFor(3)).toHaveLength(2);
    expect(hashesFor(1)).toHaveLength(PASSWORD_HISTORY_LIMIT);
  });

  test('pruning an account with no history at all is a no-op', async () => {
    expect(await forgetBeyondLimit(1)).toBe(0);
    expect(history).toEqual([]);
  });
});

describe('the migration', () => {
  const migration = readFileSync(new URL('../db/migrations/021_password_history.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const table = text => text.match(/CREATE TABLE IF NOT EXISTS password_history \([\s\S]*?\n\);/)[0];

  test('and the schema file define the same table', () => {
    expect(table(schema)).toBe(table(migration));
  });

  test('can be rerun, which db:migrate does on every run', () => {
    // Without the NOT EXISTS, a second run would fill the table with a second
    // copy of every account's current hash.
    expect(migration).toMatch(/NOT EXISTS \(SELECT 1 FROM password_history h WHERE h\.user_id = u\.id\)/);
  });

  test("skips accounts that have no password yet rather than seeding a placeholder", () => {
    expect(migration).toContain("u.password_hash LIKE '$2%'");
  });
});
