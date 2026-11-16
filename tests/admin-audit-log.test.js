// Sprint 9: the administrator audit log. Role changes, status changes,
// password resets, unlocks, and sponsorship changes are recorded, and a
// failed write never undoes the change it was describing.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { recordAdminAction, listAdminActions, countAdminActions, actionLabel } = require('../src/admin/audit');

const ADMIN = { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada', email: 'ada@example.com', sponsor_id: null };
const DRIVER = { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Theo', email: 'theo@example.com', sponsor_id: null };

let hash;
let rows;
let total;
let written;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  written = [];
  queries = [];
  total = 2;
  rows = [
    { id: 2, action: 'role-change', detail: 'driver1: driver to sponsor; removed 2 memberships', createdAt: new Date('2026-11-10T12:00:00Z'), adminUserId: 3, adminUsername: 'admin1', targetUserId: 1, targetUsername: 'driver1', targetRole: 'sponsor' },
    { id: 1, action: 'status-change', detail: 'driver1: active to disabled', createdAt: new Date('2026-11-09T08:30:00Z'), adminUserId: 3, adminUsername: 'admin1', targetUserId: 1, targetUsername: 'driver1', targetRole: 'sponsor' },
  ];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = [ADMIN, DRIVER].find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const user = [ADMIN, DRIVER].find(u => u.id === params[0]);
      return user ? [user] : [];
    }
    if (sql.startsWith('INSERT INTO admin_actions')) { written.push(params); return { insertId: written.length }; }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM admin_actions')) return [{ total }];
    if (sql.includes('FROM admin_actions a')) return rows;
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function admin(username = 'admin1') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

describe('recording', () => {
  test('writes the administrator, the account, the action, and a sentence', async () => {
    expect(await recordAdminAction({ adminUserId: 3, targetUserId: 1, action: 'role-change', detail: 'driver1: driver to sponsor' })).toBe(true);
    expect(written[0]).toEqual([3, 1, 'role-change', 'driver1: driver to sponsor']);
  });

  test('an action it does not know is recorded as "other" rather than dropped', async () => {
    await recordAdminAction({ adminUserId: 3, targetUserId: 1, action: 'something-new' });
    expect(written[0][2]).toBe('other');
    expect(written[0][3]).toBeNull();
    expect(actionLabel('something-new')).toBe('Other');
  });

  test('a long detail is cut to fit the column', async () => {
    await recordAdminAction({ adminUserId: 3, action: 'role-change', detail: 'x'.repeat(900) });
    expect(written[0][3]).toHaveLength(500);
  });

  test('a failed write is reported and does not throw, because the change already happened', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.startsWith('INSERT INTO admin_actions')) throw new Error('table is missing');
      return [];
    });
    expect(await recordAdminAction({ adminUserId: 3, targetUserId: 1, action: 'unlock' })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not record "unlock"'));
  });
});

describe('reading', () => {
  test('newest first, with both usernames joined in', async () => {
    const list = await listAdminActions({}, { limit: 25, offset: 0 });
    expect(list).toHaveLength(2);
    const [sql] = queries.find(([q]) => q.includes('FROM admin_actions a'));
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(sql).toContain('LEFT JOIN users admin');
    expect(sql).toContain('LEFT JOIN users target');
  });

  test('filters by action and by account, and ignores an action it does not know', async () => {
    await listAdminActions({ action: 'role-change', targetUserId: 1 });
    const [sql, params] = queries.find(([q]) => q.includes('FROM admin_actions a'));
    expect(sql).toContain('WHERE a.action = ? AND a.target_user_id = ?');
    expect(params).toEqual(['role-change', 1]);
    queries.length = 0;
    await countAdminActions({ action: 'nonsense' });
    expect(queries[0][1]).toEqual([]);
  });
});

describe('the page', () => {
  test('is admin only and linked from the nav, the home page, and Manage users', async () => {
    await request(app).get('/admin/audit-log').expect(302);
    const driver = await admin('driver1');
    await driver.get('/admin/audit-log').expect(403);
    const agent = await admin();
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('href="/admin/audit-log"');
    expect(home.text).toContain('>Audit log</a>');
  });

  test('lists what was done, to whom, by whom, and when', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/audit-log').expect(200);
    expect(page.text).toContain('Role changed');
    expect(page.text).toContain('Status changed');
    expect(page.text).toContain('driver1: driver to sponsor; removed 2 memberships');
    expect(page.text).toContain('2026-11-10 12:00');
    expect(page.text).toContain('Showing 1 to 2 of 2 actions.');
    // Each row links to the same log filtered to that account.
    expect(page.text).toContain('href="/admin/audit-log?user=1"');
  });

  test('filters by action and by account', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/audit-log?action=role-change&user=1').expect(200);
    expect(page.text).toContain('<option value="role-change" selected>');
    expect(page.text).toContain('Filtered to <strong>driver1</strong>');
    const [, params] = queries.filter(([q]) => q.includes('FROM admin_actions a')).pop();
    expect(params).toEqual(['role-change', 1]);
  });

  test('pages, keeping the filters in the links', async () => {
    total = 60;
    const agent = await admin();
    const page = await agent.get('/admin/audit-log?action=unlock&page=2').expect(200);
    expect(page.text).toContain('Page 2 of 3');
    expect(page.text).toContain('href="/admin/audit-log?action=unlock&amp;page=3"');
  });

  test('says plainly when there is nothing to show', async () => {
    rows = [];
    total = 0;
    const agent = await admin();
    const empty = await agent.get('/admin/audit-log').expect(200);
    expect(empty.text).toContain('Nothing has been recorded yet.');
    const filtered = await agent.get('/admin/audit-log?action=unlock').expect(200);
    expect(filtered.text).toContain('Nothing matches these filters.');
  });

  test('a deleted account still shows as an id rather than as nothing', async () => {
    rows = [{ id: 5, action: 'password-reset', detail: 'reset', createdAt: new Date('2026-11-01T00:00:00Z'), adminUserId: 9, adminUsername: null, targetUserId: 8, targetUsername: null, targetRole: null }];
    total = 1;
    const agent = await admin();
    const page = await agent.get('/admin/audit-log').expect(200);
    expect(page.text).toContain('deleted account #8');
    expect(page.text).toContain('deleted account #9');
  });
});
