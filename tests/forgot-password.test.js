// Story: forgot-password flow with a random, hashed, expiring, single-use token.
// With no email service the reset link is printed to the server console.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const { hashToken } = require('../src/auth/password-reset');

const PASSWORD = 'Password1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', email: 'admin1@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: null },
  { id: 5, username: 'driver2', role: 'driver', status: 'disabled', email: null },
];
let passwordHash;
let resets;        // fake password_resets rows
let passwordUpdates;
let logs;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  resets = [];
  passwordUpdates = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null }));
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) {
      let n = 0;
      for (const r of resets) if (r.user_id === params[0] && !r.used_at) { r.used_at = new Date(); n++; }
      return { affectedRows: n };
    }
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
      const r = resets.find(x => x.id === params[0] && !x.used_at && x.expires_at > new Date());
      if (r) r.used_at = new Date();
      return { affectedRows: r ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE users SET password_hash')) { passwordUpdates.push(params); return { affectedRows: 1 }; }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const NEUTRAL = 'If an account with that username exists and is active, a password reset link has been generated.';

async function requestReset(username) {
  const res = await request(app).post('/forgot-password').type('form').send({ username }).expect(200);
  const line = logs.find(l => l.includes('/reset-password/'));
  const token = line ? line.match(/\/reset-password\/([a-f0-9]{64})/)[1] : null;
  return { res, token };
}

describe('forgot password', () => {
  test('the login page links to it and it shows a username form', async () => {
    const login = await request(app).get('/login').expect(200);
    expect(login.text).toContain('href="/forgot-password"');
    const page = await request(app).get('/forgot-password').expect(200);
    expect(page.text).toContain('name="username"');
    expect(page.text).not.toContain('name="email"');
  });

  test('an active account gets a 64-hex token whose SHA-256 hash, not the token, is stored', async () => {
    const { res, token } = await requestReset('driver1');
    expect(res.text).toContain(NEUTRAL);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(resets).toHaveLength(1);
    expect(resets[0].user_id).toBe(1);
    expect(resets[0].token_hash).toBe(hashToken(token));
    expect(resets[0].token_hash).not.toBe(token);
    const insert = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO password_resets'));
    expect(insert[0]).toContain('NOW() + INTERVAL ? MINUTE');
    expect(insert[1][2]).toBe(30);
    // The console "email" mentions the missing address rather than inventing one.
    expect(logs.join('\n')).toContain('(no email on file)');
  });

  test('unknown and disabled usernames get the same page and no token', async () => {
    const unknown = await requestReset('nobody');
    expect(unknown.res.text).toContain(NEUTRAL);
    expect(unknown.token).toBeNull();
    const disabled = await requestReset('driver2');
    expect(disabled.res.text).toContain(NEUTRAL);
    expect(disabled.token).toBeNull();
    expect(resets).toEqual([]);
  });

  test('a blank username is rejected and a signed-in user is sent to change-password', async () => {
    await request(app).post('/forgot-password').type('form').send({ username: '   ' }).expect(400);
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD }).expect(302);
    await agent.get('/forgot-password').expect(302).expect('Location', '/profile/password');
  });

  test('requesting again retires the earlier link', async () => {
    const first = await requestReset('driver1');
    logs.length = 0;
    const second = await requestReset('driver1');
    expect(first.token).not.toBe(second.token);
    await request(app).get(`/reset-password/${first.token}`).expect(404);
    await request(app).get(`/reset-password/${second.token}`).expect(200);
  });
});

describe('reset password with a token', () => {
  test('a valid link shows the form with the rules for the right user', async () => {
    const { token } = await requestReset('driver1');
    const page = await request(app).get(`/reset-password/${token}`).expect(200);
    expect(page.text).toContain('for <strong>driver1</strong>');
    expect(page.text).toContain('data-for="newPassword"');
    expect(page.text).toContain(`action="/reset-password/${token}"`);
    const lookup = db.query.mock.calls.find(([sql]) => sql.includes('FROM password_resets r'));
    expect(lookup[1]).toEqual([hashToken(token)]);
  });

  test('malformed, unknown, and expired links are invalid', async () => {
    for (const bad of ['nope', 'a'.repeat(64), '<script>']) {
      const page = await request(app).get(`/reset-password/${encodeURIComponent(bad)}`).expect(404);
      expect(page.text).toContain('invalid, has already been used, or has expired');
      expect(page.text).toContain('href="/forgot-password"');
    }
    const { token } = await requestReset('driver1');
    resets[0].expires_at = new Date(Date.now() - 1000);
    await request(app).get(`/reset-password/${token}`).expect(404);
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' }).expect(404);
    expect(passwordUpdates).toEqual([]);
  });

  test('a link for an account disabled after issue no longer works', async () => {
    const { token } = await requestReset('driver1');
    const driver = users.find(u => u.username === 'driver1');
    driver.status = 'disabled';
    try {
      await request(app).get(`/reset-password/${token}`).expect(404);
    } finally { driver.status = 'active'; }
  });

  test('weak or mismatched passwords are rejected with the rule named and the token stays live', async () => {
    const { token } = await requestReset('driver1');
    const weak = await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'nouppercase1!', confirmPassword: 'nouppercase1!' }).expect(400);
    expect(weak.text).toContain('uppercase letter');
    const mismatch = await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9?' }).expect(400);
    expect(mismatch.text).toContain('do not match');
    expect(passwordUpdates).toEqual([]);
    expect(resets[0].used_at).toBeNull();
  });

  test('a valid reset stores a bcrypt hash, spends the token, and the user can sign in', async () => {
    const { token } = await requestReset('driver1');
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' })
      .expect(303).expect('Location', '/login?reset=done');
    expect(passwordUpdates).toHaveLength(1);
    const [hash, id] = passwordUpdates[0];
    expect(id).toBe(1);
    expect(await verifyPassword('FreshStart9#', hash)).toBe(true);
    expect(resets[0].used_at).not.toBeNull();
    const login = await request(app).get('/login?reset=done').expect(200);
    expect(login.text).toContain('Your password was reset. Sign in with your new password.');
  });

  test('a spent link cannot be used a second time', async () => {
    const { token } = await requestReset('driver1');
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' }).expect(303);
    await request(app).get(`/reset-password/${token}`).expect(404);
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'Another1!', confirmPassword: 'Another1!' }).expect(404);
    expect(passwordUpdates).toHaveLength(1);
  });

  test('the raw token is never written to the database in any statement', async () => {
    const { token } = await requestReset('driver1');
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' }).expect(303);
    for (const [sql, params = []] of db.query.mock.calls) {
      expect(sql).not.toContain(token);
      expect(params.map(String)).not.toContain(token);
    }
  });
});
