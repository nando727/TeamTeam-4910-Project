// Backlog AA-14: changing or resetting a password signs the account out
// everywhere else. A password changed because someone else knows it is no use
// if their session keeps working.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const NEW_PASSWORD = 'FreshStart9#';
const USER = { id: 1, username: 'driver1', role: 'driver', status: 'active', sponsor_id: null, email: 'd@example.com' };

let passwordHash;
let cutoff;        // what users.sessions_valid_from holds, in ms
let revocations;   // ids that were revoked
let resets;        // fake password_resets rows

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  cutoff = null;
  revocations = [];
  resets = [];

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};

    // --- the revocation cutoff ---
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) {
      revocations.push(params[0]);
      cutoff = Date.now();
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: cutoff }];
    if (sql.startsWith('SELECT sessions_valid_from')) {
      const [issuedAtMs] = params;
      return [{ revoked: cutoff && cutoff > issuedAtMs ? 1 : 0 }];
    }

    // --- passwords ---
    if (sql.startsWith('UPDATE users SET password_hash')) return { affectedRows: 1 };
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return params[0] === USER.id ? [{ id: USER.id, username: USER.username, password_hash: passwordHash }] : [];
    }

    // --- accounts ---
    if (sql.includes('FROM users WHERE username')) {
      return params[0] === USER.username ? [{ ...USER, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return params[0] === USER.id ? [{ ...USER, name: 'Dee Driver', email: 'd@example.com' }] : [];
    }

    // --- reset links ---
    if (sql.startsWith('INSERT INTO password_resets')) {
      const [user_id, token_hash, minutes] = params;
      resets.push({ id: resets.length + 1, user_id, token_hash, expires_at: new Date(Date.now() + minutes * 60000), used_at: null });
      return { insertId: resets.length };
    }
    if (sql.includes('FROM password_resets r')) {
      return resets
        .filter(r => r.token_hash === params[0] && !r.used_at && r.expires_at > new Date())
        .map(r => ({ id: r.id, userId: USER.id, username: USER.username, status: USER.status }));
    }
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE id')) {
      const row = resets.find(r => r.id === params[0] && !r.used_at);
      if (row) row.used_at = new Date();
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) return { affectedRows: 0 };

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function signIn() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: USER.username, password: PASSWORD }).expect(302);
  return agent;
}

async function tokenFrom(agent, path) {
  const page = await agent.get(path).expect(200);
  return page.text.match(/name="token" value="([^"]+)"/)[1];
}

function changePassword(agent, token, fields = {}) {
  return agent.post('/profile/password').type('form').send({
    token,
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
    ...fields,
  });
}

describe('changing your own password', () => {
  test('signs out a session on another device', async () => {
    const phone = await signIn();
    const laptop = await signIn();
    await phone.get('/').expect(200);

    const token = await tokenFrom(laptop, '/profile/password');
    await changePassword(laptop, token).expect(200);

    const onPhone = await phone.get('/');
    expect(onPhone.status).toBe(302);
    expect(onPhone.headers.location).toBe('/login?reason=everywhere');
  });

  test('keeps the session that made the change', async () => {
    const laptop = await signIn();
    const token = await tokenFrom(laptop, '/profile/password');
    await changePassword(laptop, token).expect(200);

    // Still signed in: no redirect to the login page.
    await laptop.get('/').expect(200);
  });

  test('says that other devices were signed out', async () => {
    const agent = await signIn();
    const token = await tokenFrom(agent, '/profile/password');

    const res = await changePassword(agent, token).expect(200);
    expect(res.text).toMatch(/other devices were signed out/i);
  });

  test('revokes exactly once, for this account only', async () => {
    const agent = await signIn();
    const token = await tokenFrom(agent, '/profile/password');
    await changePassword(agent, token).expect(200);

    expect(revocations).toEqual([USER.id]);
  });
});

describe('a change that does not happen', () => {
  test('a wrong current password leaves other sessions alone', async () => {
    const phone = await signIn();
    const laptop = await signIn();

    const token = await tokenFrom(laptop, '/profile/password');
    await changePassword(laptop, token, { currentPassword: 'WrongPass1!' }).expect(400);

    expect(revocations).toEqual([]);
    await phone.get('/').expect(200);
  });

  test('a new password that fails the rules leaves other sessions alone', async () => {
    const phone = await signIn();
    const laptop = await signIn();

    const token = await tokenFrom(laptop, '/profile/password');
    await changePassword(laptop, token, { newPassword: 'short', confirmPassword: 'short' }).expect(400);

    expect(revocations).toEqual([]);
    await phone.get('/').expect(200);
  });
});

describe('a password reset from a link', () => {
  test('signs out whoever was already signed in as that account', async () => {
    const intruder = await signIn();
    await intruder.get('/').expect(200);

    // Ask for a link, then read it back out of the console the server logs to.
    const logged = [];
    console.log.mockImplementation((...args) => logged.push(args.join(' ')));
    await request(app).post('/forgot-password').type('form').send({ username: USER.username }).expect(200);
    const link = logged.join('\n').match(/\/reset-password\/([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();

    // The link itself is the proof here, so the form carries no separate token.
    const token = link[1];
    await request(app).get(`/reset-password/${token}`).expect(200);
    await request(app).post(`/reset-password/${token}`).type('form')
      .send({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(303);

    expect(revocations).toEqual([USER.id]);

    const stillIn = await intruder.get('/');
    expect(stillIn.status).toBe(302);
    expect(stillIn.headers.location).toBe('/login?reason=everywhere');
  });
});
