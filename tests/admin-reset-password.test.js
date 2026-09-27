// Story: an admin resets a driver, sponsor, or admin user's password on their
// behalf. Same complexity rules, same hashing, audit log left untouched.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  { id: 4, username: 'admin2', role: 'admin', status: 'active' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'disabled' },
];
let passwordHash;
let passwordUpdates;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  passwordUpdates = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT COUNT(*) AS count FROM login_attempts')) return [{ count: params[0] === 'driver1' ? 3 : 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    }
    if (sql.includes('FROM users WHERE role = ? ORDER BY')) return users.filter(u => u.role === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('UPDATE users SET password_hash')) { passwordUpdates.push(params); return { affectedRows: 1 }; }
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
const auditWrites = () => db.query.mock.calls.filter(([sql]) => /^(DELETE|UPDATE)\s+(FROM\s+)?login_attempts/i.test(sql));

describe('admin password reset', () => {
  test('logged-out visitors are redirected and non-admins get 403', async () => {
    await request(app).get('/admin/manage-users/1/password').expect(302).expect('Location', '/login');
    const driver = await login('driver1');
    await driver.get('/admin/manage-users/2/password').expect(403);
    await driver.post('/admin/manage-users/2/password').type('form').send({ newPassword: 'NewPass1!' }).expect(403);
    expect(passwordUpdates).toEqual([]);
  });

  test('both list pages link to the reset page for other users and to the profile for yourself', async () => {
    const agent = await login('admin1');
    const all = await agent.get('/admin/manage-users').expect(200);
    expect(all.text).toContain('href="/admin/manage-users/1/password?from=manage-users"');
    expect(all.text).not.toContain('href="/admin/manage-users/3/password');
    expect(all.text).toContain('href="/profile/password"');
    const admins = await agent.get('/admin/admin-accounts').expect(200);
    expect(admins.text).toContain('href="/admin/manage-users/4/password?from=admin-accounts"');
  });

  test('the page shows the target user, the rules, and recent failed sign-ins', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/admin/manage-users/1/password?from=manage-users').expect(200);
    expect(page.text).toContain('driver1');
    expect(page.text).toContain('Failed sign-ins, last 24 hours</dt><dd>3</dd>');
    expect(page.text).toContain('data-for="newPassword"');
    expect(page.text).toContain('src="/password-rules.js"');
    expect(page.text).toContain('name="from" value="manage-users"');
    expect(page.text).not.toContain('This account is disabled');
    const countCall = db.query.mock.calls.find(([sql]) => sql.startsWith('SELECT COUNT(*) AS count FROM login_attempts'));
    expect(countCall[1]).toEqual(['driver1']);
  });

  test('a disabled target gets a note that a new password alone will not let them in', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/admin/manage-users/2/password').expect(200);
    expect(page.text).toContain('This account is disabled.');
    expect(page.text).toContain('href="/admin/manage-users"');
  });

  test('an unknown or malformed user id is refused', async () => {
    const agent = await login('admin1');
    await agent.get('/admin/manage-users/999/password').expect(404);
    await agent.get('/admin/manage-users/abc/password').expect(400);
  });

  test('your own account is sent to the profile page instead', async () => {
    const agent = await login('admin1');
    await agent.get('/admin/manage-users/3/password').expect(302).expect('Location', '/profile/password');
    const token = hiddenValue(await agent.get('/admin/manage-users'), 'token');
    await agent.post('/admin/manage-users/3/password').type('form')
      .send({ token, newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' })
      .expect(303).expect('Location', '/admin/manage-users');
    expect(passwordUpdates).toEqual([]);
    const list = await agent.get('/admin/manage-users').expect(200);
    expect(list.text).toContain('Change your own password from your profile page.');
  });

  test.each([
    ['Sh0rt!!', 'at least 8 characters'],
    ['nouppercase1!', 'uppercase letter'],
    ['NOLOWERCASE1!', 'lowercase letter'],
    ['NoNumbersHere!', 'include a number'],
    ['NoSpecial123', 'special character'],
  ])('%s is rejected with the failed rule named and nothing saved', async (newPassword, wording) => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/manage-users/1/password'), 'token');
    const res = await agent.post('/admin/manage-users/1/password').type('form')
      .send({ token, from: 'manage-users', newPassword, confirmPassword: newPassword }).expect(400);
    expect(res.text).toContain(wording);
    expect(passwordUpdates).toEqual([]);
  });

  test('a mismatched confirmation is rejected', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/manage-users/1/password'), 'token');
    const res = await agent.post('/admin/manage-users/1/password').type('form')
      .send({ token, newPassword: 'NewPass1!', confirmPassword: 'NewPass1?' }).expect(400);
    expect(res.text).toContain('do not match');
    expect(passwordUpdates).toEqual([]);
  });

  test('a valid reset stores a bcrypt hash, returns to the origin page, and leaves the audit log alone', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/manage-users/4/password?from=admin-accounts'), 'token');
    await agent.post('/admin/manage-users/4/password').type('form')
      .send({ token, from: 'admin-accounts', newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' })
      .expect(303).expect('Location', '/admin/admin-accounts');
    expect(passwordUpdates).toHaveLength(1);
    const [hash, id] = passwordUpdates[0];
    expect(id).toBe(4);
    expect(hash).not.toContain('FreshStart9#');
    expect(await verifyPassword('FreshStart9#', hash)).toBe(true);
    expect(auditWrites()).toEqual([]);
    const page = await agent.get('/admin/admin-accounts').expect(200);
    expect(page.text).toContain('Password for admin2 was reset.');
  });

  test('a driver and a sponsor can be reset too, defaulting back to the full list', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/manage-users'), 'token');
    for (const id of [1, 2]) {
      await agent.post(`/admin/manage-users/${id}/password`).type('form')
        .send({ token, newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' })
        .expect(303).expect('Location', '/admin/manage-users');
    }
    expect(passwordUpdates.map(([, id]) => id)).toEqual([1, 2]);
  });

  test('a submit without the session form token is rejected', async () => {
    const agent = await login('admin1');
    await agent.post('/admin/manage-users/1/password').type('form')
      .send({ newPassword: 'FreshStart9#', confirmPassword: 'FreshStart9#' }).expect(403);
    expect(passwordUpdates).toEqual([]);
  });
});
