// Change password (logged-in user) and the admin create-user page both enforce
// the shared complexity rules on the server and explain which rule failed.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth/password');

const CURRENT = 'AdminPass1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
];
let currentHash;
let passwordUpdates;
let inserts;

beforeAll(async () => { currentHash = await hashPassword(CURRENT); });

beforeEach(() => {
  passwordUpdates = [];
  inserts = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: currentHash }] : [];
    }
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ id: u.id, username: u.username, password_hash: currentHash }));
    }
    if (sql.includes('FROM users WHERE id')) {
      return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    }
    if (sql.startsWith('UPDATE users SET password_hash')) { passwordUpdates.push(params); return { affectedRows: 1 }; }
    if (sql.startsWith('SELECT id FROM users WHERE email')) return [];
    if (sql.startsWith('INSERT INTO users')) { inserts.push(params); return { insertId: 9 }; }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: CURRENT }).expect(302);
  return agent;
}

function hiddenValue(page, name) {
  return page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
}

describe('change password', () => {
  test('logged-out visitors are sent to the login page', async () => {
    await request(app).get('/profile/password').expect(302).expect('Location', '/login');
    await request(app).post('/profile/password').type('form').send({}).expect(302).expect('Location', '/login');
  });

  test('the page lists every rule and loads the live checker', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/profile/password').expect(200);
    expect(page.text).toContain('data-password-rules');
    expect(page.text).toContain('data-for="newPassword"');
    for (const id of ['length', 'uppercase', 'lowercase', 'number', 'special']) {
      expect(page.text).toContain(`data-rule="${id}"`);
    }
    expect(page.text).toContain('src="/password-rules.js"');
    expect(page.text).toContain('data-confirm-for="newPassword"');
    // The profile page and the admin home both link here.
    expect((await agent.get('/profile')).text).toContain('href="/profile/password"');
    expect((await agent.get('/')).text).toContain('href="/profile/password"');
  });

  test('a wrong current password is rejected and nothing is saved', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/profile/password'), 'token');
    const res = await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: 'not-it', newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' })
      .expect(400);
    expect(res.text).toContain('Your current password is incorrect.');
    expect(passwordUpdates).toEqual([]);
  });

  test.each([
    ['Sh0rt!!', 'at least 8 characters'],
    ['nouppercase1!', 'uppercase letter'],
    ['NOLOWERCASE1!', 'lowercase letter'],
    ['NoNumbersHere!', 'include a number'],
    ['NoSpecial123', 'special character'],
  ])('a new password of %s is rejected with the failed rule named', async (newPassword, wording) => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/profile/password'), 'token');
    const res = await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: CURRENT, newPassword, confirmPassword: newPassword })
      .expect(400);
    expect(res.text).toContain(wording);
    expect(passwordUpdates).toEqual([]);
  });

  test('a new password that matches the current one, or a mismatched confirmation, is rejected', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/profile/password'), 'token');
    const same = await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: CURRENT, newPassword: CURRENT, confirmPassword: CURRENT }).expect(400);
    expect(same.text).toContain('different from your current one');
    const mismatch = await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: CURRENT, newPassword: 'NewPass1!', confirmPassword: 'NewPass1?' }).expect(400);
    expect(mismatch.text).toContain('do not match');
    expect(passwordUpdates).toEqual([]);
  });

  test('a valid change stores a bcrypt hash of the new password, never the plaintext', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/profile/password'), 'token');
    const res = await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: CURRENT, newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' })
      .expect(200);
    expect(res.text).toContain('Your password was changed.');
    expect(passwordUpdates).toHaveLength(1);
    const [hash, id] = passwordUpdates[0];
    expect(id).toBe(3);
    expect(hash).not.toBe('NewPass1!');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword('NewPass1!', hash)).toBe(true);
  });

  test('a submit without the session form token is rejected', async () => {
    const agent = await login('admin1');
    await agent.post('/profile/password').type('form')
      .send({ currentPassword: CURRENT, newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }).expect(403);
    expect(passwordUpdates).toEqual([]);
  });

  test('drivers can change their own password too', async () => {
    const agent = await login('driver1');
    const token = hiddenValue(await agent.get('/profile/password'), 'token');
    await agent.post('/profile/password').type('form')
      .send({ token, currentPassword: CURRENT, newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }).expect(200);
    expect(passwordUpdates.map(([, id]) => id)).toEqual([1]);
  });
});

describe('admin create-user uses the same rules', () => {
  const account = { name: 'New Person', email: 'new@example.com', username: 'newperson', role: 'driver' };

  test('the form shows the checklist', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/admin/create-user').expect(200);
    expect(page.text).toContain('data-for="password"');
    expect(page.text).toContain('src="/password-rules.js"');
  });

  test('an 8+ character password that breaks another rule is rejected with that rule named', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/create-user'), 'token');
    const res = await agent.post('/admin/create-user').type('form')
      .send({ ...account, token, password: 'longenoughbutweak' }).expect(400);
    expect(res.text).toContain('uppercase letter');
    expect(res.text).toContain('include a number');
    expect(res.text).toContain('special character');
    expect(inserts).toEqual([]);
  });

  test('a compliant password creates the user', async () => {
    const agent = await login('admin1');
    const token = hiddenValue(await agent.get('/admin/create-user'), 'token');
    const res = await agent.post('/admin/create-user').type('form')
      .send({ ...account, token, password: 'Compliant1!' }).expect(200);
    expect(res.text).toContain('User created successfully.');
    expect(inserts).toHaveLength(1);
  });

  test('the JSON API applies the rules as well', async () => {
    const res = await request(app).post('/api/users').send({ ...account, password: 'weakpassword' }).expect(400);
    expect(res.body.error).toContain('uppercase letter');
    expect(inserts).toEqual([]);
  });
});
