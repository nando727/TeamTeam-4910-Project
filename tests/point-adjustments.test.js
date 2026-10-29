import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { adjustPoints } = require('../src/points/store');
const { hashPassword } = require('../src/auth/password');
let conn;
let hash;
let alertAmount;
let alertsEnabled;
beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  alertAmount = 25;
  alertsEnabled = true;
  conn = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async sql => sql.startsWith('SELECT') ? [[{ point_balance: 100, name: 'Demo' }]] : [{ insertId: 42, affectedRows: 1 }]),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT point_alerts_enabled')) return [{ point_alerts_enabled: alertsEnabled }];
    if (sql.startsWith('INSERT INTO driver_alert_preferences')) { alertsEnabled = Boolean(params[1]); return {}; }
    if (sql.includes('FROM sponsor_removal_alerts')) return [{ id: 9, sponsor_name: 'Former Sponsor', created_at: '2026-10-28T12:00:00Z' }];
    if (sql.startsWith('UPDATE sponsor_removal_alerts')) return {};
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.includes('FROM users')) return [{ id: 1, username: params[0], role: params[0], status: 'active', sponsor_id: 7, password_hash: hash }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM driver_sponsors')) return [{ id: 12, displayName: 'Driver Twelve', username: 'driver12', balance: 100 }];
    if (sql.includes('FROM point_alerts')) return [{ id: 42, points_change: alertAmount, reason: '<b>Driving adjustment</b>', sponsor_name: 'Demo', created_at: '2026-10-19T12:00:00Z' }];
    if (sql.startsWith('UPDATE point_alerts')) return { affectedRows: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
});

test.each([25, -30])('driver can toggle alerts for adjustment %i while removal alerts always appear', async amount => {
  alertAmount = amount;
  const driver = await login('driver');
  const page = await driver.get('/points/settings').expect(200);
  expect(page.text).toContain('Disable point-change alerts');
  await driver.post('/points/settings').send({ enabled: '0' }).expect(403);
  await driver.post('/points/settings').send({ token: token(page.text), enabled: 'invalid' }).expect(400);
  await driver.post('/points/settings').send({ token: token(page.text), enabled: '0', driverId: 99 }).expect(302);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO driver_alert_preferences'), [1, 0, 0]);
  const disabled = await driver.get('/points/alerts').expect(200);
  expect(disabled.text).not.toContain('Points added');
  expect(disabled.text).not.toContain('Points deducted');
  expect(disabled.text).toContain('You were removed from Former Sponsor');
  const anotherSession = await login('driver');
  expect((await anotherSession.get('/points/settings')).text).toContain('Enable point-change alerts');
  expect((await driver.get('/points/settings')).text).toContain('Enable point-change alerts');
  await driver.post('/points/settings').send({ token: token(page.text), enabled: '1' }).expect(302);
  expect((await driver.get('/points/alerts')).text).toContain(amount > 0 ? 'Points added: +25' : 'Points deducted: -30');
  await driver.post('/points/removal-alerts/9/acknowledge').send({}).expect(403);
  await driver.post('/points/removal-alerts/9/acknowledge').send({ token: token(page.text), driverId: 99 }).expect(302);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sponsor_removal_alerts'), ['9', 1]);
  const sponsor = await login('sponsor');
  await sponsor.get('/points/settings').expect(403);
  await sponsor.post('/points/settings').send({ enabled: '0' }).expect(403);
  await sponsor.post('/points/removal-alerts/9/acknowledge').send({}).expect(403);
});
afterEach(() => vi.restoreAllMocks());
const adjustment = { driverId: 12, sponsorId: 7, userId: 2, amount: 25, reason: 'Safe driving' };

test('sponsor removal requires confirmation and uses only the session sponsor', async () => {
  const driver = await login('driver');
  await driver.get('/points/drivers/12/remove').expect(403);
  await driver.post('/points/drivers/12/remove').send({ confirm: 'remove' }).expect(403);
  const sponsor = await login('sponsor');
  await sponsor.get('/points/drivers/99/remove').expect(404);
  const page = await sponsor.get('/points/drivers/12/remove').expect(200);
  expect(page.text).toContain('Confirm removal');
  expect(conn.execute).not.toHaveBeenCalled();
  await sponsor.post('/points/drivers/12/remove').send({ confirm: 'remove' }).expect(403);
  await sponsor.post('/points/drivers/12/remove').send({ token: token(page.text) }).expect(400);
  await sponsor.post('/points/drivers/12/remove').send({ token: token(page.text), confirm: 'remove', sponsorId: 99 }).expect(302);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM driver_sponsors'), [12, 7]);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sponsor_removal_alerts'), [12, 'Demo']);
  conn.execute.mockResolvedValueOnce([[]]);
  await sponsor.post('/points/drivers/99/remove').send({ token: token(page.text), confirm: 'remove' }).expect(404);
});
async function login(role) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: role, password: 'Password1!' }).expect(302);
  return agent;
}
function token(html) { return html.match(/name="token" value="([^"]+)"/)[1]; }

test.each([[25, 125], [-30, 70]])('adjustment %i updates balance and records history atomically', async (amount, balance) => {
  expect(await adjustPoints({ ...adjustment, amount })).toBe(balance);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [12, 7]);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO point_transactions'), [12, 7, 2, amount, 'Safe driving']);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE driver_sponsors'), [balance, 12, 7]);
  expect(conn.execute).toHaveBeenCalledWith('INSERT INTO point_alerts (transaction_id) VALUES (?)', [42]);
  expect(conn.commit).toHaveBeenCalledOnce();
});
test('another sponsor cannot adjust the driver', async () => {
  conn.execute.mockResolvedValueOnce([[]]);
  await expect(adjustPoints(adjustment)).rejects.toMatchObject({ status: 404 });
  expect(conn.execute).toHaveBeenCalledTimes(1);
  expect(conn.rollback).toHaveBeenCalledOnce();
});
test.each([25, -30])('an alert failure for adjustment %i rolls back the history and balance', async amount => {
  conn.execute.mockImplementation(async sql => {
    if (sql.includes('INSERT INTO point_alerts')) throw new Error('write failed');
    return sql.startsWith('SELECT') ? [[{ point_balance: 100 }]] : [{ insertId: 42 }];
  });
  await expect(adjustPoints({ ...adjustment, amount })).rejects.toThrow('write failed');
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.rollback).toHaveBeenCalledOnce();
  expect(conn.release).toHaveBeenCalledOnce();
});
test.each([0, 1.5, NaN, 2147483648])('invalid amount %s does not start a transaction', async amount => {
  await expect(adjustPoints({ ...adjustment, amount })).rejects.toMatchObject({ status: 400 });
  expect(db.pool.getConnection).not.toHaveBeenCalled();
});
test('sponsor form enforces role, CSRF, and session organization', async () => {
  await request(app).get('/points').expect(302);
  const driver = await login('driver');
  await driver.get('/points').expect(403);
  const sponsor = await login('sponsor');
  const page = await sponsor.get('/points').expect(200);
  expect(page.text).toContain('Driver Twelve');
  await sponsor.post('/points').send({ driverId: 12, amount: 25, reason: 'Reward' }).expect(403);
  await sponsor.post('/points').send({ token: token(page.text), driverId: 12, sponsorId: 99, amount: -30, reason: 'Penalty' }).expect(302);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO point_transactions'), [12, 7, 1, -30, 'Penalty']);
  const result = await sponsor.get('/points').expect(200);
  expect(result.text).toContain('Current balance: 70 points');
});
test.each([[25, 'Points added: +25'], [-30, 'Points deducted: -30']])('driver alert %i identifies the change and dismissal is scoped to its owner', async (amount, label) => {
  alertAmount = amount;
  const sponsor = await login('sponsor');
  await sponsor.get('/points/alerts').expect(403);
  const driver = await login('driver');
  const page = await driver.get('/points/alerts').expect(200);
  expect(page.text).toContain(label);
  expect(page.text).toContain('Demo');
  expect(page.text).toContain('&lt;b&gt;Driving adjustment&lt;/b&gt;');
  expect(page.text).toContain('/driver/points/history#change-42');
  expect(page.text).toContain('2026-10-19 12:00:00');
  expect(page.text).toContain('change #42');
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('a.dismissed_at IS NULL'), [1]);
  await driver.post('/points/alerts/42/dismiss').send({}).expect(403);
  await driver.post('/points/alerts/42/dismiss').send({ token: token(page.text), driverId: 99 }).expect(302);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('AND t.driver_id = ?'), ['42', 1]);
});
