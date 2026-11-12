// Story 22232 (AA-29): a new password has to be a new password. Two of the four
// ways a password gets set never asked for the old one, so "change" it to the
// one already on the account and the app would spend the link, sign every
// session out, and write an audit row for a change that changed nothing.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const SPONSOR_OPTIONS = [{ id: 7, name: 'Northstar Freight', contactEmail: 'ops@northstar.test', status: 'active' }];
const { hashPassword, NO_PASSWORD } = require('../src/auth/password');
const { updateUserPassword, matchesRecentPassword, SamePasswordError } = require('../src/users/store');

const PASSWORD = 'Password1!';
const DIFFERENT = 'FreshStart9#';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: 'd@example.com' },
  // Created by a bulk upload and never claimed: no usable password at all.
  { id: 7, username: 'driver7', role: 'driver', status: 'active', email: 'd7@example.com' },
];

let hashes;   // user id -> stored password_hash
let resets;   // password_resets rows, with a real used_at
let logs;

beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  hashes = { 3: hash, 1: hash, 7: NO_PASSWORD };
});

beforeEach(() => {
  resets = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT COUNT(*) AS count FROM login_attempts')) return [{ count: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hashes[user.id] }] : [];
    }
    // Checked before the row lookup below, which its SQL also matches. This is
    // the lookup the rule in this story runs.
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      const user = users.find(u => u.id === params[0]);
      return user ? [{ id: user.id, username: user.username, password_hash: hashes[user.id] }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null }));
    }
    // Sprint 9: Manage users is searched, filtered, counted, and paged, so the
    // page reads a count, one page of accounts, and the sponsor filter list.
    if (sql.startsWith('SELECT COUNT(*) AS total FROM users u')) return [{ total: users.length }];
    if (sql.startsWith('SELECT u.id, u.name, u.email, u.username, u.role, u.status')) return users;
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail')) return SPONSOR_OPTIONS;
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];

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
      hashes[id] = hash;
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO password_changes')) return { insertId: 1 };
    // Story AA-79: the hash now in force is remembered so it cannot be
    // reused. No rows here, so there is never anything to prune.
    if (sql.startsWith('INSERT INTO password_history')) return { insertId: 1 };
    if (sql.startsWith('SELECT id FROM password_history')) return [];
    if (sql.startsWith('SELECT password_hash FROM password_history')) return [];

    // --- sessions ---
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// Every statement that would change something, so a refusal can be shown to
// have changed nothing at all rather than merely to have skipped the UPDATE.
const writes = () => db.query.mock.calls
  .map(([sql]) => sql)
  .filter(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/login_attempts/i.test(sql));

async function requestLink(username) {
  logs.length = 0;
  await request(app).post('/forgot-password').type('form').send({ username }).expect(200);
  const match = logs.join('\n').match(/\/reset-password\/([a-f0-9]{64})/);
  expect(match).not.toBeNull();
  return match[1];
}

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

const hidden = (page, name) => page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];

function useLink(token, password) {
  return request(app).post(`/reset-password/${token}`).type('form')
    .send({ newPassword: password, confirmPassword: password });
}

async function adminSets(agent, userId, password) {
  const page = await agent.get(`/admin/manage-users/${userId}/password?from=manage-users`).expect(200);
  return await agent.post(`/admin/manage-users/${userId}/password`).type('form').send({
    token: hidden(page, 'token'), from: 'manage-users',
    newPassword: password, confirmPassword: password,
  });
}

describe('the emailed link refuses the password already on the account', () => {
  test('the page says so and nothing is written', async () => {
    const token = await requestLink('driver1');
    // Asking for the link wrote rows of its own; only what the submit below
    // does is on trial here.
    db.query.mockClear();
    const res = await useLink(token, PASSWORD).expect(400);

    expect(res.text).toContain('used that password before');
    expect(writes()).toEqual([]);
  });

  test('the refusal does not spend the link, so a real new password still works', async () => {
    const token = await requestLink('driver1');
    await useLink(token, PASSWORD).expect(400);

    expect(resets[0].used_at).toBeNull();
    await useLink(token, DIFFERENT).expect(303).expect('Location', '/login?reset=done');
    expect(resets[0].used_at).not.toBeNull();
  });

  test('the account keeps the password it had', async () => {
    const token = await requestLink('driver1');
    await useLink(token, PASSWORD).expect(400);

    await login('driver1');   // the old password still signs in
  });
});

describe('an admin reset refuses it too', () => {
  test('the page names the account and nothing is written', async () => {
    const res = await adminSets(await login('admin1'), 1, PASSWORD);

    expect(res.status).toBe(400);
    expect(res.text).toContain('driver1 has used that password before');
    expect(writes()).toEqual([]);
  });

  test('a genuinely different password still goes through', async () => {
    const res = await adminSets(await login('admin1'), 1, DIFFERENT);

    expect(res.status).toBe(303);
    expect(writes().some(sql => /^UPDATE users SET password_hash/.test(sql))).toBe(true);
  });
});

describe('the rule lives in the store, so no route can forget it', () => {
  test('a refused change leaves the account exactly as it was', async () => {
    await expect(updateUserPassword(1, PASSWORD, { method: 'profile', changedBy: 1 }))
      .rejects.toThrow(SamePasswordError);

    // No new hash, no spent links, and above all no audit row: the log must
    // not record a password change that was refused.
    expect(writes()).toEqual([]);
  });

  test('it knows the current password from any other one', async () => {
    // With no history rows, the current hash in users is the whole answer.
    // tests/password-reuse-refused.test.js covers it with history as well.
    expect(await matchesRecentPassword(1, PASSWORD)).toBe(true);
    expect(await matchesRecentPassword(1, DIFFERENT)).toBe(false);
    expect(await matchesRecentPassword(999, PASSWORD)).toBe(false);
  });

  test('an unclaimed account matches nothing, so a setup link is never refused', async () => {
    // Its stored value is a placeholder, not a hash. Even handed the
    // placeholder itself, nothing verifies against it.
    expect(await matchesRecentPassword(7, NO_PASSWORD)).toBe(false);
    expect(await matchesRecentPassword(7, PASSWORD)).toBe(false);
    await expect(updateUserPassword(7, PASSWORD, { method: 'setup-link' })).resolves.toBe(true);
  });
});
