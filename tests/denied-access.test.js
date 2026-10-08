// Story 22252: a signed-in user who reaches a page outside their role gets a
// page explaining why, not a bare line of text.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'Password1!';
const ACCOUNTS = {
  driver1: { id: 1, role: 'driver', sponsor_id: null },
  sponsor1: { id: 2, role: 'sponsor', sponsor_id: 7 },
  admin1: { id: 3, role: 'admin', sponsor_id: null },
  // A sponsor account an admin has not linked to an organization yet.
  sponsorless: { id: 4, role: 'sponsor', sponsor_id: null },
};

let passwordHash;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      const account = ACCOUNTS[username];
      if (!account) return [];
      return [{ ...account, username, password_hash: passwordHash, status: 'active' }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    // The admin guard re-reads the account on every admin request, so a
    // disabled or demoted admin is cut off mid-session.
    if (sql.startsWith('SELECT id, name, email, username, role, status FROM users WHERE id')) {
      const [id] = params;
      const entry = Object.entries(ACCOUNTS).find(([, a]) => a.id === id);
      if (!entry) return [];
      const [username, account] = entry;
      return [{ id: account.id, name: username, email: `${username}@example.com`, username, role: account.role, status: 'active' }];
    }
    // Page queries beyond the guard aren't reached in these tests.
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(username) {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ username, password: PASSWORD });
  expect(res.status).toBe(302);
  return agent;
}

describe('a driver reaching pages for other roles', () => {
  test.each([
    ['/admin/create-user', 'administrator'],
    ['/admin/manage-users', 'administrator'],
    ['/reports/points', 'sponsor user and administrator'],
  ])('%s explains which role the page needs', async (path, expectedRoles) => {
    const agent = await signIn('driver1');
    const res = await agent.get(path);

    expect(res.status).toBe(403);
    expect(res.text).toContain("You don't have access to this page");
    expect(res.text).toContain(`This page is for ${expectedRoles} accounts.`);
    expect(res.text).toContain('You are signed in as a driver.');
  });

  test('the page offers a way back and says who can help', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/admin/create-user');

    expect(res.text).toContain('href="/"');
    expect(res.text).toMatch(/ask an administrator/i);
  });

  test('it is a full page, not a bare line of text', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/admin/create-user');

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>Access denied');
    // The site chrome is present, so the user is not dumped somewhere strange.
    expect(res.text).toContain('site-header');
  });
});

describe('other roles are refused the same way', () => {
  test('an admin cannot open the driver application flow', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/sponsors');

    expect(res.status).toBe(403);
    expect(res.text).toContain('Only drivers can apply to join a sponsor.');
    expect(res.text).toContain("You don't have access to this page");
  });

  test('an admin cannot open a driver-only page', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/driver/programs');

    expect(res.status).toBe(403);
    expect(res.text).toContain('This page is for driver accounts.');
    expect(res.text).toContain('You are signed in as a administrator.');
  });

  test('a sponsor with no organization is told what is missing, not just refused', async () => {
    const agent = await signIn('sponsorless');
    const res = await agent.get('/reports/points');

    expect(res.status).toBe(403);
    expect(res.text).toMatch(/not linked to a sponsor organization/i);
    expect(res.text).toMatch(/administrator can link it/i);
  });
});

describe('the refusal does not leak anything', () => {
  test('it does not echo the path back into the page', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/admin/manage-users?note=<script>alert(1)</script>');

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });

  test('a signed-out visitor is redirected to log in rather than shown this page', async () => {
    const res = await request(app).get('/admin/create-user');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('a role that is allowed is unaffected', () => {
  test('an admin reaches an admin page', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/admin/create-user');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("You don't have access to this page");
  });

  test('a driver reaches the driver application flow', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/sponsors');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("You don't have access to this page");
  });
});
