// Story 22208: after logging in, a user lands on the page they first asked for.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { safeReturnPath } = require('../src/auth/return-to');
const { app } = require('../src/app');

let passwordHash;

const ACCOUNTS = {
  driver1: { id: 1, role: 'driver', status: 'active' },
  admin1: { id: 3, role: 'admin', status: 'active' },
};

beforeAll(async () => {
  passwordHash = await hashPassword('Password1!');
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      const account = ACCOUNTS[username];
      return account ? [{ ...account, username, password_hash: passwordHash }] : [];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    if (sql.startsWith('SELECT s.id, s.name')) return [];
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function logIn(agent, username = 'driver1') {
  return agent.post('/login').type('form').send({ username, password: 'Password1!' });
}

describe('safeReturnPath', () => {
  test('accepts paths on this site', () => {
    expect(safeReturnPath('/sponsors')).toBe('/sponsors');
    expect(safeReturnPath('/admin/create-user?role=driver')).toBe('/admin/create-user?role=driver');
  });

  test('refuses anything that could send a user off-site', () => {
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
  });

  test('refuses the login and logout pages, which would loop', () => {
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/logout')).toBeNull();
  });

  test('refuses junk', () => {
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath('/' + 'x'.repeat(600))).toBeNull();
  });
});

describe('returning to the requested page', () => {
  test('a driver sent away from /sponsors lands there after logging in', async () => {
    const agent = request.agent(app);

    const blocked = await agent.get('/sponsors');
    expect(blocked.status).toBe(302);
    expect(blocked.headers.location).toBe('/login');

    const res = await logIn(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/sponsors');
  });

  test('an admin sent away from a deep page lands there, query string intact', async () => {
    const agent = request.agent(app);
    await agent.get('/admin/create-user?role=driver');

    const res = await logIn(agent, 'admin1');
    expect(res.headers.location).toBe('/admin/create-user?role=driver');
  });

  test('a plain login with no earlier request goes to the homepage', async () => {
    const agent = request.agent(app);
    const res = await logIn(agent);
    expect(res.headers.location).toBe('/');
  });

  test('the destination is used once, not on every later login', async () => {
    const agent = request.agent(app);
    await agent.get('/sponsors');
    await logIn(agent);
    await agent.post('/logout');

    const second = await logIn(agent);
    expect(second.headers.location).toBe('/');
  });

  test('a failed login keeps the destination for the next attempt', async () => {
    const agent = request.agent(app);
    await agent.get('/sponsors');

    const failed = await agent.post('/login').type('form')
      .send({ username: 'driver1', password: 'wrong-password' });
    expect(failed.status).toBe(401);

    const res = await logIn(agent);
    expect(res.headers.location).toBe('/sponsors');
  });

  test('being turned away from the profile page is remembered too', async () => {
    const agent = request.agent(app);
    await agent.get('/profile');

    const res = await logIn(agent);
    expect(res.headers.location).toBe('/profile');
  });
});
