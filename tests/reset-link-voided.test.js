// Story AA-27 (22229): a reset link stops working the moment the password it
// would have changed is changed some other way. Someone asks for a link, then
// gets back into the account another way and changes the password -- the link
// is still sitting in an inbox, and until now it still worked.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const NEW_PASSWORD = 'FreshStart9#';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: 'd@example.com' },
  { id: 5, username: 'driver2', role: 'driver', status: 'active', email: 'd2@example.com' },
];

let passwordHash;
let resets;   // password_resets rows, with a real used_at
let logs;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

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
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    // Checked before the row lookup below, which its SQL also matches.
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      const user = users.find(u => u.id === params[0]);
      return user ? [{ id: user.id, username: user.username, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null }));
    }

    // --- reset links, kept honestly so a voided one really stops working ---
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
    // The statement this story adds.
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) {
      let n = 0;
      for (const r of resets) if (r.user_id === params[0] && !r.used_at) { r.used_at = new Date(); n++; }
      return { affectedRows: n };
    }

    // --- passwords ---
    if (sql.startsWith('UPDATE users SET password_hash')) return { affectedRows: 1 };
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

// Asks for a link the way a locked-out person would, and reads it back out of
// the console the server writes mail to in a test run.
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

async function changeOwnPassword(agent, fields = {}) {
  const page = await agent.get('/profile/password').expect(200);
  return await agent.post('/profile/password').type('form').send({
    token: hidden(page, 'token'),
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
    ...fields,
  });
}

async function adminResets(agent, userId) {
  const page = await agent.get(`/admin/manage-users/${userId}/password?from=manage-users`).expect(200);
  return await agent.post(`/admin/manage-users/${userId}/password`).type('form').send({
    token: hidden(page, 'token'),
    from: 'manage-users',
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
  });
}

describe('a pending link does not survive a password change', () => {
  test('changing your own password kills the link waiting in your inbox', async () => {
    const token = await requestLink('driver1');
    await request(app).get(`/reset-password/${token}`).expect(200);

    expect((await changeOwnPassword(await login('driver1'))).status).toBe(200);

    await request(app).get(`/reset-password/${token}`).expect(404);
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'Another1!', confirmPassword: 'Another1!' })
      .expect(404);
  });

  test('an admin reset kills it too', async () => {
    const token = await requestLink('driver1');
    expect((await adminResets(await login('admin1'), 1)).status).toBe(303);
    await request(app).get(`/reset-password/${token}`).expect(404);
  });

  test('only that account loses its link', async () => {
    const mine = await requestLink('driver1');
    const theirs = await requestLink('driver2');

    expect((await changeOwnPassword(await login('driver1'))).status).toBe(200);

    await request(app).get(`/reset-password/${mine}`).expect(404);
    await request(app).get(`/reset-password/${theirs}`).expect(200);
  });
});

describe('what a void must not break', () => {
  test('a change that is refused leaves the link alive', async () => {
    const token = await requestLink('driver1');
    expect((await changeOwnPassword(await login('driver1'), { currentPassword: 'WrongPass1!' })).status).toBe(400);
    await request(app).get(`/reset-password/${token}`).expect(200);
  });

  test('a weak new password leaves the link alive', async () => {
    const token = await requestLink('driver1');
    expect((await changeOwnPassword(await login('driver1'), { newPassword: 'short', confirmPassword: 'short' })).status).toBe(400);
    await request(app).get(`/reset-password/${token}`).expect(200);
  });

  test('the link itself still works, and spends only itself', async () => {
    const token = await requestLink('driver1');
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(303)
      .expect('Location', '/login?reset=done');
    expect(resets).toHaveLength(1);
    expect(resets[0].used_at).not.toBeNull();
  });

  test('an account with no link at all changes its password normally', async () => {
    expect((await changeOwnPassword(await login('driver1'))).status).toBe(200);
    expect(resets).toEqual([]);
  });
});
