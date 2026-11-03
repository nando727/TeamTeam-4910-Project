// Story 22225 (AA-23): setting a password spends any setup link for the
// account that was never used.
//
// An account created with a link and then given a password another way kept a
// working link until it expired, so anyone holding that link could set the
// password again. Every password write goes through updateUserPassword, which
// is where the voiding lives, so all four paths are covered by one change --
// and each of them is checked here.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { hashToken } = require('../src/auth/setup-tokens');
const { hashToken: hashResetToken } = require('../src/auth/password-reset');

const PASSWORD = 'Password1!';
const NEW_PASSWORD = 'BrandNew1!';
const SETUP_TOKEN = 'setup-link-from-the-original-email';
const RESET_TOKEN = 'b'.repeat(64);

const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada Admin', email: 'a@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Dee Driver', email: 'd@example.com' },
];

let passwordHash;
let tokens;          // fake setup_tokens
let resets;          // fake password_resets
let sqlSeen;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

const liveToken = () => tokens.find(t => t.token_hash === hashToken(SETUP_TOKEN));

beforeEach(() => {
  // driver1 was emailed a setup link and never used it.
  tokens = [{ id: 1, user_id: 1, token_hash: hashToken(SETUP_TOKEN), expires_at: new Date(Date.now() + 3600_000), used_at: null }];
  resets = [{ id: 1, user_id: 1, token_hash: hashResetToken(RESET_TOKEN), used_at: null }];
  sqlSeen = [];

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    sqlSeen.push(sql);

    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.includes('UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.includes('COUNT(*) AS count FROM login_attempts')) return [{ count: 0 }];
    if (sql.startsWith('UPDATE users SET password_hash')) return { affectedRows: 1 };
    // Audit log requirement: every password change is recorded.
    if (sql.startsWith('INSERT INTO password_changes')) return { insertId: 1 };

    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, password_hash: passwordHash }));
    }
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash, sponsor_id: null }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;

    // --- setup_tokens -----------------------------------------------------
    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      const row = tokens.find(t => t.token_hash === params[0] && !t.used_at && t.expires_at > new Date());
      return row ? [row] : [];
    }
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) {
      return tokens.filter(t => !t.used_at).map(t => ({ user_id: t.user_id }));
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at = NOW() WHERE id =')) {
      const row = tokens.find(t => t.id === params[0] && !t.used_at);
      if (!row) return { affectedRows: 0 };
      row.used_at = new Date();
      return { affectedRows: 1 };
    }
    // The statement this story is about.
    if (sql.startsWith('UPDATE setup_tokens SET used_at = NOW() WHERE user_id =')) {
      const spent = tokens.filter(t => t.user_id === params[0] && !t.used_at);
      spent.forEach(t => { t.used_at = new Date(); });
      return { affectedRows: spent.length };
    }

    // --- password_resets --------------------------------------------------
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

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

const formTokenFrom = page => page.text.match(/name="token" value="([^"]+)"/)[1];

describe('a setup link that was never used', () => {
  test('is still good until a password is set', async () => {
    await request(app).get(`/setup/${SETUP_TOKEN}`).expect(200);
  });

  test('is spent when an administrator resets the password', async () => {
    const agent = await login('admin1');
    const form = await agent.get('/admin/manage-users/1/password').expect(200);

    await agent.post('/admin/manage-users/1/password').type('form').send({
      token: formTokenFrom(form), newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(303);

    expect(liveToken().used_at).not.toBeNull();
    // 410 Gone: the link was real once and cannot be used now.
    await request(app).get(`/setup/${SETUP_TOKEN}`).expect(410);
  });

  test('is spent when the user changes their own password', async () => {
    const agent = await login('driver1');
    const form = await agent.get('/profile/password').expect(200);

    await agent.post('/profile/password').type('form').send({
      token: formTokenFrom(form), currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(200);

    expect(liveToken().used_at).not.toBeNull();
    await request(app).get(`/setup/${SETUP_TOKEN}`).expect(410);
  });

  test('is spent when the user resets by emailed link instead', async () => {
    // The likeliest route to this bug: the visitor ignores the setup link they
    // were sent and uses "forgot password" instead.
    await request(app).post(`/reset-password/${RESET_TOKEN}`).type('form').send({
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(303);

    expect(liveToken().used_at).not.toBeNull();
    await request(app).get(`/setup/${SETUP_TOKEN}`).expect(410);
  });

  test('is spent when a second link for the same account is claimed', async () => {
    const other = { id: 2, user_id: 1, token_hash: hashToken('a-second-link'), expires_at: new Date(Date.now() + 3600_000), used_at: null };
    tokens.push(other);

    // One agent, so the form token belongs to the session that submits it.
    const visitor = request.agent(app);
    const page = await visitor.get('/setup/a-second-link').expect(200);
    await visitor.post('/setup/a-second-link').type('form').send({
      token: formTokenFrom(page), password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(302);

    // Claiming an account writes a password like anything else, so the link
    // that was not used dies with it.
    expect(liveToken().used_at).not.toBeNull();
  });
});

describe('how the link is voided', () => {
  test('the row is marked used, never deleted', async () => {
    const agent = await login('driver1');
    const form = await agent.get('/profile/password').expect(200);

    await agent.post('/profile/password').type('form').send({
      token: formTokenFrom(form), currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(200);

    // The record of the link having been issued is part of the account's
    // history; voiding it must not remove it.
    expect(tokens).toHaveLength(1);
    expect(sqlSeen.some(sql => /DELETE/.test(sql))).toBe(false);
  });

  test('the link is spent before the new password is stored', async () => {
    // If the write failed in between, a spent link an admin can resend is a
    // better outcome than a live link to an account whose password changed.
    const agent = await login('driver1');
    const form = await agent.get('/profile/password').expect(200);

    await agent.post('/profile/password').type('form').send({
      token: formTokenFrom(form), currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(200);

    const voidedAt = sqlSeen.findIndex(sql => sql.startsWith('UPDATE setup_tokens SET used_at = NOW() WHERE user_id ='));
    const writtenAt = sqlSeen.findIndex(sql => sql.startsWith('UPDATE users SET password_hash'));
    expect(voidedAt).toBeGreaterThan(-1);
    expect(voidedAt).toBeLessThan(writtenAt);
  });

  test('an account that was never sent a link changes password as usual', async () => {
    tokens = [];
    const agent = await login('driver1');
    const form = await agent.get('/profile/password').expect(200);

    const res = await agent.post('/profile/password').type('form').send({
      token: formTokenFrom(form), currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/password was changed/i);
  });
});
