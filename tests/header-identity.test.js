// "I can see which account I am signed in as from any page" — the header chip
// in partials/head.ejs, which every page includes.
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
    if (sql.includes('FROM users WHERE id')) {
      const [id] = params;
      const entry = Object.entries(ACCOUNTS).find(([, a]) => a.id === id);
      if (!entry) return [];
      const [username, account] = entry;
      return [{ id: account.id, username, name: username, email: `${username}@example.com`, role: account.role, status: 'active' }];
    }
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

// One page per role, chosen so each is reachable by that role.
const PAGES = ['/', '/profile', '/about'];

describe('the header names the signed-in account', () => {
  test.each(Object.keys(ACCOUNTS))('%s sees their username and role', async (username) => {
    const agent = await signIn(username);
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('site-user__name');
    expect(res.text).toMatch(new RegExp(`site-user__name">\\s*${username}`));
    expect(res.text).toMatch(new RegExp(`site-user__role">\\s*${ACCOUNTS[username].role}`));
  });

  test.each(PAGES)('it is present on %s, not only the home page', async (path) => {
    const agent = await signIn('driver1');
    const res = await agent.get(path);

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/site-user__name">\s*driver1/);
  });

  test('the chip links to the profile page', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/');

    expect(res.text).toMatch(/class="site-user" href="\/profile"/);
  });
});

describe('a signed-out visitor sees no account', () => {
  test('the login page shows no account chip', async () => {
    const res = await request(app).get('/login');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('site-user__name');
  });

  test('the public about page shows no account chip when signed out', async () => {
    const res = await request(app).get('/about');

    expect(res.text).not.toContain('site-user__name');
  });

  test('after logging out the account is gone from the header', async () => {
    const agent = await signIn('driver1');
    expect((await agent.get('/')).text).toContain('site-user__name');

    await agent.post('/logout');
    const res = await agent.get('/login');

    expect(res.text).not.toContain('site-user__name');
    expect(res.text).not.toContain('driver1');
  });
});
