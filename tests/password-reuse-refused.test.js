// Story 28211 (AA-79), the enforcing half: a password an account has used
// recently cannot be set again. The record kept by the other half
// (tests/password-history.test.js) is what makes this answerable; here it is
// read back and a password that is in it is refused, on every form that sets
// one.
//
// bcrypt at cost 12 is deliberately slow, and this file does several
// comparisons per request, so the tests carry their own timeouts rather than
// the 5s default.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { PASSWORD_HISTORY_LIMIT } = require('../src/auth/password-policy');
const { updateUserPassword, SamePasswordError } = require('../src/users/store');

const PASSWORD = 'Password1!';      // what every account is using now
const OLD_PASSWORD = 'Retired7%';   // what driver1 used before that
const UNUSED = 'NeverSeen3@';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: 'd@example.com' },
  { id: 5, username: 'driver2', role: 'driver', status: 'active', email: 'd2@example.com' },
];
// Stands in for a hash of a password nothing in these tests ever types. bcrypt
// reads it as "no match" rather than refusing it, which is what keeps a damaged
// row in this table from breaking a password change.
const filler = n => `$2b$12$filler-row-number-${n}`;

let currentHash;
let oldHash;
let stored;    // user id -> the hash in users
let history;   // password_history rows, read back the way the store reads them
let resets;
let nextId;
let logs;

beforeAll(async () => {
  currentHash = await hashPassword(PASSWORD);
  oldHash = await hashPassword(OLD_PASSWORD);
}, 30_000);

beforeEach(() => {
  stored = { 1: currentHash, 3: currentHash, 5: currentHash };
  history = [];
  resets = [];
  nextId = 0;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
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
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];

    // --- password_history ---
    const forUser = id => history.filter(r => r.user_id === id).sort((a, b) => b.id - a.id);
    if (sql.startsWith('SELECT password_hash FROM password_history')) {
      return forUser(params[0]).slice(0, params[1]).map(r => ({ password_hash: r.password_hash }));
    }
    if (sql.startsWith('SELECT id FROM password_history')) {
      return forUser(params[0]).slice(0, params[1]).map(r => ({ id: r.id }));
    }
    if (sql.startsWith('INSERT INTO password_history')) {
      history.push({ id: ++nextId, user_id: params[0], password_hash: params[1] });
      return { insertId: nextId };
    }
    if (sql.startsWith('DELETE FROM password_history')) {
      const [user_id, below] = params;
      const before = history.length;
      history = history.filter(r => !(r.user_id === user_id && r.id < below));
      return { affectedRows: before - history.length };
    }

    // --- reset links, kept honestly so a refusal can be shown not to spend one ---
    if (sql.includes('COUNT(*) AS requests FROM password_resets')) return [{ requests: 0 }];
    if (sql.startsWith('INSERT INTO password_resets')) {
      const [user_id, token_hash, minutes] = params;
      resets.push({ id: resets.length + 1, user_id, token_hash, expires_at: new Date(Date.now() + minutes * 60000), used_at: null });
      return { insertId: resets.length };
    }
    if (sql.includes('FROM password_resets r')) {
      return resets
        .filter(r => r.token_hash === params[0] && !r.used_at && r.expires_at > new Date())
        .map(r => { const u = users.find(x => x.id === r.user_id); return { id: r.id, userId: u.id, username: u.username, status: u.status }; });
    }
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE id')) {
      const row = resets.find(r => r.id === params[0] && !r.used_at);
      if (row) row.used_at = new Date();
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) {
      let n = 0;
      for (const r of resets) if (r.user_id === params[0] && !r.used_at) { r.used_at = new Date(); n++; }
      return { affectedRows: n };
    }

    // --- passwords ---
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const [hash, id] = params;
      stored[id] = hash;
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO password_changes')) return { insertId: 1 };

    // --- sessions ---
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// driver1 used OLD_PASSWORD before the one it has now.
function seedOldPassword(userId = 1) {
  history.push({ id: ++nextId, user_id: userId, password_hash: oldHash });
}
const writes = () => db.query.mock.calls
  .map(([sql]) => sql)
  .filter(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/login_attempts/i.test(sql));

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

async function requestLink(username) {
  logs.length = 0;
  await request(app).post('/forgot-password').type('form').send({ username }).expect(200);
  return logs.join('\n').match(/\/reset-password\/([a-f0-9]{64})/)[1];
}
const useLink = (token, password) => request(app).post(`/reset-password/${token}`).type('form')
  .send({ newPassword: password, confirmPassword: password });

async function adminSets(agent, userId, password) {
  const page = await agent.get(`/admin/manage-users/${userId}/password?from=manage-users`).expect(200);
  return await agent.post(`/admin/manage-users/${userId}/password`).type('form').send({
    token: hidden(page, 'token'), from: 'manage-users',
    newPassword: password, confirmPassword: password,
  });
}

describe('a password the account used before is refused', () => {
  test('on the profile form, which asks for the current one', async () => {
    const agent = await login('driver1');
    seedOldPassword();

    const res = await changeOwnPassword(agent, OLD_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.text).toContain('used that password before');
    expect(writes()).toEqual([]);
    expect(stored[1]).toBe(currentHash);
  }, 30_000);

  test('on the emailed link, without spending it', async () => {
    const token = await requestLink('driver1');
    seedOldPassword();
    db.query.mockClear();

    const res = await useLink(token, OLD_PASSWORD).expect(400);

    expect(res.text).toContain('used that password before');
    expect(writes()).toEqual([]);
    expect(resets[0].used_at).toBeNull();
    // And the link is still good for a password the account has not had.
    await useLink(token, UNUSED).expect(303);
  }, 30_000);

  test('on an admin reset, named as the account holder', async () => {
    const agent = await login('admin1');
    seedOldPassword();

    const res = await adminSets(agent, 1, OLD_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.text).toContain('driver1 has used that password before');
    expect(stored[1]).toBe(currentHash);
  }, 30_000);

  test('and the store is the one refusing it, so no route can forget to', async () => {
    seedOldPassword();

    await expect(updateUserPassword(1, OLD_PASSWORD, { method: 'reset-link' }))
      .rejects.toThrow(SamePasswordError);
    expect(writes()).toEqual([]);
  }, 30_000);
});

describe('what the rule does not reach', () => {
  test(`a password older than the last ${PASSWORD_HISTORY_LIMIT} can be used again`, async () => {
    // The limit is a real edge, not a detail: the rows beyond it are deleted as
    // the account goes, so there is nothing left to compare against. Oldest
    // first here, so the real hash is the one that falls off the end.
    seedOldPassword();
    for (let i = 0; i < PASSWORD_HISTORY_LIMIT; i++) {
      history.push({ id: ++nextId, user_id: 1, password_hash: filler(i) });
    }

    expect((await changeOwnPassword(await login('driver1'), OLD_PASSWORD)).status).toBe(200);
    expect(stored[1]).not.toBe(currentHash);
  }, 30_000);

  test("another account's old password is none of this account's business", async () => {
    seedOldPassword(5);   // driver2 used it, driver1 did not

    expect((await changeOwnPassword(await login('driver1'), OLD_PASSWORD)).status).toBe(200);
  }, 30_000);

  test('a password the account has never had goes through and is then remembered', async () => {
    seedOldPassword();

    expect((await changeOwnPassword(await login('driver1'), UNUSED)).status).toBe(200);
    // The old hash is still there, and the new one has joined it.
    expect(history.filter(r => r.user_id === 1).map(r => r.password_hash))
      .toEqual([oldHash, stored[1]]);
  }, 30_000);
});
