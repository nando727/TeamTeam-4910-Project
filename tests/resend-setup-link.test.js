// Story 22255 follow-up: a setup link expires, so an admin can send a new one.
// The replacement is the only link that works afterwards.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { hashToken } = require('../src/auth/setup-tokens');

const PASSWORD = 'Password1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada Admin', email: 'admin1@example.com' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Dee Driver', email: 'd@example.com' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active', name: 'Sam Sponsor', email: 's@example.com' },
];

let passwordHash;
let tokens;   // fake setup_tokens rows
let mailed;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  // driver1 was sent a link and never used it; sponsor1 finished setup.
  tokens = [
    { id: 1, user_id: 1, token_hash: hashToken('old-driver-token'), expires_at: new Date(Date.now() + 3600_000), used_at: null },
    { id: 2, user_id: 2, token_hash: hashToken('used-sponsor-token'), expires_at: new Date(Date.now() + 3600_000), used_at: new Date() },
  ];
  mailed = [];

  vi.spyOn(console, 'log').mockImplementation((...args) => { mailed.push(args.join(' ')); });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash, sponsor_id: null }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.includes('FROM users WHERE role = ? ORDER BY')) return users.filter(u => u.role === params[0]);

    // --- setup_tokens ---
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) {
      const byUser = new Map();
      for (const row of tokens) {
        const current = byUser.get(row.user_id) || { any: false, used: false };
        byUser.set(row.user_id, { any: true, used: current.used || row.used_at !== null });
      }
      return [...byUser.entries()].filter(([, v]) => v.any && !v.used).map(([user_id]) => ({ user_id }));
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at = NOW()')) {
      let affected = 0;
      for (const row of tokens) {
        if (row.user_id === params[0] && row.used_at === null) { row.used_at = new Date(); affected += 1; }
      }
      return { affectedRows: affected };
    }
    if (sql.startsWith('INSERT INTO setup_tokens')) {
      const [user_id, token_hash, expires_at] = params;
      tokens.push({ id: tokens.length + 1, user_id, token_hash, expires_at, used_at: null });
      return { insertId: tokens.length };
    }
    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      const row = tokens.find(t => t.token_hash === params[0]);
      return row ? [row] : [];
    }

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

async function loadList(agent) {
  const page = await agent.get('/admin/manage-users').expect(200);
  return { page, token: page.text.match(/name="token" value="([^"]+)"/)[1] };
}

function linkFrom(page) {
  const match = page.text.match(/class="setup-link"[^>]*value="([^"]+)"/);
  return match ? match[1] : null;
}

describe('who is offered a new link', () => {
  test('an account that never used its setup link', async () => {
    const agent = await login('admin1');
    const { page } = await loadList(agent);

    expect(page.text).toContain('/admin/manage-users/1/setup-link');
  });

  test('not an account that already set a password', async () => {
    const agent = await login('admin1');
    const { page } = await loadList(agent);

    expect(page.text).not.toContain('/admin/manage-users/2/setup-link');
    // The one Password column offers a reset instead: an account that has a
    // password cannot use a setup link, and never saw both options.
    expect(page.text).toContain('/admin/manage-users/2/password');
  });
});

describe('sending a new link', () => {
  test('shows the admin a link to copy, and says the old one is dead', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token }).expect(303);
    const page = await agent.get('/admin/manage-users').expect(200);

    expect(page.text).toMatch(/New setup link for driver1/);
    expect(linkFrom(page)).toMatch(/\/setup\/[A-Za-z0-9_-]+$/);
  });

  test('the earlier link stops working', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    // The old link works right up until the replacement is issued.
    await request(app).get('/setup/old-driver-token').expect(200);
    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token }).expect(303);

    await request(app).get('/setup/old-driver-token').expect(410);
  });

  test('the new link opens the password form', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);
    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token }).expect(303);

    const link = linkFrom(await agent.get('/admin/manage-users'));
    const path = link.slice(link.indexOf('/setup/'));
    await request(app).get(path).expect(200);
  });

  test('the message is written to the mail transport too', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);
    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token }).expect(303);

    expect(mailed.join('\n')).toContain('d@example.com');
  });

  test('the page does not claim the user was emailed', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);
    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token }).expect(303);
    const page = await agent.get('/admin/manage-users').expect(200);

    expect(page.text).toMatch(/not emailed until mail delivery is configured/i);
  });
});

describe('what is refused', () => {
  test('an account that already set a password, even if the form is forged', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    await agent.post('/admin/manage-users/2/setup-link').type('form').send({ token }).expect(303);
    const page = await agent.get('/admin/manage-users').expect(200);

    expect(page.text).toMatch(/has already set a password/i);
    expect(linkFrom(page)).toBeNull();
  });

  test('a request without the form token', async () => {
    const agent = await login('admin1');

    await agent.post('/admin/manage-users/1/setup-link').type('form').send({}).expect(403);
    // The old link is untouched.
    await request(app).get('/setup/old-driver-token').expect(200);
  });

  test('a non-admin', async () => {
    const agent = await login('driver1');

    await agent.post('/admin/manage-users/1/setup-link').type('form').send({ token: 'x' }).expect(403);
  });

  test('a signed-out visitor', async () => {
    await request(app).post('/admin/manage-users/1/setup-link').type('form').send({ token: 'x' })
      .expect(302).expect('Location', '/login');
  });

  test('an unknown user', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    await agent.post('/admin/manage-users/999/setup-link').type('form').send({ token }).expect(404);
  });
});
