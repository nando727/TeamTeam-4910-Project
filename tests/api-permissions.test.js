// Story 22251: the JSON API refuses actions outside the caller's role.
//
// These endpoints were reachable by anyone: POST /api/users takes a `role`,
// so an anonymous request could create an administrator.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'Password1!';
const ACCOUNTS = {
  driver1: { id: 1, role: 'driver' },
  sponsor1: { id: 2, role: 'sponsor' },
  admin1: { id: 3, role: 'admin' },
};

let passwordHash;
let insertedUsers;
let insertedSponsors;
let contactUpdates;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  insertedUsers = [];
  insertedSponsors = [];
  contactUpdates = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      const account = ACCOUNTS[username];
      if (!account) return [];
      return [{ ...account, username, password_hash: passwordHash, status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    if (sql.startsWith('SELECT id FROM users WHERE email')) return [];
    if (sql.startsWith('INSERT INTO users')) {
      insertedUsers.push(params);
      return { insertId: 99 };
    }
    if (sql.startsWith('INSERT INTO sponsors')) {
      insertedSponsors.push(params);
      return { insertId: 55 };
    }
    if (sql.includes('FROM users WHERE id')) {
      const [id] = params;
      const entry = Object.entries(ACCOUNTS).find(([, a]) => a.id === id);
      if (!entry) return [];
      const [username, account] = entry;
      return [{ id: account.id, name: username, email: `${username}@example.com`, username, role: account.role, status: 'active' }];
    }
    if (sql.startsWith('UPDATE users SET name')) {
      const [name, email, id] = params;
      contactUpdates.push({ name, email, id });
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT id FROM users WHERE email = ? AND id')) return [];
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

const NEW_USER = {
  name: 'Mallory', email: 'mallory@example.com',
  username: 'mallory', password: 'LongEnoughPass1!', role: 'admin',
};
const NEW_SPONSOR = {
  name: 'Example Freight', contactEmail: 'ops@example-freight.test', address: '1 Depot Rd',
};

describe('creating a user through the API', () => {
  test('an anonymous request cannot create an administrator', async () => {
    const res = await request(app).post('/api/users').send(NEW_USER);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signed in/i);
    expect(insertedUsers).toHaveLength(0);
  });

  test('a driver cannot create a user', async () => {
    const agent = await signIn('driver1');
    const res = await agent.post('/api/users').send(NEW_USER);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
    expect(insertedUsers).toHaveLength(0);
  });

  test('a sponsor cannot create a user', async () => {
    const agent = await signIn('sponsor1');
    const res = await agent.post('/api/users').send(NEW_USER);

    expect(res.status).toBe(403);
    expect(insertedUsers).toHaveLength(0);
  });

  test('an admin still can', async () => {
    const agent = await signIn('admin1');
    const res = await agent.post('/api/users').send(NEW_USER);

    expect(res.status).toBe(201);
    expect(insertedUsers).toHaveLength(1);
  });
});

describe('creating a sponsor organization through the API', () => {
  test('an anonymous request is refused', async () => {
    const res = await request(app).post('/api/sponsors').send(NEW_SPONSOR);

    expect(res.status).toBe(401);
    expect(insertedSponsors).toHaveLength(0);
  });

  test('a driver is refused', async () => {
    const agent = await signIn('driver1');
    const res = await agent.post('/api/sponsors').send(NEW_SPONSOR);

    expect(res.status).toBe(403);
    expect(insertedSponsors).toHaveLength(0);
  });

  test('an admin still can', async () => {
    const agent = await signIn('admin1');
    const res = await agent.post('/api/sponsors').send(NEW_SPONSOR);

    expect(res.status).toBe(201);
    expect(insertedSponsors).toHaveLength(1);
  });
});

describe('the refusals behave like an API, not a web page', () => {
  test('a refused request gets JSON, never a redirect to the login page', async () => {
    const res = await request(app).post('/api/users').send(NEW_USER);

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toMatch(/<html/i);
  });

  test('the refusal does not say whether the account exists', async () => {
    const agent = await signIn('driver1');
    const res = await agent.post('/api/users').send(NEW_USER);

    expect(res.body.error).not.toMatch(/mallory/i);
  });
});

describe('the public endpoint stays public', () => {
  test('anyone can read /api/about', async () => {
    const res = await request(app).get('/api/about');

    // 404 when nothing is seeded, 200 when it is — both mean it was not refused.
    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('the profile endpoints act on the signed-in user', () => {
  test('an anonymous request cannot read a profile', async () => {
    const res = await request(app).get('/api/profile');

    expect(res.status).toBe(401);
    expect(res.body.name).toBeUndefined();
  });

  test('a driver reads their own profile, not the first admin', async () => {
    const agent = await signIn('driver1');
    const res = await agent.get('/api/profile');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ACCOUNTS.driver1.id);
    expect(res.body.role).toBe('driver');
  });

  test('an admin reads their own profile', async () => {
    const agent = await signIn('admin1');
    const res = await agent.get('/api/profile');

    expect(res.body.id).toBe(ACCOUNTS.admin1.id);
  });

  test('an update changes the signed-in account, not the first admin', async () => {
    const agent = await signIn('driver1');
    const res = await agent.put('/api/profile').send({ name: 'New Name', email: 'new@example.com' });

    expect(res.status).toBe(200);
    // Previously this wrote to whichever admin had the lowest id.
    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0].id).toBe(ACCOUNTS.driver1.id);
  });

  test('an id in the request body is ignored', async () => {
    const agent = await signIn('driver1');
    await agent.put('/api/profile').send({
      id: ACCOUNTS.admin1.id, userId: ACCOUNTS.admin1.id,
      name: 'Not The Admin', email: 'nope@example.com',
    });

    expect(contactUpdates[0].id).toBe(ACCOUNTS.driver1.id);
  });

  test('an anonymous update is refused and writes nothing', async () => {
    const res = await request(app).put('/api/profile').send({ name: 'X', email: 'x@example.com' });

    expect(res.status).toBe(401);
    expect(contactUpdates).toHaveLength(0);
  });

  test('name and email are still required', async () => {
    const agent = await signIn('driver1');
    const res = await agent.put('/api/profile').send({ name: '', email: '' });

    expect(res.status).toBe(400);
    expect(contactUpdates).toHaveLength(0);
  });
});
