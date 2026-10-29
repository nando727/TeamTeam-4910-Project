// RC#2: an admin sees, adds, and removes a driver's sponsorships.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const users = [
  { id: 3, username: 'admin1', role: 'admin', status: 'active', sponsor_id: null },
  { id: 1, username: 'driver1', role: 'driver', status: 'active', sponsor_id: null },
  { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active', sponsor_id: 1 },
];
const sponsors = [
  { id: 1, name: 'Demo Sponsor', contactEmail: 'd@example.com', status: 'active' },
  { id: 2, name: 'Northstar Freight', contactEmail: 'n@example.com', status: 'active' },
  { id: 3, name: 'Quiet Logistics', contactEmail: 'q@example.com', status: 'inactive' },
];
let passwordHash;
let memberships;
let removalAlerts;
let conn;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  removalAlerts = [];
  conn = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async (sql, params) => {
      if (sql.startsWith('SELECT s.name')) return [memberships.filter(m => m.driverId === params[0] && m.sponsorId === params[1]).map(m => ({ name: sponsors.find(s => s.id === m.sponsorId).name }))];
      if (sql.startsWith('INSERT INTO sponsor_removal_alerts')) { removalAlerts.push(params); return [{ affectedRows: 1 }]; }
      return [await db.query(sql, params)];
    }),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  memberships = [{ driverId: 1, sponsorId: 1, balance: 260, joinedAt: new Date('2026-10-01T00:00:00Z') }];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) return [{ failures: 0, latest_failure: null }];
    if (sql.includes('FROM users WHERE username')) {
      const u = users.find(x => x.username === params[0]);
      return u ? [{ ...u, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return users.filter(u => u.id === params[0]).map(u => ({ ...u, name: null, email: null }));
    if (sql.includes('FROM users ORDER BY')) return users;
    if (sql.includes('FROM sponsors ORDER BY')) return sponsors;
    if (sql.startsWith('SELECT s.id, s.name, s.status, ds.point_balance AS balance')) {
      return memberships.filter(m => m.driverId === params[0]).map(m => ({ ...sponsors.find(s => s.id === m.sponsorId), balance: m.balance, joinedAt: m.joinedAt }));
    }
    if (sql.startsWith('INSERT INTO driver_sponsors')) {
      const [driverId, sponsorId] = params;
      if (memberships.some(m => m.driverId === driverId && m.sponsorId === sponsorId)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      memberships.push({ driverId, sponsorId, balance: 0, joinedAt: new Date() });
      return { affectedRows: 1 };
    }
    if (sql.startsWith('DELETE FROM driver_sponsors')) {
      const before = memberships.length;
      memberships = memberships.filter(m => !(m.driverId === params[0] && m.sponsorId === params[1]));
      return { affectedRows: before - memberships.length };
    }
    // Story 22255 follow-up: the list asks who still owes us a password.
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}
const hidden = (page, name) => page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
const PAGE = '/admin/manage-users/1/sponsors';

describe('seeing a driver\'s sponsors (story 8)', () => {
  test('admins only; the manage-users list links to it for drivers', async () => {
    await request(app).get(PAGE).expect(302).expect('Location', '/login');
    const sponsor = await login('sponsor1');
    await sponsor.get(PAGE).expect(403);
    const admin = await login('admin1');
    const list = await admin.get('/admin/manage-users').expect(200);
    expect(list.text).toContain(`href="${PAGE}"`);
    expect(list.text).not.toContain('href="/admin/manage-users/2/sponsors"');
    await admin.get('/admin/manage-users/2/sponsors').expect(400);
  });

  test('lists every sponsorship with its balance and offers only the others to add', async () => {
    memberships.push({ driverId: 1, sponsorId: 2, balance: 40, joinedAt: new Date('2026-10-20T00:00:00Z') });
    const admin = await login('admin1');
    const page = await admin.get(PAGE).expect(200);
    expect(page.text).toContain('Sponsorships</dt><dd>2</dd>');
    expect(page.text).toMatch(/Demo Sponsor<\/td>[\s\S]*?<td class="num">260<\/td>\s*<td class="nowrap">2026-10-01<\/td>/);
    expect(page.text).toMatch(/Northstar Freight<\/td>[\s\S]*?<td class="num">40<\/td>/);
    expect(page.text).toContain('action="/admin/manage-users/1/sponsors/1/remove"');
    expect(page.text).toContain('<option value="3">Quiet Logistics (inactive)</option>');
    expect(page.text).not.toContain('<option value="1">');
    expect(page.text).not.toContain('<option value="2">');
  });
});

describe('adding a sponsorship (story 9)', () => {
  test('adds a second sponsor and keeps the first', async () => {
    const admin = await login('admin1');
    const token = hidden(await admin.get(PAGE), 'token');
    await admin.post(PAGE).type('form').send({ token, sponsor: '2' }).expect(303).expect('Location', PAGE);
    expect(memberships.map(m => m.sponsorId)).toEqual([1, 2]);
    const page = await admin.get(PAGE).expect(200);
    expect(page.text).toContain('driver1 now belongs to Northstar Freight.');
    expect(page.text).toContain('Sponsorships</dt><dd>2</dd>');
  });

  test('a duplicate, an unknown sponsor, or a missing token is refused', async () => {
    const admin = await login('admin1');
    const token = hidden(await admin.get(PAGE), 'token');
    await admin.post(PAGE).type('form').send({ token, sponsor: '1' }).expect(303);
    expect((await admin.get(PAGE)).text).toContain('This driver already belongs to that sponsor.');
    await admin.post(PAGE).type('form').send({ token, sponsor: '99' }).expect(303);
    expect((await admin.get(PAGE)).text).toContain('Choose a sponsor from the list.');
    await admin.post(PAGE).type('form').send({ sponsor: '2' }).expect(403);
    expect(memberships).toHaveLength(1);
  });
});

describe('removing one sponsorship (story 10)', () => {
  test('asks for confirmation, then removes only that sponsor', async () => {
    memberships.push({ driverId: 1, sponsorId: 2, balance: 40, joinedAt: new Date() });
    const admin = await login('admin1');
    const token = hidden(await admin.get(PAGE), 'token');
    await admin.post(`${PAGE}/1/remove`).type('form').send({ token }).expect(303).expect('Location', PAGE);
    expect(memberships).toHaveLength(2);
    const confirm = await admin.get(PAGE).expect(200);
    expect(confirm.text).toContain('Remove driver1 from Demo Sponsor?');
    expect(confirm.text).toContain('balance of <strong>260 points</strong>');
    const confirmId = hidden(confirm, 'confirmId');
    await admin.post(`${PAGE}/1/remove/confirm`).type('form').send({ token, confirmId }).expect(303).expect('Location', PAGE);
    expect(memberships.map(m => m.sponsorId)).toEqual([2]);
    expect(removalAlerts).toEqual([[1, 'Demo Sponsor']]);
    expect(conn.commit).toHaveBeenCalledOnce();
    const after = await admin.get(PAGE).expect(200);
    expect(after.text).toContain('Removed driver1 from Demo Sponsor. Other sponsorships were left in place.');
    expect(after.text).not.toContain('Remove driver1 from');
  });

  test('a forged or stale confirmation is rejected, and cancel clears it', async () => {
    const admin = await login('admin1');
    const token = hidden(await admin.get(PAGE), 'token');
    await admin.post(`${PAGE}/1/remove/confirm`).type('form').send({ token, confirmId: 'nope' }).expect(400);
    await admin.post(`${PAGE}/1/remove`).type('form').send({ token }).expect(303);
    await admin.post(`${PAGE}/2/remove/confirm`).type('form').send({ token, confirmId: hidden(await admin.get(PAGE), 'confirmId') }).expect(400);
    await admin.post(`${PAGE}/cancel`).type('form').send({ token }).expect(303);
    expect((await admin.get(PAGE)).text).not.toContain('Remove driver1 from');
    expect(memberships).toHaveLength(1);
  });
});
