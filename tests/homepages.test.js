// Story 22200: each role lands on its own homepage view.
// Story 22202: logging out invalidates the session.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// The app is CommonJS. vi.mock() does not intercept require(), so the app and
// the db module are loaded through Node's require to share one module instance
// that vi.spyOn can patch.
const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const USERS = {
  driver1: { id: 1, role: 'driver', password: 'DriverPass1!' },
  sponsor1: { id: 2, role: 'sponsor', password: 'SponsorPass1!' },
  admin1: { id: 3, role: 'admin', password: 'AdminPass1!' },
};

const hashes = {};

beforeAll(async () => {
  for (const [username, user] of Object.entries(USERS)) {
    hashes[username] = await hashPassword(user.password);
  }
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT')) {
      const [username] = params;
      const user = USERS[username];
      if (!user) return [];
      return [{ id: user.id, username, password_hash: hashes[username], role: user.role, status: 'active' }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Logs in and returns the agent, which keeps the session cookie between requests.
async function signIn(username) {
  const agent = request.agent(app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password: USERS[username].password });
  expect(res.status).toBe(302);
  return agent;
}

describe('role homepages', () => {
  test('a driver sees driver functions and no admin functions', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('signed in as a driver');
    expect(res.text).toContain('/sponsors');
    expect(res.text).not.toContain('/admin/create-user');
    expect(res.text).not.toContain('/admin/create-sponsor');
  });

  test('an admin sees admin functions and no driver functions', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('signed in as an admin');
    expect(res.text).toContain('/admin/create-user');
    expect(res.text).toContain('/admin/create-sponsor');
    expect(res.text).not.toContain('Apply to join a sponsor');
  });

  test('a sponsor sees only pages that exist today', async () => {
    const agent = await signIn('sponsor1');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('signed in as a sponsor user');
    expect(res.text).toContain('/profile');
    expect(res.text).not.toContain('/admin/');
    expect(res.text).not.toContain('Apply to join a sponsor');
  });

  test('every role gets a different page', async () => {
    const pages = {};
    for (const username of Object.keys(USERS)) {
      const agent = await signIn(username);
      pages[username] = (await agent.get('/')).text;
    }
    expect(pages.driver1).not.toBe(pages.sponsor1);
    expect(pages.sponsor1).not.toBe(pages.admin1);
    expect(pages.driver1).not.toBe(pages.admin1);
  });

  test('an anonymous visitor is sent to the login page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('logout', () => {
  test('logging out invalidates the session', async () => {
    const agent = await signIn('driver1');
    expect((await agent.get('/')).status).toBe(200);

    const res = await agent.post('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    // Same agent, same cookie: the old session must no longer work.
    const after = await agent.get('/');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/login');
  });

  test('logging out when not signed in just returns to the login page', async () => {
    const res = await request(app).post('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('the homepage offers a logout button', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/');
    expect(res.text).toContain('action="/logout"');
  });
});
