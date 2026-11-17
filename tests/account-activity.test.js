// aa-76 a user sees what an administrator changed on their own account
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const DRIVER = { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Theo', email: 'theo@example.com', sponsor_id: null };
const OTHER = { id: 2, username: 'driver2', role: 'driver', status: 'active', name: 'Dana', email: 'dana@example.com', sponsor_id: null };

let hash;
let rows;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

const change = (over = {}) => ({
  type: 'status.changed', detail: 'disabled to active', occurred_at_ms: Date.UTC(2026, 10, 12, 9, 30),
  actor_username: 'admin1', subject_user_id: 1, subject_username: 'driver1', subject_role: 'driver', sponsor_name: null, ...over,
});

beforeEach(() => {
  queries = [];
  rows = [
    change(),
    change({ type: 'password.changed', detail: 'method=admin-reset' }),
    change({ type: 'points.changed', detail: '+50 points: safe driving', sponsor_name: 'Acme' }),
  ];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = [DRIVER, OTHER].find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return [DRIVER, OTHER].filter(u => u.id === params[0]);
    if (sql.includes('FROM audit_events ae')) return sql.includes('COUNT(*)') ? [{ total: rows.length }] : rows;
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function signIn(username = 'driver1') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

const listQuery = () => queries.filter(([sql]) => sql.includes('FROM audit_events ae') && !sql.includes('COUNT(*)')).pop();

describe('account activity', () => {
  test("lists an admin's changes from a link on the profile, in plain words", async () => {
    const agent = await signIn();
    expect((await agent.get('/profile').expect(200)).text).toContain('href="/profile/activity"');

    const page = await agent.get('/profile/activity').expect(200);

    expect(page.text).toContain('3 changes.');
    expect(page.text).toContain('2026-11-12 09:30');
    expect(page.text).toContain('disabled to active');
    expect(page.text).toContain('Reset by an administrator');
    expect(page.text).not.toContain('method=admin-reset');
    expect(page.text).toContain('+50 points: safe driving (Acme)');
  });

  test('only ever reads the signed-in account, whatever the address asks for', async () => {
    await (await signIn('driver2')).get('/profile/activity?user=1&userId=1').expect(200);

    expect(listQuery()[0]).toContain("a.role = 'admin'");
    expect(listQuery()[1]).toEqual([2, '50', '0']);
  });

  test('says so when an admin has changed nothing', async () => {
    rows = [];
    const page = await (await signIn()).get('/profile/activity').expect(200);

    expect(page.text).toContain('An administrator has not changed anything on your account.');
  });

  test('a signed-out visitor is sent to log in', async () => {
    await request(app).get('/profile/activity').expect(302).expect('Location', '/login');
  });
});
