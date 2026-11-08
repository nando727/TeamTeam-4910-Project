// Audit log requirement: password changes are recorded, the way login attempts
// already were. Nothing used to record them at all -- password_resets holds
// reset tokens, so it says a link was requested, not that a password changed.
//
// The row never holds the password or its hash: whose password changed, who
// changed it, how, and when.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { updateUserPassword } = require('../src/users/store');
const { hashToken } = require('../src/auth/setup-tokens');
const { hashToken: hashResetToken } = require('../src/auth/password-reset');

const PASSWORD = 'Password1!';
const NEW_PASSWORD = 'BrandNew1!';
const SETUP_TOKEN = 'a-setup-link-for-driver-two';
const RESET_TOKEN = 'c'.repeat(64);

const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada Admin', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Dee Driver', email: 'd@example.com' },
  { id: 4, username: 'driver2', role: 'driver', status: 'active', name: 'Dan Driver', email: 'd2@example.com' },
];

let passwordHash;
let changes;      // fake password_changes
let tokens;       // fake setup_tokens
let resets;       // fake password_resets

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  changes = [];
  tokens = [{ id: 1, user_id: 4, token_hash: hashToken(SETUP_TOKEN), expires_at: new Date(Date.now() + 3600_000), used_at: null }];
  resets = [{ id: 1, user_id: 1, token_hash: hashResetToken(RESET_TOKEN), used_at: null }];

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO password_changes')) {
      const [user_id, changed_by_user_id, method] = params;
      changes.push({ user_id, changed_by_user_id, method, params });
      return { insertId: changes.length };
    }

    // Story AA-79: the hash now in force is remembered so it cannot be
    // reused. No rows here, so there is never anything to prune.
    if (sql.startsWith('INSERT INTO password_history')) return { insertId: 1 };
    if (sql.startsWith('SELECT id FROM password_history')) return [];

    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.includes('UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.includes('COUNT(*) AS count FROM login_attempts')) return [{ count: 0 }];
    if (sql.startsWith('UPDATE users SET password_hash')) return { affectedRows: 1 };
    // consumeToken spends the link being used; the voiding that follows a
    // password write (story 22225) finds nothing left to spend.
    if (sql.startsWith('UPDATE setup_tokens SET used_at = NOW() WHERE id =')) {
      const row = tokens.find(t => t.id === params[0] && !t.used_at);
      if (!row) return { affectedRows: 0 };
      row.used_at = new Date();
      return { affectedRows: 1 };
    }
    // Story AA-27: setting a password also voids any pending reset link.
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) return { affectedRows: 0 };
    if (sql.startsWith('UPDATE setup_tokens SET used_at = NOW() WHERE user_id =')) {
      const spent = tokens.filter(t => t.user_id === params[0] && !t.used_at);
      spent.forEach(t => { t.used_at = new Date(); });
      return { affectedRows: spent.length };
    }

    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, password_hash: passwordHash }));
    }
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash, sponsor_id: null }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;

    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      const row = tokens.find(t => t.token_hash === params[0] && !t.used_at && t.expires_at > new Date());
      return row ? [row] : [];
    }
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];
    if (sql.includes('FROM password_resets r')) {
      const row = resets.find(r => r.token_hash === params[0] && !r.used_at);
      return row ? [{ id: row.id, userId: row.user_id, username: 'driver1', status: 'active' }] : [];
    }
    if (sql.startsWith('UPDATE password_resets SET used_at')) {
      const row = resets.find(r => r.id === params[0] && !r.used_at);
      if (!row) return { affectedRows: 0 };
      row.used_at = new Date();
      return { affectedRows: 1 };
    }

    return [];
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

const formTokenFrom = page => page.text.match(/name="token" value="([^"]+)"/)[1];

// The expected status is asserted here, so a caller just awaits it.
async function changeOwnPassword(agent, { currentPassword = PASSWORD, status = 200 } = {}) {
  const form = await agent.get('/profile/password').expect(200);
  return agent.post('/profile/password').type('form').send({
    token: formTokenFrom(form), currentPassword,
    newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
  }).expect(status);
}

describe('every way a password can be set is recorded', () => {
  test('a user changing their own password', async () => {
    const agent = await login('driver1');

    await changeOwnPassword(agent);

    expect(changes).toEqual([{ user_id: 1, changed_by_user_id: 1, method: 'profile', params: expect.anything() }]);
  });

  test('an administrator resetting someone else', async () => {
    const agent = await login('admin1');
    const form = await agent.get('/admin/manage-users/1/password').expect(200);

    await agent.post('/admin/manage-users/1/password').type('form').send({
      token: formTokenFrom(form), newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(303);

    // Whose account, and which admin did it.
    expect(changes[0]).toMatchObject({ user_id: 1, changed_by_user_id: 3, method: 'admin-reset' });
  });

  test('a reset from an emailed link, where nobody is signed in', async () => {
    await request(app).post(`/reset-password/${RESET_TOKEN}`).type('form').send({
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(303);

    expect(changes[0]).toMatchObject({ user_id: 1, changed_by_user_id: null, method: 'reset-link' });
  });

  test('claiming an account with a setup link', async () => {
    const visitor = request.agent(app);
    const page = await visitor.get(`/setup/${SETUP_TOKEN}`).expect(200);

    await visitor.post(`/setup/${SETUP_TOKEN}`).type('form').send({
      token: formTokenFrom(page), password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(302);

    expect(changes[0]).toMatchObject({ user_id: 4, changed_by_user_id: null, method: 'setup-link' });
  });
});

describe('who the log blames', () => {
  test('an impersonating admin, not the account they are acting as', async () => {
    // The session belongs to driver1, but the person at the keyboard is admin1
    // and the log has to say so or it points at the wrong person.
    const agent = await login('admin1');
    const list = await agent.get('/admin/manage-users').expect(200);
    await agent.post('/admin/impersonate/1').type('form').send({ token: formTokenFrom(list) }).expect(303);

    await changeOwnPassword(agent);

    expect(changes[0]).toMatchObject({ user_id: 1, changed_by_user_id: 3, method: 'profile' });
  });
});

describe('what is never written, and what is never missed', () => {
  test('neither the password nor its hash reaches the log', async () => {
    const agent = await login('driver1');

    await changeOwnPassword(agent);

    const written = JSON.stringify(changes[0].params);
    expect(written).not.toContain(NEW_PASSWORD);
    expect(written).not.toContain('$2b$');
  });

  test('a rejected change records nothing', async () => {
    const agent = await login('driver1');

    await changeOwnPassword(agent, { currentPassword: 'not-my-password', status: 400 });

    expect(changes).toEqual([]);
  });

  test('a caller that says nothing about how is still recorded, as unknown', async () => {
    // A password change nobody can account for is the thing the log exists to
    // show, so a missing method must never be the quiet case.
    await updateUserPassword(1, NEW_PASSWORD);

    expect(changes[0]).toMatchObject({ user_id: 1, changed_by_user_id: null, method: 'unknown' });
  });

  test('an invented method is recorded as unknown rather than stored as given', async () => {
    await updateUserPassword(1, NEW_PASSWORD, { method: 'something-made-up', changedBy: 3 });

    expect(changes[0]).toMatchObject({ method: 'unknown', changed_by_user_id: 3 });
  });
});
