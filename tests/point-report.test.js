// Stories AD-18 to AD-22: the Driver Point Tracking report for sponsors and
// admins, with driver and date filters and a CSV download that uses them too.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const PASSWORD = 'Password1!';
const users = {
  admin1: { id: 3, role: 'admin', status: 'active', sponsor_id: null },
  sponsor1: { id: 2, role: 'sponsor', status: 'active', sponsor_id: 1 },
  sponsor2: { id: 6, role: 'sponsor', status: 'active', sponsor_id: 2 },
  sponsor9: { id: 9, role: 'sponsor', status: 'active', sponsor_id: null },
  driver1: { id: 1, role: 'driver', status: 'active', sponsor_id: null },
};
const sponsors = [
  { id: 1, name: 'Demo Sponsor', contactEmail: 'demo@example.com', status: 'active' },
  { id: 2, name: 'Other Freight', contactEmail: 'other@example.com', status: 'active' },
];
const drivers = [
  { id: 1, username: 'driver1', displayName: 'driver1', sponsorId: 1, sponsorName: 'Demo Sponsor', balance: 260 },
  { id: 5, username: 'driver2', displayName: 'Dana Driver', sponsorId: 1, sponsorName: 'Demo Sponsor', balance: 195 },
  { id: 7, username: 'driver3', displayName: 'Ollie Other', sponsorId: 2, sponsorName: 'Other Freight', balance: 40 },
];
const changes = [
  { id: 10, driverId: 1, sponsorId: 1, pointsChange: 30, reason: 'Completed defensive driving course', changedAt: new Date('2026-10-04T10:00:00Z'), changedBy: 'admin1' },
  { id: 9, driverId: 5, sponsorId: 1, pointsChange: 60, reason: 'Referred a new driver', changedAt: new Date('2026-10-03T09:30:00Z'), changedBy: 'sponsor1' },
  { id: 8, driverId: 1, sponsorId: 1, pointsChange: -40, reason: 'Late delivery, customer complaint', changedAt: new Date('2026-09-30T15:00:00Z'), changedBy: 'sponsor1' },
  { id: 7, driverId: 7, sponsorId: 2, pointsChange: 40, reason: '=HYPERLINK("http://evil.example")', changedAt: new Date('2026-09-29T08:00:00Z'), changedBy: null },
  { id: 6, driverId: 1, sponsorId: 1, pointsChange: 100, reason: 'Welcome bonus, "first" week', changedAt: new Date('2026-08-08T12:00:00Z'), changedBy: 'sponsor1' },
];
const driverRow = id => drivers.find(d => d.id === id);
const sponsorName = id => sponsors.find(s => s.id === id).name;
let passwordHash;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) return [{ failures: 0, latest_failure: null }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users[params[0]];
      return user ? [{ ...user, username: params[0], password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const [name, user] = Object.entries(users).find(([, u]) => u.id === params[0]) || [];
      return user ? [{ ...user, username: name, name: null, email: null }] : [];
    }
    if (sql.includes('FROM sponsors ORDER BY')) return sponsors;
    if (sql.startsWith('SELECT ds.driver_id AS id')) {
      return sql.includes('WHERE ds.sponsor_id = ?') ? drivers.filter(d => d.sponsorId === params[0]) : drivers;
    }
    if (sql.startsWith('SELECT t.id')) {
      // Apply the same conditions the SQL carries, in parameter order.
      let rows = changes;
      let i = 0;
      if (sql.includes('t.sponsor_id = ?')) { const v = params[i++]; rows = rows.filter(r => r.sponsorId === v); }
      if (sql.includes('t.driver_id = ?')) { const v = params[i++]; rows = rows.filter(r => r.driverId === v); }
      if (sql.includes('t.created_at >= ?')) { const v = params[i++]; rows = rows.filter(r => r.changedAt.toISOString().slice(0, 10) >= v); }
      if (sql.includes('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)')) { const v = params[i++]; rows = rows.filter(r => r.changedAt.toISOString().slice(0, 10) <= v); }
      expect(params).toHaveLength(i);
      return rows.map(r => ({
        id: r.id, driverId: r.driverId, driverName: driverRow(r.driverId).displayName, driverUsername: driverRow(r.driverId).username,
        pointsChange: r.pointsChange, reason: r.reason, changedAt: r.changedAt, sponsorName: sponsorName(r.sponsorId), changedBy: r.changedBy,
      }));
    }
    if (sql.includes('FROM sponsor_applications')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}
const changeQuery = () => db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT t.id')).pop();
const rowsOn = page => (page.text.match(/<tbody>[\s\S]*<\/tbody>/) || [''])[0].split('<tr>').length - 1;

describe('access', () => {
  test('logged-out visitors are sent to log in, drivers get 403', async () => {
    await request(app).get('/reports/points').expect(302).expect('Location', '/login');
    await request(app).get('/reports/points.csv').expect(302).expect('Location', '/login');
    const driver = await login('driver1');
    await driver.get('/reports/points').expect(403);
    await driver.get('/reports/points.csv').expect(403);
  });

  test('a sponsor login with no organization is told so instead of seeing everyone', async () => {
    const agent = await login('sponsor9');
    const res = await agent.get('/reports/points').expect(403);
    expect(res.text).toContain('not linked to a sponsor organization');
  });

  test('sponsors and admins find the report from the nav and home page', async () => {
    const sponsor = await login('sponsor1');
    expect((await sponsor.get('/')).text).toContain('href="/reports/points"');
    const admin = await login('admin1');
    expect((await admin.get('/')).text).toContain('href="/reports/points"');
    const driver = await login('driver1');
    expect((await driver.get('/')).text).not.toContain('href="/reports/points"');
  });
});

describe('AD-18 / AD-21: running the report', () => {
  test('a sponsor sees only their own drivers, with name, total, change, date, sponsor, actor, and reason', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points').expect(200);
    expect(page.text).toContain('for Demo Sponsor');
    expect(rowsOn(page)).toBe(4);
    expect(page.text).not.toContain('Ollie Other');
    expect(page.text).not.toContain('Other Freight');
    // Totals come from the membership balance the driver also sees.
    expect(page.text).toContain('Dana Driver');
    expect(page.text).toContain('195 pts');
    expect(page.text).toContain('260 pts');
    // A row: date, signed change, sponsor, who made it, reason.
    expect(page.text).toContain('2026-10-04 10:00');
    expect(page.text).toContain('delta--pos">+30<');
    expect(page.text).toContain('delta--neg">-40<');
    expect(page.text).toContain('Completed defensive driving course');
    expect(page.text).toContain('<td>admin1</td>');
    expect(page.text).toContain('<td>Demo Sponsor</td>');
    // The sponsor scope is applied in SQL from the session.
    const [sql, params] = changeQuery();
    expect(sql).toContain('t.sponsor_id = ?');
    expect(params).toEqual([1]);
    // No sponsor picker for a sponsor user.
    expect(page.text).not.toContain('name="sponsor"');
  });

  test('a sponsor cannot widen the scope through the query string', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points?sponsor=all').expect(200);
    expect(rowsOn(page)).toBe(4);
    expect(changeQuery()[1]).toEqual([1]);
    const other = await agent.get('/reports/points?sponsor=2').expect(200);
    expect(other.text).not.toContain('Ollie Other');
  });

  test('an admin sees every driver and can narrow to one sponsor', async () => {
    const agent = await login('admin1');
    const all = await agent.get('/reports/points').expect(200);
    expect(rowsOn(all)).toBe(5);
    expect(all.text).toContain('across all sponsors');
    expect(all.text).toContain('name="sponsor"');
    expect(all.text).toContain('Ollie Other');
    expect(changeQuery()[0]).not.toContain('t.sponsor_id = ?');

    const one = await agent.get('/reports/points?sponsor=2').expect(200);
    expect(rowsOn(one)).toBe(1);
    expect(one.text).toContain('for Other Freight');
    expect(one.text).not.toContain('Dana Driver');
    expect(changeQuery()[1]).toEqual([2]);
    // The driver dropdown is narrowed to that sponsor too.
    expect(one.text).toContain('Ollie Other (driver3)');
    expect(one.text).not.toContain('>Dana Driver (driver2)<');
  });

  test('a sponsor with no activity yet gets the empty message, not a blank table', async () => {
    const agent = await login('sponsor2');
    changes.length = 0; // will be restored below
    try {
      const page = await agent.get('/reports/points').expect(200);
      expect(page.text).toContain('No point activity for these filters.');
      expect(page.text).not.toContain('<tbody>');
      expect(page.text).toContain('0 point changes');
    } finally {
      changes.push(
        { id: 10, driverId: 1, sponsorId: 1, pointsChange: 30, reason: 'Completed defensive driving course', changedAt: new Date('2026-10-04T10:00:00Z'), changedBy: 'admin1' },
        { id: 9, driverId: 5, sponsorId: 1, pointsChange: 60, reason: 'Referred a new driver', changedAt: new Date('2026-10-03T09:30:00Z'), changedBy: 'sponsor1' },
        { id: 8, driverId: 1, sponsorId: 1, pointsChange: -40, reason: 'Late delivery, customer complaint', changedAt: new Date('2026-09-30T15:00:00Z'), changedBy: 'sponsor1' },
        { id: 7, driverId: 7, sponsorId: 2, pointsChange: 40, reason: '=HYPERLINK("http://evil.example")', changedAt: new Date('2026-09-29T08:00:00Z'), changedBy: null },
        { id: 6, driverId: 1, sponsorId: 1, pointsChange: 100, reason: 'Welcome bonus, "first" week', changedAt: new Date('2026-08-08T12:00:00Z'), changedBy: 'sponsor1' },
      );
    }
  });
});

describe('AD-19: driver filter', () => {
  test('one driver narrows the rows and the totals to that driver', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points?driver=5').expect(200);
    expect(rowsOn(page)).toBe(1);
    expect(page.text).toContain('Referred a new driver');
    expect(page.text).not.toContain('260 pts');
    expect(page.text).toContain('195 pts');
    expect(page.text).toContain('value="5" selected');
    expect(changeQuery()[1]).toEqual([1, 5]);
  });

  test('"all" and a blank value mean every driver', async () => {
    const agent = await login('sponsor1');
    expect(rowsOn(await agent.get('/reports/points?driver=all').expect(200))).toBe(4);
    expect(rowsOn(await agent.get('/reports/points?driver=').expect(200))).toBe(4);
  });

  test('a driver outside the sponsor\'s organization, or a bad id, is refused with a message', async () => {
    const agent = await login('sponsor1');
    const other = await agent.get('/reports/points?driver=7').expect(400);
    expect(other.text).toContain('Choose a driver from the list.');
    expect(other.text).not.toContain('Ollie Other');
    expect(changeQuery()).toBeUndefined();
    await agent.get('/reports/points?driver=abc').expect(400);
    await agent.get('/reports/points.csv?driver=7').expect(400);
  });
});

describe('AD-20: date range', () => {
  test('from and to are inclusive and go into the query', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points?from=2026-09-30&to=2026-10-03').expect(200);
    expect(rowsOn(page)).toBe(2);
    expect(page.text).toContain('Referred a new driver');
    expect(page.text).toContain('Late delivery');
    expect(page.text).not.toContain('Completed defensive');
    expect(page.text).toContain('from 2026-09-30 to 2026-10-03');
    const [sql, params] = changeQuery();
    expect(sql).toContain('t.created_at >= ?');
    expect(sql).toContain('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(params).toEqual([1, '2026-09-30', '2026-10-03']);
    expect(page.text).toContain('value="2026-09-30"');
    expect(page.text).toContain('value="2026-10-03"');
  });

  test('either end alone works, and a range with nothing in it shows the empty message with the dates', async () => {
    const agent = await login('sponsor1');
    expect(rowsOn(await agent.get('/reports/points?from=2026-10-01').expect(200))).toBe(2);
    expect(rowsOn(await agent.get('/reports/points?to=2026-08-31').expect(200))).toBe(1);
    const empty = await agent.get('/reports/points?from=2026-09-01&to=2026-09-15').expect(200);
    expect(empty.text).toContain('No point activity from 2026-09-01 to 2026-09-15 for these filters.');
  });

  test('bad or reversed dates are rejected with a clear message', async () => {
    const agent = await login('sponsor1');
    const bad = await agent.get('/reports/points?from=2026-13-40').expect(400);
    expect(bad.text).toContain('Enter the start date as YYYY-MM-DD.');
    const reversed = await agent.get('/reports/points?from=2026-10-03&to=2026-09-30').expect(400);
    expect(reversed.text).toContain('start date must be on or before the end date');
    expect(changeQuery()).toBeUndefined();
  });

  test('quick ranges link to explicit dates that keep the other filters, and the pickers are native date inputs', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points?driver=5').expect(200);
    expect(page.text).toContain('type="date"');
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    expect(page.text).toContain(`href="/reports/points?driver=5&amp;from=${week}&amp;to=${today}"`);
    expect(page.text).toContain('Last 30 days');
    expect(page.text).toContain('Last 90 days');
    expect(page.text).toContain('chip is-active" href="/reports/points?driver=5"');
  });
});

describe('AD-22: CSV download', () => {
  test('downloads as a CSV attachment with a header and one row per change', async () => {
    const agent = await login('sponsor1');
    const res = await agent.get('/reports/points.csv').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="point-report.csv"');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('"Driver","Username","Current total points","Date (UTC)","Point change","Sponsor","Made by","Reason"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"driver1","driver1",260,"2026-10-04 10:00",30,"Demo Sponsor","admin1","Completed defensive driving course"');
    expect(lines[3]).toContain(',-40,');
    // Quotes inside a value are doubled.
    expect(lines[4]).toContain('"Welcome bonus, ""first"" week"');
  });

  test('uses exactly the filters that are on screen', async () => {
    const agent = await login('sponsor1');
    const page = await agent.get('/reports/points?driver=5&from=2026-09-30&to=2026-10-03').expect(200);
    expect(page.text).toContain('href="/reports/points.csv?driver=5&amp;from=2026-09-30&amp;to=2026-10-03"');
    const res = await agent.get('/reports/points.csv?driver=5&from=2026-09-30&to=2026-10-03').expect(200);
    expect(res.headers['content-disposition']).toContain('point-report-from-2026-09-30-to-2026-10-03.csv');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Dana Driver"');
    expect(changeQuery()[1]).toEqual([1, 5, '2026-09-30', '2026-10-03']);
  });

  test('an admin CSV is scoped the same way as the admin page', async () => {
    const agent = await login('admin1');
    const all = await agent.get('/reports/points.csv').expect(200);
    expect(all.text.trim().split('\r\n')).toHaveLength(6);
    const one = await agent.get('/reports/points.csv?sponsor=2').expect(200);
    const lines = one.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    // A value that starts like a spreadsheet formula is neutralized, and a
    // change with no actor is labelled.
    expect(lines[1]).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    expect(lines[1]).toContain('"system"');
  });

  test('an empty result still returns a valid CSV with just the header', async () => {
    const agent = await login('sponsor1');
    const res = await agent.get('/reports/points.csv?from=2026-09-01&to=2026-09-15').expect(200);
    expect(res.text.replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(1);
  });
});
