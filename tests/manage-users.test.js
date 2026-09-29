// Admin-only page for changing a user's account status (active / disabled /
// revoked). Disabling or revoking must be confirmed before it is saved.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'disabled' },
];
let passwordHash;
let statusUpdates;

beforeAll(async () => {
  passwordHash = await hashPassword('Password1!');
});

beforeEach(() => {
  statusUpdates = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    }
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('UPDATE users SET status')) {
      statusUpdates.push(params);
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

function hiddenValue(page, name) {
  return page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
}

async function loadList(agent) {
  const page = await agent.get('/admin/manage-users').expect(200);
  return { page, token: hiddenValue(page, 'token') };
}

test('logged-out visitors are sent to the login page', async () => {
  await request(app).get('/admin/manage-users').expect(302).expect('Location', '/login');
});

test('non-admins cannot manage users', async () => {
  const agent = await login('driver1');
  await agent.get('/admin/manage-users').expect(403);
  await agent.post('/admin/manage-users/2/status').type('form').send({ status: 'active' }).expect(403);
  expect(statusUpdates).toEqual([]);
});

test('admins see every user with username, role, status, and a status control', async () => {
  const agent = await login('admin1');
  const { page } = await loadList(agent);
  for (const user of users) {
    expect(page.text).toContain(user.username);
    expect(page.text).toContain(`status-${user.status}`);
    expect(page.text).toContain(`action="/admin/manage-users/${user.id}/status"`);
  }
  const home = await agent.get('/').expect(200);
  expect(home.text).toContain('href="/admin/manage-users"');
});

test('a confirmed disable saves the new status and shows a success message', async () => {
  const agent = await login('admin1');
  const { token } = await loadList(agent);
  await agent.post('/admin/manage-users/1/status').type('form')
    .send({ token, status: 'disabled' })
    .expect(303).expect('Location', '/admin/manage-users/1/confirm');
  expect(statusUpdates).toEqual([]);

  const confirm = await agent.get('/admin/manage-users/1/confirm').expect(200);
  expect(confirm.text).toContain('driver1');
  expect(confirm.text).toContain('disabled');
  const confirmId = hiddenValue(confirm, 'confirmId');

  await agent.post('/admin/manage-users/1/confirm').type('form')
    .send({ token, confirmId })
    .expect(303).expect('Location', '/admin/manage-users');
  expect(statusUpdates).toEqual([['disabled', 1]]);

  const { page } = await loadList(agent);
  expect(page.text).toContain('Status for driver1 changed to disabled.');
});

test('re-activating saves without a confirmation step', async () => {
  const agent = await login('admin1');
  const { token } = await loadList(agent);
  await agent.post('/admin/manage-users/2/status').type('form')
    .send({ token, status: 'active' })
    .expect(303).expect('Location', '/admin/manage-users');
  expect(statusUpdates).toEqual([['active', 2]]);
  const { page } = await loadList(agent);
  expect(page.text).toContain('Status for sponsor1 changed to active.');
});

test('submitting the current status writes nothing and explains why', async () => {
  const agent = await login('admin1');
  const { token } = await loadList(agent);
  await agent.post('/admin/manage-users/1/status').type('form')
    .send({ token, status: 'active' })
    .expect(303).expect('Location', '/admin/manage-users');
  expect(statusUpdates).toEqual([]);
  const { page } = await loadList(agent);
  expect(page.text).toContain('No change needed, status is already active.');
});

test('a disable or revoke is not saved until it is confirmed', async () => {
  const agent = await login('admin1');
  const { token } = await loadList(agent);
  await agent.post('/admin/manage-users/1/status').type('form')
    .send({ token, status: 'revoked' }).expect(303);
  // Skipping the confirm page, or sending a forged confirmId, is rejected.
  await agent.post('/admin/manage-users/1/confirm').type('form')
    .send({ token }).expect(400);
  await agent.post('/admin/manage-users/1/confirm').type('form')
    .send({ token, confirmId: 'not-the-real-id' }).expect(400);
  // Confirming without ever starting a change is rejected too.
  await agent.post('/admin/manage-users/2/confirm').type('form')
    .send({ token, confirmId: 'anything' }).expect(400);
  expect(statusUpdates).toEqual([]);
});

test('admins cannot disable or revoke their own account', async () => {
  const agent = await login('admin1');
  const { token } = await loadList(agent);
  await agent.post('/admin/manage-users/3/status').type('form')
    .send({ token, status: 'revoked' })
    .expect(303).expect('Location', '/admin/manage-users');
  expect(statusUpdates).toEqual([]);
  const { page } = await loadList(agent);
  expect(page.text).toContain('You cannot disable or revoke your own account.');
});

test('a status form without the session token is rejected', async () => {
  const agent = await login('admin1');
  await agent.post('/admin/manage-users/1/status').type('form')
    .send({ status: 'disabled' }).expect(403);
  expect(statusUpdates).toEqual([]);
});
