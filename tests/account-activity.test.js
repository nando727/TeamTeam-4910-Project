// aa-76 a user sees what an administrator changed on their own account
// aa-78 and their own recent sign-ins, failed ones included
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
let signIns;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

const change = (over = {}) => ({
  type: 'status.changed', detail: 'disabled to active', occurred_at_ms: Date.UTC(2026, 10, 12, 9, 30),
  actor_username: 'admin1', subject_user_id: 1, subject_username: 'driver1', subject_role: 'driver', sponsor_name: null, ...over,
});

const signIn = (over = {}) => change({ type: 'login.succeeded', detail: 'from 203.0.113.7', actor_username: null, occurred_at_ms: Date.UTC(2026, 10, 14, 8, 5), ...over });

beforeEach(() => {
  queries = [];
  signIns = [
    signIn(),
    signIn({ type: 'login.failed', detail: 'from 198.51.100.23' }),
    signIn({ type: 'login.failed', detail: 'from an unknown address' }),
  ];
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
    if (sql.includes('FROM audit_events ae') && params.includes('login.succeeded')) return signIns;
    if (sql.includes('FROM audit_events ae')) return sql.includes('COUNT(*)') ? [{ total: rows.length }] : rows;
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function signInAs(username = 'driver1') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

const listQuery = () => queries.filter(([sql, params]) => sql.includes('FROM audit_events ae') && !sql.includes('COUNT(*)') && !params.includes('login.succeeded')).pop();
const signInQuery = () => queries.filter(([sql, params]) => sql.includes('FROM audit_events ae') && params.includes('login.succeeded')).pop();

describe('account activity', () => {
  test("lists an admin's changes from a link on the profile, in plain words", async () => {
    const agent = await signInAs();
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
    await (await signInAs('driver2')).get('/profile/activity?user=1&userId=1').expect(200);

    expect(listQuery()[0]).toContain("a.role = 'admin'");
    expect(listQuery()[1]).toEqual([2, '50', '0']);
  });

  test('says so when an admin has changed nothing', async () => {
    rows = [];
    const page = await (await signInAs()).get('/profile/activity').expect(200);

    expect(page.text).toContain('An administrator has not changed anything on your account.');
  });

  test('lists recent sign-ins, failed ones too, with where they came from', async () => {
    const page = await (await signInAs()).get('/profile/activity').expect(200);

    expect(page.text).toContain('Your last 3 sign-in attempts.');
    expect(page.text).toContain('2026-11-14 08:05');
    expect(page.text).toContain('203.0.113.7');
    expect(page.text).toContain('198.51.100.23');
    expect(page.text.match(/>Failed</g)).toHaveLength(2);
    expect(page.text).toContain('<td>Unknown</td>');
    expect(page.text).toContain('href="/profile/password"');
  });

  test("sign-ins are read for the session's account only, sign-in types only, at most 20", async () => {
    await (await signInAs('driver2')).get('/profile/activity?user=1').expect(200);

    expect(signInQuery()[1]).toEqual(['login.succeeded', 'login.failed', 2, '20', '0']);
  });

  test('says so when no sign-ins are recorded', async () => {
    signIns = [];
    const page = await (await signInAs()).get('/profile/activity').expect(200);

    expect(page.text).toContain('No sign-ins are recorded for your account yet.');
  });

  test('a signed-out visitor is sent to log in', async () => {
    await request(app).get('/profile/activity').expect(302).expect('Location', '/login');
  });
});
