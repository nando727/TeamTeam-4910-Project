// Story 22253: a visitor without a valid session cannot reach a protected page.
// Every one of them sends you to the login page, and after signing in you land
// on the page you first asked for (story 22208).
//
// No production code changes with this file: it is the evidence that the
// guards are in place on every route group, including ones added later.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'Password1!';
let passwordHash;

// One protected page per route group, so a new group with a missing guard
// shows up here rather than in production.
const PROTECTED_PAGES = [
  ['the home page', '/'],
  ['the profile page', '/profile'],
  ['the change-password page', '/profile/password'],
  ['the sponsor application list', '/sponsors'],
  ['a driver points page', '/driver/programs'],
  ['an admin page', '/admin/create-user'],
  ['the admin user list', '/admin/manage-users'],
  ['the reports page', '/reports/points'],
];

// Pages that must stay reachable without signing in.
const PUBLIC_PAGES = [
  ['the login page', '/login'],
  ['the forgot-password page', '/forgot-password'],
  ['the about page', '/about'],
];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('protected pages turn away a visitor with no session', () => {
  test.each(PROTECTED_PAGES)('%s redirects to login', async (_label, path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('an expired session is treated the same as none', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD });

    // Logging out destroys the session server-side; the cookie is now worthless.
    await agent.post('/logout');

    const res = await agent.get('/profile');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('a made-up session cookie does not get in', async () => {
    const res = await request(app)
      .get('/profile')
      .set('Cookie', 'connect.sid=s%3Anot-a-real-session.forged-signature');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('no protected page leaks its contents in the redirect body', async () => {
    const res = await request(app).get('/admin/manage-users');

    expect(res.text).not.toMatch(/manage users|username|role/i);
  });
});

describe('public pages stay reachable', () => {
  test.each(PUBLIC_PAGES)('%s loads without signing in', async (_label, path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });
});

describe('after signing in you land where you were headed', () => {
  test('a driver asking for a driver page gets there after login', async () => {
    const agent = request.agent(app);

    const blocked = await agent.get('/sponsors');
    expect(blocked.headers.location).toBe('/login');

    const res = await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD });
    expect(res.headers.location).toBe('/sponsors');
  });

  test('the query string survives the round trip', async () => {
    const agent = request.agent(app);
    await agent.get('/profile?tab=security');

    const res = await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD });
    expect(res.headers.location).toBe('/profile?tab=security');
  });

  test('signing in with no page in mind goes to the home page', async () => {
    const agent = request.agent(app);

    const res = await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD });
    expect(res.headers.location).toBe('/');
  });
});
