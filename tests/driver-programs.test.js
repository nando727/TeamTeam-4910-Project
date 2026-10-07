import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { setApplicationStatus } = require('../src/applications');
let hash;
let programs;
let conn;
let history;

beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  programs = [];
  history = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.includes('FROM users')) return [{ id: 1, username: params[0],
      role: ['sponsor', 'admin'].includes(params[0]) ? params[0] : 'driver', status: 'active',
      sponsor_id: 7, password_hash: hash }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM driver_sponsors')) return programs;
    if (sql.includes('FROM point_transactions')) return history;
    if (sql.includes('FROM sponsor_applications')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
  conn = {
    beginTransaction: vi.fn().mockResolvedValue(),
    execute: vi.fn().mockImplementation(async sql => {
      if (sql.startsWith('SELECT')) return [[{ driver_id: 12, status: 'pending' }]];
      return [{ affectedRows: 1 }];
    }),
    commit: vi.fn().mockResolvedValue(), rollback: vi.fn().mockResolvedValue(), release: vi.fn(),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
});
afterEach(() => vi.restoreAllMocks());

async function login(username = 'driver') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

test('approval saves the membership and decision in one transaction', async () => {
  expect(await setApplicationStatus(5, 'approved', 7)).toBe(true);
  expect(conn.execute.mock.calls[0][1]).toEqual([5, 7]);
  expect(conn.execute.mock.calls[0][0]).toContain('FOR UPDATE');
  expect(conn.execute.mock.calls[1][1]).toEqual(['approved', null, 5, 7]);
  expect(conn.execute.mock.calls[2][1]).toEqual([12, 7]);
  // The insert leaves the database's default balance at zero and never resets points.
  expect(conn.execute.mock.calls[2][0]).not.toContain('point_balance');
  expect(conn.commit).toHaveBeenCalledOnce();
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledOnce();
});

test('rejection does not create a membership', async () => {
  await setApplicationStatus(5, 'rejected', 7, 'Program is full');
  expect(conn.execute).toHaveBeenCalledTimes(2);
  expect(conn.execute.mock.calls[1][1]).toEqual(['rejected', 'Program is full', 5, 7]);
  expect(conn.commit).toHaveBeenCalledOnce();
});

test('wrong sponsor or repeated decisions cannot change membership or points', async () => {
  for (const rows of [[], [{ driver_id: 12, status: 'approved' }]]) {
    conn.execute.mockResolvedValueOnce([rows]);
    expect(await setApplicationStatus(5, 'approved', 99)).toBe(false);
  }
  expect(conn.execute).toHaveBeenCalledTimes(2);
  expect(conn.commit).not.toHaveBeenCalled();
});

test('a failed membership insert rolls back the approval', async () => {
  conn.execute.mockResolvedValueOnce([[{ driver_id: 12, status: 'pending' }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]).mockRejectedValueOnce(new Error('Insert failed'));
  await expect(setApplicationStatus(5, 'approved', 7)).rejects.toThrow('Insert failed');
  expect(conn.rollback).toHaveBeenCalledOnce();
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledOnce();
});

test('sponsor approval route uses the organization from the login session', async () => {
  const agent = await login('sponsor');
  // Include a pending application so the homepage renders an approval form.
  db.query.mockResolvedValueOnce([{ id: 5, full_name: 'Driver', contact_email: 'd@example.com', reason: 'Apply', status: 'pending' }]);
  const home = await agent.get('/').expect(200);
  const token = home.text.match(/name="token" value="([^"]+)"/)[1];
  await agent.post('/applications/5/approve').type('form').send({ token, sponsorId: 99 }).expect(302);
  expect(conn.execute.mock.calls[0][1]).toEqual(['5', 7]);
  expect(conn.commit).toHaveBeenCalledOnce();
});

test('program page requires a driver login', async () => {
  await request(app).get('/driver/programs').expect(302);
  const sponsor = await login('sponsor');
  await sponsor.get('/driver/programs').expect(403);
});

test('driver without an approved membership sees an explanation', async () => {
  const agent = await login();
  const page = await agent.get('/driver/programs').expect(200);
  expect(page.text).toContain('You have not joined a sponsor program yet.');
});

test('driver sees their own current balance, including zero and an inactive sponsor', async () => {
  programs = [{ id: 7, name: 'First Sponsor', status: 'active', point_balance: 0 }];
  const agent = await login();
  const page = await agent.get('/driver/programs?driver_id=99').expect(200);
  expect(page.text).toContain('First Sponsor');
  expect(page.text).toContain('0 points');
  const query = db.query.mock.calls.find(([sql]) => sql.includes('FROM driver_sponsors'));
  expect(query[0]).toContain('ds.driver_id = ?');
  expect(query[0]).toContain("a.status = 'approved'");
  expect(query[1]).toEqual([1]);
  programs[0].point_balance = 1250;
  programs[0].status = 'inactive';
  const refreshed = await agent.get('/driver/programs');
  expect(refreshed.text).toContain('1,250 points');
  expect(refreshed.text).toContain('This sponsor is currently inactive.');
});

test('a second sponsor approval is rolled back when the driver already has a membership', async () => {
  conn.execute.mockResolvedValueOnce([[{ driver_id: 12, status: 'pending' }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockRejectedValueOnce(Object.assign(new Error('Duplicate driver'), { code: 'ER_DUP_ENTRY' }));
  await expect(setApplicationStatus(6, 'approved', 8)).rejects.toMatchObject({ code: 'DRIVER_ALREADY_SPONSORED' });
  expect(conn.rollback).toHaveBeenCalledOnce();
  expect(conn.commit).not.toHaveBeenCalled();
});

test('point history requires a driver login', async () => {
  await request(app).get('/driver/points/history').expect(302);
  for (const role of ['sponsor', 'admin']) {
    const agent = await login(role);
    await agent.get('/driver/points/history').expect(403);
  }
  expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM point_transactions'))).toBe(false);
});

test('history shows signed amounts, dates, sponsor names, and safely escaped reasons', async () => {
  history = [
    { id: 2, changedAt: new Date('2026-10-07T12:00:00Z'), sponsorName: 'First Sponsor', pointsChange: -25, reason: 'Late delivery' },
    { id: 1, changedAt: new Date('2026-10-06T10:30:00Z'), sponsorName: 'First Sponsor', pointsChange: 1250, reason: 'Safe driving <bonus>' },
  ];
  const agent = await login();
  const page = await agent.get('/driver/points/history').expect(200);
  expect(page.text).toContain('2026-10-07 12:00:00');
  expect(page.text).toContain('First Sponsor');
  expect(page.text).toContain('-25');
  expect(page.text).toContain('+1,250');
  expect(page.text).toContain('Late delivery');
  expect(page.text).toContain('Safe driving &lt;bonus&gt;');
  expect(page.text.indexOf('Late delivery')).toBeLessThan(page.text.indexOf('Safe driving &lt;bonus&gt;'));
});

test('entire history uses session identity with no date, membership, or result limit', async () => {
  history = Array.from({ length: 120 }, (_, i) => ({ id: 120 - i,
    changedAt: new Date('2025-01-01T00:00:00Z'), sponsorName: 'Previous Sponsor',
    pointsChange: 1, reason: `Recorded change ${120 - i}` }));
  const agent = await login();
  const page = await agent.get('/driver/points/history?driver=99&driverId=99&sponsor=99&from=2026-10-01').expect(200);
  expect((page.text.match(/Recorded change /g) || []).length).toBe(120);
  expect(page.text).toContain('Previous Sponsor');
  const [sql, params] = db.query.mock.calls.find(([query]) => query.includes('FROM point_transactions'));
  expect(params).toEqual([1]);
  expect(sql).toContain('WHERE t.driver_id = ?');
  expect(sql).toContain('ORDER BY t.created_at DESC, t.id DESC');
  expect(sql).not.toMatch(/LIMIT|driver_sponsors|t.created_at >=|t.sponsor_id = \?/);
});

test('no history shows an empty message and history is linked from driver pages', async () => {
  const agent = await login();
  expect((await agent.get('/driver/points/history').expect(200)).text).toContain('You have no recorded point changes yet.');
  expect((await agent.get('/')).text).toContain('href="/driver/points/history"');
  expect((await agent.get('/driver/programs')).text).toContain('href="/driver/points/history"');
});
