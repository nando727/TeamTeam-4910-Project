// Story AA-72: an administrator can see that someone is locked out of signing
// in, and let them back in. How the lock is cleared without touching the audit
// log is covered in tests/lockout-unlock.test.js.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const LAPTOP = '198.51.100.9';

const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  { id: 1, username: 'driver1', role: 'driver', status: 'active' },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active' },
];

let passwordHash;
let attempts;   // fake login_attempts: { username, source, success, at }
let unlocks;    // fake login_unlocks:  { username, by, at }

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

// Failures for one (username, source) pair since that pair's last success and
// since the username's last unlock, which is what both queries ask for.
function failuresFor(username, source, minutes) {
  const mine = attempts.filter(a => a.username === username && a.source === source);
  const lastSuccess = Math.max(0, ...mine.filter(a => a.success).map(a => a.at));
  const lastUnlock = Math.max(0, ...unlocks.filter(u => u.username === username).map(u => u.at));
  const since = Math.max(lastSuccess, lastUnlock, Date.now() - minutes * 60 * 1000);
  return mine.filter(a => !a.success && a.at > since);
}

beforeEach(() => {
  attempts = [];
  unlocks = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // --- the admin list's grouped lookup: who is locked anywhere -----------
    if (sql.includes('GROUP BY username, source_ip')) {
      const [minutes, maxFailures] = params;
      const pairs = new Set(attempts.map(a => `${a.username}\u0000${a.source}`));
      const rows = [];
      for (const pair of pairs) {
        const [username, source] = pair.split('\u0000');
        const failures = failuresFor(username, source === 'null' ? null : source, minutes);
        if (failures.length >= maxFailures) {
          rows.push({
            username,
            failures: failures.length,
            latest_failure: Math.max(...failures.map(a => a.at)),
          });
        }
      }
      return rows;
    }

    // --- the sign-in route's own check, for one pair ------------------------
    if (sql.includes('latest_failure')) {
      const [username, source, minutes] = params;
      const failures = failuresFor(username, source, minutes);
      return [{
        failures: failures.length,
        latest_failure: failures.length ? Math.max(...failures.map(a => a.at)) : null,
      }];
    }

    if (sql.startsWith('INSERT INTO login_attempts')) {
      attempts.push({ username: params[0], success: Boolean(params[1]), source: params[2], at: Date.now() });
      return {};
    }
    if (sql.startsWith('INSERT INTO login_unlocks')) {
      unlocks.push({ username: params[0], by: params[1], at: Date.now() });
      return { affectedRows: 1 };
    }

    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: passwordHash, sponsor_id: null }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]);
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];

    return [];
  });
});

afterEach(() => vi.restoreAllMocks());

function lockOut(username, source = LAPTOP) {
  // Planted rather than guessed through the form: five bcrypt comparisons per
  // test is slow, and the lock is read from these rows either way.
  for (let i = 0; i < 5; i += 1) {
    attempts.push({ username, source, success: false, at: Date.now() - 2000 });
  }
}

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

async function loadList(agent) {
  const page = await agent.get('/admin/manage-users').expect(200);
  return { page, token: page.text.match(/name="token" value="([^"]+)"/)[1] };
}

const signInAs = (username, password) =>
  request(app).post('/login').type('form').set('X-Forwarded-For', LAPTOP).send({ username, password });

describe('what Manage users shows', () => {
  test('a locked account is marked, and the mark leads to where it can be cleared', async () => {
    lockOut('driver1');
    const agent = await login('admin1');

    const { page } = await loadList(agent);

    expect(page.text).toMatch(/status-locked[^>]*>locked/);
    expect(page.text).toContain('href="/admin/locked-users"');
  });

  test('an account that can sign in is not marked', async () => {
    const agent = await login('admin1');

    const { page } = await loadList(agent);

    expect(page.text).not.toMatch(/status-locked/);
  });

  test('the unlock itself lives on the focused page, not in every row', async () => {
    // The column it used to sit in said "Not locked" for almost every account.
    lockOut('driver1');
    const agent = await login('admin1');

    const { page } = await loadList(agent);

    expect(page.text).not.toContain('/unlock');
  });

  test('only the locked account is marked', async () => {
    lockOut('driver1');
    const agent = await login('admin1');

    const { page } = await loadList(agent);

    // driver1 is id 1; the chip sits in that row and nowhere else.
    expect(page.text.match(/status-locked/g)).toHaveLength(1);
  });
});

describe('the locked users page', () => {
  const loadLocked = async (agent) => {
    const page = await agent.get('/admin/locked-users').expect(200);
    return { page, token: page.text.match(/name="token" value="([^"]+)"/)[1] };
  };

  test('lists only the accounts that cannot sign in', async () => {
    lockOut('driver1');
    const agent = await login('admin1');

    const { page } = await loadLocked(agent);

    expect(page.text).toContain('driver1');
    expect(page.text).not.toContain('sponsor1');
    expect(page.text).toContain('/admin/manage-users/1/unlock');
  });

  test('says so plainly when nobody is locked out', async () => {
    const agent = await login('admin1');

    const page = await agent.get('/admin/locked-users').expect(200);

    expect(page.text).toMatch(/Nobody is locked out/);
    expect(page.text).not.toContain('/unlock');
  });

  test('is reachable from the admin navigation', async () => {
    const agent = await login('admin1');

    const page = await agent.get('/admin/manage-users').expect(200);

    expect(page.text).toContain('href="/admin/locked-users"');
  });

  test('a driver cannot open it', async () => {
    const agent = await login('driver1');

    await agent.get('/admin/locked-users').expect(403);
  });
});

describe('unlocking', () => {
  const unlock = (agent, id, token, from) =>
    agent.post(`/admin/manage-users/${id}/unlock`).type('form').send({ token, from });

  test('the user can sign in again straight away', async () => {
    lockOut('driver1');
    // Blocked before the unlock, even with the right password.
    expect((await signInAs('driver1', PASSWORD)).status).toBe(429);

    const agent = await login('admin1');
    const { token } = await loadList(agent);
    await unlock(agent, 1, token, 'locked-users').expect(303);

    expect((await signInAs('driver1', PASSWORD)).status).toBe(302);
  });

  test('the admin lands back on the page they acted from, and is told it worked', async () => {
    lockOut('driver1');
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    const res = await unlock(agent, 1, token, 'locked-users').expect(303);
    expect(res.headers.location).toBe('/admin/locked-users');

    const page = await agent.get('/admin/locked-users').expect(200);
    expect(page.text).toContain('driver1 can sign in again.');
    expect(page.text).toMatch(/Nobody is locked out/);
  });

  test('an unlock from anywhere else returns to Manage users', async () => {
    lockOut('driver1');
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    const res = await unlock(agent, 1, token).expect(303);

    expect(res.headers.location).toBe('/admin/manage-users');
  });

  test('it is recorded against the administrator who did it', async () => {
    lockOut('driver1');
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    await unlock(agent, 1, token, 'locked-users').expect(303);

    expect(unlocks).toEqual([{ username: 'driver1', by: 3, at: expect.any(Number) }]);
  });

  test('an account that is not locked is left alone, and the notice says so', async () => {
    const agent = await login('admin1');
    const { token } = await loadList(agent);

    await unlock(agent, 1, token, 'locked-users').expect(303);
    const page = await agent.get('/admin/locked-users').expect(200);

    expect(page.text).toMatch(/No change needed, driver1 is not locked out/);
    expect(unlocks).toEqual([]);
  });
});

describe('who may unlock an account', () => {
  test('not a request without the form token', async () => {
    lockOut('driver1');
    const agent = await login('admin1');
    await loadList(agent);

    const res = await agent.post('/admin/manage-users/1/unlock').type('form').send({ token: 'made-up' });

    expect(res.status).toBe(403);
    expect(unlocks).toEqual([]);
  });

  test('not a driver', async () => {
    lockOut('sponsor1');
    const agent = await login('driver1');

    const res = await agent.post('/admin/manage-users/2/unlock').type('form').send({ token: 'anything' });

    expect(res.status).toBe(403);
    expect(unlocks).toEqual([]);
  });

  test('not a visitor who is not signed in at all', async () => {
    lockOut('driver1');

    const res = await request(app).post('/admin/manage-users/1/unlock').type('form').send({ token: 'anything' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(unlocks).toEqual([]);
  });
});
