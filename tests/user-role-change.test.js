// Sprint 9: an administrator can change a user's role. The change is
// confirmed on a page that lists exactly what it will remove, an admin cannot
// change their own role, the last administrator cannot be demoted, the rows
// tied to the old role go in one transaction, and the account is signed out
// everywhere afterwards.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { changeUserRole, roleChangeImpact } = require('../src/users/store');

const USERS = {
  3: { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada Admin', email: 'ada@example.com', sponsor_id: null },
  4: { id: 4, username: 'admin2', role: 'admin', status: 'active', name: 'Abe Admin', email: 'abe@example.com', sponsor_id: null },
  1: { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Theo Trucker', email: 'theo@example.com', sponsor_id: null },
  2: { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active', name: 'Sam Sponsor', email: 'sam@northstar.test', sponsor_id: 7 },
};

let hash;
let activeAdmins;
let counts;
let conn;
let executed;
let audits;
let revoked;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  activeAdmins = 2;
  audits = [];
  revoked = [];
  executed = [];
  counts = { memberships: { total: 2, points: 1500 }, applications: 3, preferences: 1, removalAlerts: 1, transactions: 9, purchases: 4 };
  conn = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async (sql, params) => {
      executed.push([sql, params]);
      if (sql.includes('FOR UPDATE')) {
        const user = USERS[params[0]];
        return [user ? [{ id: user.id, role: user.role }] : []];
      }
      if (sql.startsWith('DELETE FROM driver_sponsors')) return [{ affectedRows: 2 }];
      if (sql.startsWith('DELETE FROM sponsor_applications')) return [{ affectedRows: 3 }];
      if (sql.startsWith('DELETE FROM driver_alert_preferences')) return [{ affectedRows: 1 }];
      if (sql.startsWith('DELETE FROM sponsor_removal_alerts')) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    }),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = Object.values(USERS).find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return USERS[params[0]] ? [USERS[params[0]]] : [];
    if (sql.startsWith("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'")) return [{ total: activeAdmins }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM users u')) return [{ total: 4 }];
    if (sql.startsWith('SELECT u.id, u.name, u.email, u.username, u.role, u.status')) return Object.values(USERS);
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail')) return [{ id: 7, name: 'Northstar Freight', contactEmail: 'o@n.test', status: 'active' }];
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];
    if (sql.includes('COALESCE(SUM(point_balance), 0) AS points FROM driver_sponsors')) return [counts.memberships];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM sponsor_applications')) return [{ total: counts.applications }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM driver_alert_preferences')) return [{ total: counts.preferences }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM sponsor_removal_alerts')) return [{ total: counts.removalAlerts }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM point_transactions')) return [{ total: counts.transactions }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM purchases')) return [{ total: counts.purchases }];
    if (sql.startsWith('SELECT name FROM sponsors')) return [{ name: 'Northstar Freight' }];
    if (sql.startsWith('INSERT INTO admin_actions')) { audits.push(params); return { insertId: audits.length }; }
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) { revoked.push(params[0]); return { affectedRows: 1 }; }
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function admin(username = 'admin1') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}
async function tokenFor(agent) {
  const page = await agent.get('/admin/manage-users').expect(200);
  return page.text.match(/name="token" value="([a-f0-9]+)"/)[1];
}
const start = (agent, token, id, role) =>
  agent.post(`/admin/manage-users/${id}/role`).type('form').send({ token, role, from: 'manage-users' });

describe('the control on the list', () => {
  test('offers a role dropdown for others and only a chip for yourself', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users').expect(200);
    expect(page.text).toContain('action="/admin/manage-users/1/role"');
    expect(page.text).toContain('<label for="role-1" class="sr-only">Role for driver1</label>');
    expect(page.text).not.toContain('action="/admin/manage-users/3/role"');
    expect(page.text).toContain('Your own role');
  });
});

describe('refusals', () => {
  test('an admin cannot change their own role, even by posting directly', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    const res = await start(agent, token, 3, 'driver').expect(303);
    const page = await agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('You cannot change your own role.');
    expect(conn.beginTransaction).not.toHaveBeenCalled();
  });

  test('the last administrator who can sign in cannot be demoted', async () => {
    activeAdmins = 1;
    const agent = await admin();
    const token = await tokenFor(agent);
    const res = await start(agent, token, 4, 'driver').expect(303);
    const page = await agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('is the only administrator who can sign in');
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    // Promoting the same account is not a demotion and is allowed.
    await start(agent, token, 4, 'admin').expect(303);
  });

  test('a role that is not a role, or no confirmation, writes nothing', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await agent.post('/admin/manage-users/1/role').type('form').send({ token, role: 'wizard' }).expect(400);
    await agent.post('/admin/manage-users/1/role/confirm').type('form').send({ token, confirmId: 'nope' }).expect(400);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
  });

  test('a role that is already set changes nothing and says so', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    const res = await start(agent, token, 1, 'driver').expect(303);
    const page = await agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('No change needed, driver1 is already a driver.');
  });

  test('non-admins cannot reach any of it', async () => {
    const agent = await admin('driver1');
    await agent.post('/admin/manage-users/2/role').type('form').send({ role: 'admin' }).expect(403);
    await agent.get('/admin/manage-users/2/role/confirm').expect(403);
  });
});

describe('the confirmation page', () => {
  test('lists exactly what will be removed and what stays', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 1, 'sponsor').expect(303);
    const page = await agent.get('/admin/manage-users/1/role/confirm').expect(200);
    expect(page.text).toContain('Confirm role change');
    expect(page.text).toContain('2 sponsorships, including 1,500 points held with those sponsors');
    expect(page.text).toContain('3 sponsor applications, with their decisions and reasons');
    expect(page.text).toContain('their point-alert preference');
    expect(page.text).toContain('1 sponsor-removal alert');
    expect(page.text).toContain('9 point changes in the point history');
    expect(page.text).toContain('4 purchases in the sales, fee, and invoice reports');
    expect(page.text).toContain('the account itself, its username, email, and password');
    expect(page.text).toContain('signed out of every device');
    // Becoming a sponsor user needs an organization, which this does not set.
    expect(page.text).toContain('does not set one');
    expect(conn.beginTransaction).not.toHaveBeenCalled();
  });

  test('a driver with nothing attached says so instead of listing nothing', async () => {
    counts = { memberships: { total: 0, points: 0 }, applications: 0, preferences: 0, removalAlerts: 0, transactions: 0, purchases: 0 };
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 1, 'admin').expect(303);
    const page = await agent.get('/admin/manage-users/1/role/confirm').expect(200);
    expect(page.text).toContain('Nothing. This account has nothing tied to the driver role');
  });

  test('a sponsor user loses the link to their organization', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 2, 'driver').expect(303);
    const page = await agent.get('/admin/manage-users/2/role/confirm').expect(200);
    expect(page.text).toContain('their link to Northstar Freight');
    expect(page.text).not.toContain('sponsorships, including');
  });
});

describe('saving it', () => {
  test('removes the old role\'s rows in one transaction, logs it, and signs the account out', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 1, 'sponsor').expect(303);
    const confirm = await agent.get('/admin/manage-users/1/role/confirm').expect(200);
    const confirmId = confirm.text.match(/name="confirmId" value="([a-f0-9]{64})"/)[1];

    const res = await agent.post('/admin/manage-users/1/role/confirm').type('form').send({ token, confirmId }).expect(303);
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
    const sqls = executed.map(([sql]) => sql);
    expect(sqls.some(sql => sql.includes('FOR UPDATE'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM driver_sponsors'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM sponsor_applications'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM driver_alert_preferences'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM sponsor_removal_alerts'))).toBe(true);
    // The financial record is never touched.
    expect(sqls.some(sql => sql.includes('point_transactions') || sql.includes('purchases'))).toBe(false);
    expect(executed.some(([sql, params]) => sql.startsWith('UPDATE users SET role') && params[0] === 'sponsor')).toBe(true);

    expect(revoked).toContain(1);
    const [audit] = audits;
    expect(audit[0]).toBe(3);
    expect(audit[1]).toBe(1);
    expect(audit[2]).toBe('role-change');
    expect(audit[3]).toContain('driver1: driver to sponsor');
    expect(audit[3]).toContain('removed 2 memberships, 3 applications');

    const page = await agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('driver1 is now a sponsor.');
    expect(page.text).toContain('signed out everywhere');
  });

  test('the confirmation is single use', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 1, 'admin').expect(303);
    const confirm = await agent.get('/admin/manage-users/1/role/confirm').expect(200);
    const confirmId = confirm.text.match(/name="confirmId" value="([a-f0-9]{64})"/)[1];
    await agent.post('/admin/manage-users/1/role/confirm').type('form').send({ token, confirmId }).expect(303);
    await agent.post('/admin/manage-users/1/role/confirm').type('form').send({ token, confirmId }).expect(400);
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
  });

  test('the last-admin rule is checked again before writing, not only before confirming', async () => {
    const agent = await admin();
    const token = await tokenFor(agent);
    await start(agent, token, 4, 'driver').expect(303);
    const confirm = await agent.get('/admin/manage-users/4/role/confirm').expect(200);
    const confirmId = confirm.text.match(/name="confirmId" value="([a-f0-9]{64})"/)[1];
    // The other administrator is demoted by somebody else in the meantime.
    activeAdmins = 1;
    const res = await agent.post('/admin/manage-users/4/role/confirm').type('form').send({ token, confirmId }).expect(303);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    const page = await agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('is the only administrator who can sign in');
  });
});

describe('the store', () => {
  test('a role that has not changed is left alone, and a missing account is reported', async () => {
    expect(await changeUserRole(1, 'driver')).toEqual({ changed: false, reason: 'same', from: 'driver' });
    expect(conn.commit).not.toHaveBeenCalled();
    expect(await changeUserRole(99, 'driver')).toEqual({ changed: false, reason: 'missing' });
  });

  test('an admin leaving the admin role has nothing role-specific to remove', async () => {
    const impact = await roleChangeImpact(4, 'driver');
    expect(impact.removes).toEqual([]);
    expect(impact.keeps).toContain('the account itself, its username, email, and password');
    const result = await changeUserRole(4, 'driver');
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual({});
  });

  test('a failure anywhere in the cleanup rolls the whole change back', async () => {
    conn.execute.mockImplementation(async (sql, params) => {
      if (sql.includes('FOR UPDATE')) return [[{ id: 1, role: 'driver' }]];
      if (sql.startsWith('DELETE FROM sponsor_applications')) throw new Error('database is down');
      return [{ affectedRows: 1 }];
    });
    await expect(changeUserRole(1, 'admin')).rejects.toThrow('database is down');
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
  });
});
