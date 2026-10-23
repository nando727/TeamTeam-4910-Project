// Stories AD-25 to AD-29: the admin-only Sales by Sponsor report, summary and
// detailed versions, with sponsor and date filters, sorting, paging, and CSV.
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
  driver1: { id: 1, role: 'driver', status: 'active', sponsor_id: null },
};
const sponsors = [
  { id: 1, name: 'Demo Sponsor', contactEmail: 'demo@example.com', status: 'active' },
  { id: 2, name: 'Northstar Freight', contactEmail: 'north@example.com', status: 'active' },
  { id: 3, name: 'Quiet Logistics', contactEmail: 'quiet@example.com', status: 'inactive' },
];
const drivers = { 1: ['driver1', 'driver1'], 5: ['driver2', 'Dana Driver'], 7: ['driver3', 'Theo Trucker'] };
const purchases = [
  { id: 21, sponsorId: 2, driverId: 7, item: 'Rain-X wiper blades', cents: 3200, points: 320, day: '2026-10-22' },
  { id: 12, sponsorId: 1, driverId: 1, item: 'Tire pressure gauge', cents: 1299, points: 130, day: '2026-10-22' },
  { id: 22, sponsorId: 2, driverId: 7, item: 'Noise-cancelling headset', cents: 12999, points: 1300, day: '2026-10-19' },
  { id: 1, sponsorId: 1, driverId: 1, item: 'Insulated travel mug', cents: 2499, points: 250, day: '2026-10-14' },
  { id: 2, sponsorId: 1, driverId: 5, item: 'Wireless "pro" earbuds', cents: 5900, points: 590, day: '2026-10-11' },
  { id: 23, sponsorId: 2, driverId: 7, item: '=HYPERLINK("http://evil.example")', cents: 2650, points: 265, day: '2026-09-28' },
  { id: 3, sponsorId: 1, driverId: 1, item: 'Dash camera', cents: 8999, points: 900, day: '2026-08-20' },
];
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

    // Shared emulation of the purchases filter: sponsor, then from, then to.
    const inRange = (list, i) => {
      let rows = list;
      if (sql.includes('p.purchased_at >= ?')) { const v = params[i++]; rows = rows.filter(p => p.day >= v); }
      if (sql.includes('p.purchased_at < DATE_ADD(?, INTERVAL 1 DAY)')) { const v = params[i++]; rows = rows.filter(p => p.day <= v); }
      return { rows, i };
    };
    const detailFiltered = () => {
      let rows = purchases; let i = 0;
      if (sql.includes('p.sponsor_id = ?')) { const v = params[i++]; rows = rows.filter(p => p.sponsorId === v); }
      ({ rows, i } = inRange(rows, i));
      expect(params).toHaveLength(i);
      return rows;
    };
    const sortRows = (rows, keyMap) => {
      const order = sql.match(/ORDER BY (\S+) (ASC|DESC),/);
      expect(order).not.toBeNull();
      const key = keyMap[order[1]];
      expect(key).toBeDefined();
      return [...rows].sort((a, b) => {
        const av = a[key] ?? ''; const bv = b[key] ?? '';
        const cmp = av instanceof Date ? av - bv : typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return (order[2] === 'ASC' ? cmp : -cmp) || b.id - a.id;
      });
    };
    const page = rows => {
      const paging = sql.match(/LIMIT (\d+) OFFSET (\d+)$/);
      if (paging) return rows.slice(Number(paging[2]), Number(paging[2]) + Number(paging[1]));
      expect(sql).not.toContain('LIMIT');
      return rows;
    };

    if (sql.startsWith('SELECT s.id, s.name, s.status, COUNT(p.id) AS sales')) {
      // Summary: dates live in the JOIN (params first), sponsor in the WHERE (param last).
      let { rows, i } = inRange(purchases, 0);
      let scope = sponsors;
      if (sql.includes('WHERE s.id = ?')) { const v = params[i++]; scope = scope.filter(s => s.id === v); }
      expect(params).toHaveLength(i);
      const built = scope.map(s => {
        const mine = rows.filter(p => p.sponsorId === s.id);
        const cents = mine.reduce((a, p) => a + p.cents, 0); const pts = mine.reduce((a, p) => a + p.points, 0);
        return { id: s.id, name: s.name, status: s.status, sales: mine.length, totalCents: String(cents), points: String(pts), _cents: cents, _points: pts };
      });
      return page(sortRows(built, { 's.name': 'name', 's.status': 'status', sales: 'sales', totalCents: '_cents', points: '_points' }));
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM sponsors')) {
      return [{ total: sql.includes('WHERE id = ?') ? sponsors.filter(s => s.id === params[0]).length : sponsors.length }];
    }
    if (sql.startsWith('SELECT p.id, p.purchased_at AS purchasedAt')) {
      const rows = detailFiltered().map(p => ({
        id: p.id, purchasedAt: new Date(`${p.day}T15:00:00Z`), sponsorName: sponsors.find(s => s.id === p.sponsorId).name,
        driverName: drivers[p.driverId][1], driverUsername: drivers[p.driverId][0], item: p.item, amountCents: p.cents, points: p.points,
      }));
      return page(sortRows(rows, { 'p.purchased_at': 'purchasedAt', 's.name': 'sponsorName', driverName: 'driverName', 'p.description': 'item', 'p.amount_cents': 'amountCents', 'p.points_spent': 'points' }));
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM purchases p')) return [{ total: detailFiltered().length }];
    if (sql.startsWith('SELECT COUNT(*) AS sales, COALESCE(SUM(p.amount_cents), 0) AS totalCents')) {
      const rows = detailFiltered();
      return [{ sales: rows.length, totalCents: String(rows.reduce((a, p) => a + p.cents, 0)), points: String(rows.reduce((a, p) => a + p.points, 0)) }];
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
const bodyRows = page => (page.text.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0].split('<tr').length - 1;
const lastQuery = prefix => db.query.mock.calls.filter(([sql]) => sql.startsWith(prefix)).pop();
const csvLines = res => res.text.replace(/^﻿/, '').trim().split('\r\n');

describe('AD-25: access and the report page', () => {
  test('admins only; sponsors and drivers get the denied-access page', async () => {
    await request(app).get('/reports/sales').expect(302).expect('Location', '/login');
    const sponsor = await login('sponsor1');
    const denied = await sponsor.get('/reports/sales').expect(403);
    expect(denied.text).toContain("You don't have access to this page");
    await sponsor.get('/reports/sales.csv').expect(403);
    const driver = await login('driver1');
    await driver.get('/reports/sales').expect(403);
    await driver.get('/reports/sales.csv').expect(403);
  });

  test('reachable from the admin Reports menu and home page', async () => {
    const agent = await login('admin1');
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('site-menu__item" href="/reports/sales">Sales by sponsor');
    expect(home.text).toContain('<a class="action" href="/reports/sales">');
    const sponsor = await login('sponsor1');
    expect((await sponsor.get('/')).text).not.toContain('/reports/sales');
  });

  test('the default view is the summary across all sponsors, all time, with the loading hooks', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales').expect(200);
    expect(page.text).toContain('Version</dt><dd>Summary, one row per sponsor</dd>');
    expect(page.text).toContain('Sponsor</dt><dd>All sponsors</dd>');
    expect(page.text).toContain('Dates</dt><dd>All time</dd>');
    expect(page.text).toContain('Results</dt><dd>3 sponsors, 7 sales</dd>');
    expect(page.text).toContain('id="report-status"');
    expect(page.text).toContain('<script src="/report.js" defer></script>');
    expect(page.text).toContain('type="date"');
  });
});

describe('AD-28 / AD-29: versions and their fields', () => {
  test('summary: one row per sponsor with sales, total dollars, points, and a grand total row', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?version=summary').expect(200);
    expect(bodyRows(page)).toBe(3);
    expect(page.text).toMatch(/Demo Sponsor<\/td>[\s\S]*?<td class="num">4<\/td>\s*<td class="num">\$186\.97<\/td>\s*<td class="num">1,870<\/td>/);
    expect(page.text).toMatch(/Northstar Freight<\/td>[\s\S]*?<td class="num">3<\/td>\s*<td class="num">\$188\.49<\/td>\s*<td class="num">1,885<\/td>/);
    expect(page.text).toMatch(/<tr class="is-muted">\s*<td class="cell-strong">Quiet Logistics/);
    expect(page.text).toMatch(/Grand total, all sponsors<\/th>\s*<td class="num">7<\/td>\s*<td class="num cell-strong">\$375\.46<\/td>\s*<td class="num">3,755<\/td>/);
    for (const label of ['Sponsor', 'Status', 'Sales', 'Total', 'Points spent']) expect(page.text).toContain(`${label}<span class="sort-arrow"`);
    expect(page.text).not.toContain('Item<span class="sort-arrow"');
    expect(page.text).not.toContain('Driver<span class="sort-arrow"');
    expect(page.text).toContain('Download CSV (summary)');
  });

  test('detailed: one row per purchase with date, sponsor, driver, item, amount, and points', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?version=detailed').expect(200);
    expect(bodyRows(page)).toBe(7);
    expect(page.text).toContain('Version</dt><dd>Detailed, one row per purchase</dd>');
    expect(page.text).toContain('Results</dt><dd>7 sales</dd>');
    const first = page.text.match(/<tbody>[\s\S]*?<\/tr>/)[0];
    expect(first).toContain('2026-10-22 15:00');
    expect(first).toContain('Northstar Freight');
    expect(first).toContain('Theo Trucker');
    expect(first).toContain('Rain-X wiper blades');
    expect(first).toContain('$32.00');
    expect(first).toContain('<td class="num">320</td>');
    for (const label of ['Date (UTC)', 'Sponsor', 'Driver', 'Item', 'Amount', 'Points spent']) expect(page.text).toContain(`${label}<span class="sort-arrow"`);
    expect(page.text).not.toContain('Status<span class="sort-arrow"');
    expect(page.text).toContain('Total for these filters, 7 sales</th>');
    expect(page.text).toContain('Download CSV (all 7 sales)');
    expect(page.text).toContain('Wireless &#34;pro&#34; earbuds');
  });

  test('the version switch keeps the sponsor and dates, and an unknown version falls back to summary', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?sponsor=1&from=2026-10-01&to=2026-10-31&version=summary').expect(200);
    expect(page.text).toContain('href="/reports/sales?sponsor=1&amp;from=2026-10-01&amp;to=2026-10-31&amp;version=detailed"');
    expect(page.text).toContain('<span class="is-active" aria-current="true">Summary</span>');
    const other = await agent.get('/reports/sales?version=spreadsheet').expect(200);
    expect(other.text).toContain('Version</dt><dd>Summary, one row per sponsor</dd>');
  });
});

describe('AD-26: sponsor filter', () => {
  test('one sponsor narrows both versions and the grand total', async () => {
    const agent = await login('admin1');
    const summary = await agent.get('/reports/sales?sponsor=2').expect(200);
    expect(bodyRows(summary)).toBe(1);
    expect(summary.text).toContain('Sponsor</dt><dd>Northstar Freight</dd>');
    expect(summary.text).toContain('Results</dt><dd>1 sponsor, 3 sales</dd>');
    expect(summary.text).toMatch(/Grand total<\/th>\s*<td class="num">3<\/td>\s*<td class="num cell-strong">\$188\.49<\/td>/);
    expect(summary.text).not.toContain('Demo Sponsor</td>');
    expect(lastQuery('SELECT s.id, s.name, s.status')[1]).toEqual([2]);
    const detail = await agent.get('/reports/sales?sponsor=2&version=detailed').expect(200);
    expect(bodyRows(detail)).toBe(3);
    expect(lastQuery('SELECT p.id')[1]).toEqual([2]);
    expect(detail.text).toContain('value="2" selected');
  });

  test('"all", blank, and an unknown sponsor id', async () => {
    const agent = await login('admin1');
    expect(bodyRows(await agent.get('/reports/sales?sponsor=all').expect(200))).toBe(3);
    expect(bodyRows(await agent.get('/reports/sales?sponsor=').expect(200))).toBe(3);
    const bad = await agent.get('/reports/sales?sponsor=99').expect(400);
    expect(bad.text).toContain('Choose a sponsor from the list.');
    await agent.get('/reports/sales.csv?sponsor=abc').expect(400);
  });
});

describe('AD-27: date range', () => {
  test('inclusive dates apply to both versions, and the summary keeps zero-sale sponsors', async () => {
    const agent = await login('admin1');
    const detail = await agent.get('/reports/sales?version=detailed&from=2026-10-11&to=2026-10-19').expect(200);
    expect(bodyRows(detail)).toBe(3);
    expect(lastQuery('SELECT p.id')[1]).toEqual(['2026-10-11', '2026-10-19']);
    expect(detail.text).toContain('Dates</dt><dd>2026-10-11 to 2026-10-19</dd>');
    expect(detail.text).toContain('from 2026-10-11 to 2026-10-19');
    const summary = await agent.get('/reports/sales?from=2026-10-11&to=2026-10-19').expect(200);
    expect(bodyRows(summary)).toBe(3);
    expect(lastQuery('SELECT s.id, s.name, s.status')[0]).toContain('LEFT JOIN purchases p ON p.sponsor_id = s.id AND p.purchased_at >= ? AND p.purchased_at < DATE_ADD(?, INTERVAL 1 DAY)');
    expect(summary.text).toMatch(/Demo Sponsor<\/td>[\s\S]*?<td class="num">2<\/td>\s*<td class="num">\$83\.99<\/td>/);
    expect(summary.text).toMatch(/Northstar Freight<\/td>[\s\S]*?<td class="num">1<\/td>\s*<td class="num">\$129\.99<\/td>/);
  });

  test('quick ranges and bad dates', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?sponsor=1&version=detailed').expect(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(page.text).toContain(`href="/reports/sales?sponsor=1&amp;version=detailed&amp;from=${today.slice(0, 7)}-01&amp;to=${today}&amp;sort=date&amp;dir=desc"`);
    expect(page.text).toContain('>This month</a>');
    expect(page.text).toContain('Last 90 days');
    const bad = await agent.get('/reports/sales?from=2026-02-30').expect(400);
    expect(bad.text).toContain('Enter the start date as YYYY-MM-DD.');
    const reversed = await agent.get('/reports/sales?from=2026-10-20&to=2026-10-01').expect(400);
    expect(reversed.text).toContain('start date must be on or before the end date');
  });

  test('a range with no purchases shows the empty message in both versions', async () => {
    const agent = await login('admin1');
    const summary = await agent.get('/reports/sales?from=2026-01-01&to=2026-01-31').expect(200);
    expect(summary.text).toContain('No sales from 2026-01-01 to 2026-01-31 for these filters.');
    expect(summary.text).toContain('The report ran successfully and found no purchases');
    expect(summary.text).not.toContain('<tbody>');
    const detail = await agent.get('/reports/sales?version=detailed&from=2026-01-01&to=2026-01-31').expect(200);
    expect(detail.text).toContain('No sales from 2026-01-01 to 2026-01-31 for these filters.');
    expect(detail.text).not.toContain('<tbody>');
  });
});

describe('sorting and paging', () => {
  test('summary sorts by total dollars descending and flips on the active header', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?sort=dollars&dir=desc').expect(200);
    expect(lastQuery('SELECT s.id, s.name, s.status')[0]).toContain('ORDER BY totalCents DESC, s.name ASC, s.id ASC');
    expect(page.text.match(/<tbody>[\s\S]*?<\/tr>/)[0]).toContain('Northstar Freight');
    expect(page.text).toContain('href="/reports/sales?version=summary&amp;sort=dollars&amp;dir=asc"');
    expect(page.text).toContain('Sorted by</dt><dd>total dollars, descending</dd>');
  });

  test('detailed sorts by amount, item, and driver through the allowlist only', async () => {
    const agent = await login('admin1');
    const byAmount = await agent.get('/reports/sales?version=detailed&sort=amount&dir=asc').expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.amount_cents ASC, p.id DESC');
    expect(byAmount.text.match(/<tbody>[\s\S]*?<\/tr>/)[0]).toContain('$12.99');
    await agent.get('/reports/sales?version=detailed&sort=item&dir=desc').expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.description DESC');
    await agent.get('/reports/sales?version=detailed&sort=driver').expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY driverName ASC');
    await agent.get('/reports/sales?version=detailed&sort=1;DROP&dir=up').expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.purchased_at DESC');
    await agent.get('/reports/sales?version=detailed&sort=status').expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.purchased_at DESC');
  });

  test('the detailed version pages at 25 while the totals cover every row', async () => {
    const saved = purchases.splice(0, purchases.length);
    for (let i = 0; i < 31; i++) {
      purchases.push({ id: 500 + i, sponsorId: 1 + (i % 2), driverId: i % 2 ? 7 : 1, item: `Item ${String(i).padStart(2, '0')}`, cents: 1000 + i, points: 10 + i, day: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}` });
    }
    try {
      const agent = await login('admin1');
      const first = await agent.get('/reports/sales?version=detailed&sort=item&dir=asc').expect(200);
      expect(bodyRows(first)).toBe(25);
      expect(first.text).toContain('Showing 1 to 25 of 31 sales');
      expect(first.text).toContain('Total for these filters, 31 sales</th>');
      expect(first.text).toContain('Download CSV (all 31 sales)');
      expect(lastQuery('SELECT p.id')[0]).toMatch(/LIMIT 25 OFFSET 0$/);
      const second = await agent.get('/reports/sales?version=detailed&sort=item&dir=asc&page=2').expect(200);
      expect(bodyRows(second)).toBe(6);
      expect(second.text).toContain('Showing 26 to 31 of 31');
      expect(second.text).toContain('Page 2 of 2');
      const far = await agent.get('/reports/sales?version=detailed&page=50').expect(200);
      expect(far.text).toContain('Page 2 of 2');
      const csv = await agent.get('/reports/sales.csv?version=detailed&sort=item&dir=asc').expect(200);
      expect(csvLines(csv)).toHaveLength(33);
      expect(lastQuery('SELECT p.id')[0]).not.toContain('LIMIT');
    } finally {
      purchases.splice(0, purchases.length, ...saved);
    }
  });
});

describe('CSV download', () => {
  test('summary CSV: one row per sponsor plus the grand total, with the on-screen filters and sort', async () => {
    const agent = await login('admin1');
    const page = await agent.get('/reports/sales?from=2026-10-01&to=2026-10-31&sort=dollars&dir=desc').expect(200);
    expect(page.text).toContain('href="/reports/sales.csv?version=summary&amp;from=2026-10-01&amp;to=2026-10-31&amp;sort=dollars&amp;dir=desc"');
    const res = await agent.get('/reports/sales.csv?version=summary&from=2026-10-01&to=2026-10-31&sort=dollars&dir=desc').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sales-by-sponsor-summary-from-2026-10-01-to-2026-10-31.csv"');
    const lines = csvLines(res);
    expect(lines[0]).toBe('"Sponsor","Sponsor status","Number of sales","Total (USD)","Points spent"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"Northstar Freight","active",2,161.99,1620');
    expect(lines[2]).toBe('"Demo Sponsor","active",3,96.98,970');
    expect(lines[3]).toBe('"Quiet Logistics","inactive",0,0,0');
    expect(lines[4]).toBe('"All sponsors","",5,258.97,2590');
  });

  test('detailed CSV: one row per purchase, escaped, with a total row', async () => {
    const agent = await login('admin1');
    const res = await agent.get('/reports/sales.csv?version=detailed&sponsor=2').expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sales-by-sponsor-detailed.csv"');
    const lines = csvLines(res);
    expect(lines[0]).toBe('"Date (UTC)","Sponsor","Driver","Username","Item","Amount (USD)","Points spent"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"2026-10-22 15:00","Northstar Freight","Theo Trucker","driver3","Rain-X wiper blades",32,320');
    expect(lines[3]).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    expect(lines[4]).toBe('"Total","","","","3 sales",188.49,1885');
  });

  test('an empty range still returns a valid CSV with only the header and total', async () => {
    const agent = await login('admin1');
    const res = await agent.get('/reports/sales.csv?version=detailed&from=2026-01-01&to=2026-01-31').expect(200);
    expect(csvLines(res)).toHaveLength(2);
  });
});
