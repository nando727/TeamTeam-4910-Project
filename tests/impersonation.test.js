// Story: an admin can act as an active driver or sponsor, sees a banner with a
// stop button, and gets a clear error for disabled, revoked, or admin accounts.
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
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active' },
  { id: 5, username: 'driver2', role: 'driver', status: 'disabled' },
  { id: 6, username: 'sponsor2', role: 'sponsor', status: 'revoked' },
];
let passwordHash;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('SELECT s.id')) return [];
    if (sql.includes('FROM sponsor_applications')) return [];
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
async function adminWithToken() {
  const agent = await login('admin1');
  const page = await agent.get('/admin/manage-users').expect(200);
  return { agent, token: hiddenValue(page, 'token'), page };
}

describe('impersonation', () => {
  test('logged-out visitors and non-admins cannot start impersonating', async () => {
    await request(app).post('/admin/impersonate/1').type('form').send({}).expect(302).expect('Location', '/login');
    const driver = await login('driver1');
    await driver.post('/admin/impersonate/2').type('form').send({}).expect(403);
  });

  test('the user list offers "Sign in as" for drivers and sponsors only', async () => {
    const { page } = await adminWithToken();
    expect(page.text).toContain('action="/admin/impersonate/1"');
    expect(page.text).toContain('action="/admin/impersonate/2"');
    expect(page.text).toContain('action="/admin/impersonate/5"');
    expect(page.text).not.toContain('action="/admin/impersonate/3"');
    expect(page.text).not.toContain('action="/admin/impersonate/4"');
  });

  test('impersonating an active driver shows their homepage with a banner and stop button', async () => {
    const { agent, token } = await adminWithToken();
    await agent.post('/admin/impersonate/1').type('form').send({ token, from: 'manage-users' })
      .expect(303).expect('Location', '/');
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('signed in as a driver');
    expect(home.text).toContain('You are acting as <strong>driver1</strong> (driver)');
    expect(home.text).toContain('Signed in as admin <strong>admin1</strong>');
    expect(home.text).toContain('action="/impersonate/stop"');
    // As a driver, the admin pages are off limits until they stop.
    await agent.get('/admin/manage-users').expect(403);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('admin1 (id 3) started acting as driver1 (id 1)'));
  });

  test('stopping restores the admin session and returns to the origin page with a notice', async () => {
    const { agent, token } = await adminWithToken();
    await agent.post('/admin/impersonate/2').type('form').send({ token, from: 'manage-users' }).expect(303);
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('signed in as a sponsor');
    const stopToken = hiddenValue(home, 'token');
    await agent.post('/impersonate/stop').type('form').send({ token: stopToken })
      .expect(303).expect('Location', '/admin/manage-users');
    const list = await agent.get('/admin/manage-users').expect(200);
    expect(list.text).toContain('You stopped acting as sponsor1.');
    expect(list.text).not.toContain('impersonation-bar');
    const back = await agent.get('/').expect(200);
    expect(back.text).toContain('signed in as an admin');
  });

  test.each([
    [5, 'Cannot sign in as driver2: that account is disabled. Only active accounts can be impersonated.'],
    [6, 'Cannot sign in as sponsor2: that account is revoked. Only active accounts can be impersonated.'],
    [4, 'Cannot sign in as admin2: admin accounts cannot be impersonated.'],
    [3, 'Cannot sign in as admin1: admin accounts cannot be impersonated.'],
  ])('user %i is refused with a clear error and the admin stays themselves', async (id, message) => {
    const { agent, token } = await adminWithToken();
    await agent.post(`/admin/impersonate/${id}`).type('form').send({ token, from: 'manage-users' })
      .expect(303).expect('Location', '/admin/manage-users');
    const list = await agent.get('/admin/manage-users').expect(200);
    expect(list.text).toContain(message);
    expect(list.text).not.toContain('impersonation-bar');
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('signed in as an admin');
  });

  test('a stop request without the token, or when not impersonating, changes nothing', async () => {
    const { agent, token } = await adminWithToken();
    await agent.post('/impersonate/stop').type('form').send({ token }).expect(302).expect('Location', '/');
    await agent.post('/admin/impersonate/1').type('form').send({ token, from: 'manage-users' }).expect(303);
    await agent.post('/impersonate/stop').type('form').send({}).expect(403);
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('You are acting as <strong>driver1</strong>');
  });

  test('a start request without the form token is rejected', async () => {
    const { agent } = await adminWithToken();
    await agent.post('/admin/impersonate/1').type('form').send({}).expect(403);
  });

  test('unknown or malformed ids are refused', async () => {
    const { agent, token } = await adminWithToken();
    await agent.post('/admin/impersonate/999').type('form').send({ token }).expect(404);
    await agent.post('/admin/impersonate/abc').type('form').send({ token }).expect(400);
  });
});
