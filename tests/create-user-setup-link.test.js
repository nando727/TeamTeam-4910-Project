// Story 22255: creating a user with no password issues a setup link.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const { hashToken } = require('../src/auth/setup-tokens');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');
const { app } = require('../src/app');

let adminHash;
const originalTransport = process.env.MAIL_TRANSPORT;

// What the fake database recorded during a test.
let insertedUsers;
let insertedTokens;

beforeAll(async () => {
  adminHash = await hashPassword('AdminPass1!');
});

beforeEach(() => {
  insertedUsers = [];
  insertedTokens = [];
  clearOutbox();
  process.env.MAIL_TRANSPORT = 'silent';

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'admin1') return [];
      return [{ id: 3, username: 'admin1', password_hash: adminHash, role: 'admin', status: 'active' }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    // The admin router re-reads the signed-in account on every request.
    if (sql.includes('FROM users WHERE id')) {
      return params[0] === 3 ? [{ id: 3, username: 'admin1', role: 'admin', status: 'active', name: null, email: null }] : [];
    }
    if (sql.startsWith('SELECT id FROM users WHERE email')) return [];
    if (sql.startsWith('INSERT INTO users')) {
      const [name, email, username, passwordHash, role] = params;
      insertedUsers.push({ name, email, username, passwordHash, role });
      return { insertId: 42 };
    }
    if (sql.startsWith('INSERT INTO setup_tokens')) {
      const [userId, tokenHash, expiresAt] = params;
      insertedTokens.push({ userId, tokenHash, expiresAt });
      return { insertId: 1 };
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  if (originalTransport === undefined) delete process.env.MAIL_TRANSPORT;
  else process.env.MAIL_TRANSPORT = originalTransport;
});

async function signInAsAdmin() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'admin1', password: 'AdminPass1!' }).expect(302);
  return agent;
}

// The CSRF token the admin forms require.
async function formTokenFor(agent) {
  const page = await agent.get('/admin/create-user');
  return page.text.match(/name="token" value="([^"]+)"/)[1];
}

async function createUser(agent, overrides = {}) {
  const token = await formTokenFor(agent);
  return agent.post('/admin/create-user').type('form').send({
    token,
    name: 'New Driver',
    email: 'new.driver@example.com',
    username: 'newdriver',
    role: 'driver',
    ...overrides,
  });
}

describe('creating a user without a password', () => {
  test('shows a setup link on the page', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: '' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('User created successfully.');
    expect(res.text).toMatch(/\/setup\/[0-9a-f]{64}/);
  });

  test('emails the same link to the new user', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: '' });

    const linkOnPage = res.text.match(/(http:\/\/[^"]+\/setup\/[0-9a-f]{64})/)[1];
    const [message] = sentMessages();
    expect(message.to).toBe('new.driver@example.com');
    expect(message.text).toContain(linkOnPage);
  });

  test('stores the hash of the token, not the token in the link', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: '' });

    const rawToken = res.text.match(/\/setup\/([0-9a-f]{64})/)[1];
    expect(insertedTokens).toHaveLength(1);
    expect(insertedTokens[0].tokenHash).toBe(hashToken(rawToken));
    expect(insertedTokens[0].tokenHash).not.toBe(rawToken);
    expect(insertedTokens[0].userId).toBe(42);
  });

  test('the account gets a password nobody knows', async () => {
    const agent = await signInAsAdmin();
    await createUser(agent, { password: '' });

    const [user] = insertedUsers;
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    // Common guesses must not open the account.
    for (const guess of ['', 'password', 'newdriver', 'Password1!']) {
      expect(await verifyPassword(guess, user.passwordHash)).toBe(false);
    }
  });
});

describe('creating a user with a password (unchanged behaviour)', () => {
  test('works as before and issues no setup link', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: 'ChosenPass1!' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('User created successfully.');
    expect(res.text).not.toMatch(/\/setup\//);
    expect(insertedTokens).toHaveLength(0);
    expect(sentMessages()).toHaveLength(0);
    expect(await verifyPassword('ChosenPass1!', insertedUsers[0].passwordHash)).toBe(true);
  });

  test('a short password is still rejected', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: 'short' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('at least 8 characters');
    expect(insertedUsers).toHaveLength(0);
  });

  test('other validation still applies with a blank password', async () => {
    const agent = await signInAsAdmin();
    const res = await createUser(agent, { password: '', email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('valid email address');
    expect(insertedTokens).toHaveLength(0);
  });
});

describe('access', () => {
  test('a non-admin cannot reach the create-user page', async () => {
    const res = await request(app).get('/admin/create-user');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
