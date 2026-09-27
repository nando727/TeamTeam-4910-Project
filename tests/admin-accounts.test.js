// Story: review and update the status of admin accounts, and block sign-in for
// disabled or revoked accounts.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  { id: 4, username: 'admin2', role: 'admin', status: 'active' },
  { id: 5, username: 'admin3', role: 'admin', status: 'disabled' },
  { id: 6, username: 'admin4', role: 'admin', status: 'revoked' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'disabled' },
];
let passwordHash;
let statusUpdates;
let attempts;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  statusUpdates = [];
  attempts = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO login_attempts')) { attempts.push(params); return {}; }
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    }
    if (sql.includes('FROM users WHERE role = ? ORDER BY')) return users.filter(u => u.role === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('UPDATE users SET status')) { statusUpdates.push(params); return { affectedRows: 1 }; }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}
const hiddenValue = (page, name) => page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
async function loadAdmins(agent) {
  const page = await agent.get('/admin/admin-accounts').expect(200);
  return { page, token: hiddenValue(page, 'token') };
}

describe('admin accounts page', () => {
  test('logged-out visitors are sent to the login page and non-admins get 403', async () => {
    await request(app).get('/admin/admin-accounts').expect(302).expect('Location', '/login');
    const driver = await login('driver1');
    await driver.get('/admin/admin-accounts').expect(403);
  });

  test('lists only admin accounts with their status, and links from home and nav', async () => {
    const agent = await login('admin1');
    const { page } = await loadAdmins(agent);
    for (const admin of users.filter(u => u.role === 'admin')) {
      expect(page.text).toContain(admin.username);
      expect(page.text).toContain(`status-${admin.status}`);
    }
    expect(page.text).not.toContain('driver1');
    expect(page.text).not.toContain('sponsor1');
    // The list query is filtered in SQL, not in the template.
    const listCall = db.query.mock.calls.find(([sql]) => sql.includes('WHERE role = ?'));
    expect(listCall[1]).toEqual(['admin']);
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('href="/admin/admin-accounts"');
    expect(page.text).toContain('>Admin accounts</a>');
  });

  test('the signed-in admin gets no status control on their own row', async () => {
    const agent = await login('admin1');
    const { page } = await loadAdmins(agent);
    expect(page.text).not.toContain('action="/admin/manage-users/3/status"');
    expect(page.text).toContain('action="/admin/manage-users/4/status"');
    expect(page.text).toContain('Your own account cannot be changed here.');
  });

  test('disabling another admin goes through confirm and returns to the admin list', async () => {
    const agent = await login('admin1');
    const { token } = await loadAdmins(agent);
    await agent.post('/admin/manage-users/4/status').type('form')
      .send({ token, from: 'admin-accounts', status: 'disabled' })
      .expect(303).expect('Location', '/admin/manage-users/4/confirm');
    expect(statusUpdates).toEqual([]);

    const confirm = await agent.get('/admin/manage-users/4/confirm').expect(200);
    expect(confirm.text).toContain('admin2');
    expect(confirm.text).toContain('href="/admin/admin-accounts"');
    const confirmId = hiddenValue(confirm, 'confirmId');

    await agent.post('/admin/manage-users/4/confirm').type('form')
      .send({ token, confirmId })
      .expect(303).expect('Location', '/admin/admin-accounts');
    expect(statusUpdates).toEqual([['disabled', 4]]);
    const { page } = await loadAdmins(agent);
    expect(page.text).toContain('Status for admin2 changed to disabled.');
  });

  test('re-enabling an admin saves at once and returns to the admin list', async () => {
    const agent = await login('admin1');
    const { token } = await loadAdmins(agent);
    await agent.post('/admin/manage-users/5/status').type('form')
      .send({ token, from: 'admin-accounts', status: 'active' })
      .expect(303).expect('Location', '/admin/admin-accounts');
    expect(statusUpdates).toEqual([['active', 5]]);
    const { page } = await loadAdmins(agent);
    expect(page.text).toContain('Status for admin3 changed to active.');
  });

  test('an admin cannot disable their own account, even with a forged form', async () => {
    const agent = await login('admin1');
    const { token } = await loadAdmins(agent);
    await agent.post('/admin/manage-users/3/status').type('form')
      .send({ token, from: 'admin-accounts', status: 'disabled' })
      .expect(303).expect('Location', '/admin/admin-accounts');
    expect(statusUpdates).toEqual([]);
    const { page } = await loadAdmins(agent);
    expect(page.text).toContain('You cannot disable or revoke your own account.');
  });

  test('an unknown return page falls back to the full user list', async () => {
    const agent = await login('admin1');
    const { token } = await loadAdmins(agent);
    await agent.post('/admin/manage-users/5/status').type('form')
      .send({ token, from: 'https://evil.example/', status: 'active' })
      .expect(303).expect('Location', '/admin/manage-users');
  });
});

describe('login blocks accounts that are not active', () => {
  test('a disabled account with the right password is refused with a clear message', async () => {
    const res = await request(app).post('/login').type('form')
      .send({ username: 'admin3', password: PASSWORD }).expect(403);
    expect(res.text).toContain('This account is disabled.');
    expect(attempts).toEqual([['admin3', false]]);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('a revoked account gets its own message', async () => {
    const res = await request(app).post('/login').type('form')
      .send({ username: 'admin4', password: PASSWORD }).expect(403);
    expect(res.text).toContain('has been revoked');
    expect(attempts).toEqual([['admin4', false]]);
  });

  test('a wrong password on a disabled account still gets the generic message', async () => {
    const res = await request(app).post('/login').type('form')
      .send({ username: 'admin3', password: 'wrong' }).expect(401);
    expect(res.text).toContain('Incorrect username or password.');
    expect(res.text).not.toContain('disabled');
  });

  test('the JSON login applies the same rule', async () => {
    const res = await request(app).post('/api/login').send({ username: 'sponsor1', password: PASSWORD }).expect(403);
    expect(res.body).toEqual({ success: false, error: 'This account is disabled. Contact your sponsor or an administrator to restore access.' });
    expect(attempts).toEqual([['sponsor1', false]]);
  });

  test('an active account still logs in and is recorded as a success', async () => {
    await login('admin1');
    expect(attempts).toEqual([['admin1', true]]);
  });
});

describe('a signed-in admin who is no longer active is cut off', () => {
  const admin2 = users.find(u => u.username === 'admin2');
  afterEach(() => { admin2.status = 'active'; admin2.role = 'admin'; });

  test('a disabled admin is signed out on their next admin request and told why', async () => {
    const agent = await login('admin2');
    await agent.get('/admin/admin-accounts').expect(200);

    admin2.status = 'disabled';
    await agent.get('/admin/admin-accounts').expect(302).expect('Location', '/login?reason=disabled');
    // The session is gone: even the homepage now asks them to sign in.
    await agent.get('/').expect(302).expect('Location', '/login');
    const login2 = await agent.get('/login?reason=disabled').expect(200);
    expect(login2.text).toContain('Your account was disabled and you have been signed out.');
  });

  test('a revoked admin gets the revoked message, and a demoted one is signed out too', async () => {
    const agent = await login('admin2');
    admin2.status = 'revoked';
    await agent.post('/admin/manage-users/1/status').type('form').send({ status: 'active' })
      .expect(302).expect('Location', '/login?reason=revoked');
    expect(statusUpdates).toEqual([]);

    admin2.status = 'active';
    const again = await login('admin2');
    admin2.role = 'driver';
    await again.get('/admin/manage-users').expect(302).expect('Location', '/login?reason=role');
  });

  test('an unrecognized reason shows no message', async () => {
    const page = await request(app).get('/login?reason=<script>alert(1)</script>').expect(200);
    expect(page.text).not.toContain('<script>alert');
    expect(page.text).not.toContain('role="alert"');
  });
});
