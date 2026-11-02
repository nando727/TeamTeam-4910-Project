// Stories AD-11 and INF-33: the admin-only monthly sponsor fee report (1% of
// purchases), calculated by the sponsor_monthly_fees procedure. The fake below
// stands in for the procedure; a real database is what proves its arithmetic.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
  driver1: { id: 1, role: 'driver', status: 'active', sponsor_id: null },
};
// Fake purchases: cents and ISO day.
const purchases = [
  { sponsorId: 1, cents: 2499, day: '2026-10-04' },
  { sponsorId: 1, cents: 5900, day: '2026-10-01' },
  { sponsorId: 1, cents: 1850, day: '2026-09-27' },
  { sponsorId: 2, cents: 100049, day: '2026-09-15' },
];
const sponsors = [
  { id: 1, name: 'Demo Sponsor', status: 'active' },
  { id: 2, name: 'Other Freight', status: 'inactive' },
  { id: 3, name: 'Quiet Logistics', status: 'active' },
];
let passwordHash;
let monthQueries;
let feeOverride;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  monthQueries = [];
  feeOverride = null;
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
    if (sql === 'CALL sponsor_monthly_fees(?, NULL)') {
      monthQueries.push(params);
      const month = params[0].slice(0, 7);
      const rows = sponsors.map(s => {
        const mine = purchases.filter(p => p.sponsorId === s.id && p.day.startsWith(month));
        const total = mine.reduce((a, p) => a + p.cents, 0);
        // DECIMAL columns arrive as strings.
        return { ...s, purchases: mine.length, totalCents: String(total), feeCents: feeOverride || String(Math.round(total / 100)) };
      });
      // A CALL answers with the rows and then a status packet.
      return [rows, { affectedRows: 0 }];
    }
    if (sql.startsWith("SELECT DISTINCT DATE_FORMAT(purchased_at, '%Y-%m')")) {
      return [...new Set(purchases.map(p => p.day.slice(0, 7)))].sort().reverse().map(month => ({ month }));
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}

describe('the procedure', () => {
  const procedure = text => text.match(/DROP PROCEDURE IF EXISTS sponsor_monthly_fees;[\s\S]*?ORDER BY s\.name, s\.id;/)[0];
  const migration = readFileSync(new URL('../db/migrations/018_sponsor_monthly_fees.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

  test('the migration and the schema file carry the same text', () => {
    expect(procedure(schema)).toBe(procedure(migration));
  });

  test('its rate matches the 1% the page states', async () => {
    expect(procedure(migration)).toContain('ROUND(COALESCE(SUM(p.amount_cents), 0) * 0.01) AS feeCents');
    const agent = await login('admin1');
    const page = await agent.get('/reports/fees?month=2026-10').expect(200);
    expect(page.text).toContain('Fee rate</dt><dd>1% of purchases</dd>');
    const csv = await agent.get('/reports/fees.csv?month=2026-10').expect(200);
    expect(csv.text).toContain('"Fee at 1% (USD)"');
  });
});

describe('access', () => {
  test('admins only', async () => {
    await request(app).get('/reports/fees').expect(302).expect('Location', '/login');
    const sponsor = await login('sponsor1');
    await sponsor.get('/reports/fees').expect(403);
    await sponsor.get('/reports/fees.csv').expect(403);
    const driver = await login('driver1');
    await driver.get('/reports/fees').expect(403);
    const admin = await login('admin1');
    await admin.get('/reports/fees').expect(200);
    expect((await admin.get('/')).text).toContain('href="/reports/fees"');
  });
});

describe('the fee report', () => {
  test('a chosen month lists every sponsor with purchases, total, and 1% fee rounded to the cent', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/fees?month=2026-10').expect(200);
    expect(page.text).toContain('Month</dt><dd>October 2026</dd>');
    expect(monthQueries.pop()).toEqual(['2026-10-01']);
    // Demo Sponsor: $24.99 + $59.00 = $83.99, fee $0.84.
    expect(page.text).toMatch(/Demo Sponsor[\s\S]*?<td class="num">2<\/td>\s*<td class="num">\$83\.99<\/td>\s*<td class="num cell-strong">\$0\.84<\/td>/);
    // Sponsors with no purchases that month still appear, owing nothing.
    expect(page.text).toMatch(/Quiet Logistics[\s\S]*?<td class="num">0<\/td>\s*<td class="num">\$0\.00<\/td>\s*<td class="num cell-strong">\$0\.00<\/td>/);
    expect(page.text).toContain('class="is-muted"');
    expect(page.text).toContain('2 purchases in October 2026, $83.99 total, $0.84 in fees');
    expect(page.text).toContain('type="month"');
    expect(page.text).toContain('href="/reports/fees?month=2026-09"');
  });

  test('September rounds a large total correctly and includes the inactive sponsor', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/fees?month=2026-09').expect(200);
    // Other Freight: $1,000.49 -> fee $10.00 (10.0049 rounds down).
    expect(page.text).toMatch(/Other Freight[\s\S]*?status-inactive[\s\S]*?<td class="num">\$1,000\.49<\/td>\s*<td class="num cell-strong">\$10\.00<\/td>/);
    // Demo Sponsor: $18.50 -> $0.19 (0.185 rounds up).
    expect(page.text).toMatch(/Demo Sponsor[\s\S]*?<td class="num">\$18\.50<\/td>\s*<td class="num cell-strong">\$0\.19<\/td>/);
    expect(page.text).toContain('2 purchases in September 2026, $1,018.99 total, $10.19 in fees');
  });

  test('no month means the current month, and a bad month is refused', async () => {
    const agent = await login('admin1');
    await agent.get('/reports/fees').expect(200);
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect(monthQueries.pop()[0]).toBe(`${thisMonth}-01`);
    const bad = await agent.get('/reports/fees?month=2026-13').expect(400);
    expect(bad.text).toContain('Choose a month as YYYY-MM.');
    await agent.get('/reports/fees.csv?month=nope').expect(400);
  });

  test('the fee shown is the one the procedure calculated, not worked out again here', async () => {
    feeOverride = '777';
    const agent = await login('admin1');
    const page = await agent.get('/reports/fees?month=2026-10').expect(200);
    expect(page.text).toMatch(/Demo Sponsor[\s\S]*?<td class="num">\$83\.99<\/td>\s*<td class="num cell-strong">\$7\.77<\/td>/);
    const csv = await agent.get('/reports/fees.csv?month=2026-10').expect(200);
    expect(csv.text).toContain('"2026-10","Demo Sponsor","active",2,83.99,7.77');
  });

  test('the CSV has one row per sponsor plus a total row, for the same month', async () => {
    const agent = await login('admin1');
    const res = await agent.get('/reports/fees.csv?month=2026-10').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sponsor-fees-2026-10.csv"');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('"Month","Sponsor","Sponsor status","Purchases","Purchase total (USD)","Fee at 1% (USD)"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"2026-10","Demo Sponsor","active",2,83.99,0.84');
    expect(lines[4]).toBe('"2026-10","All sponsors","",2,83.99,0.84');
  });
});
