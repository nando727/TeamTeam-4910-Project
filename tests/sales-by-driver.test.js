// Stories AD-32 to AD-34: the admin-only Sales by Driver report, summary and
// detailed versions, with sponsor, driver, and date filters, sorting, paging,
// charts, and CSV. A driver may have purchases with more than one sponsor.
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
const sponsors = [
  { id: 1, name: 'Demo Sponsor', contactEmail: 'demo@example.com', status: 'active' },
  { id: 2, name: 'Northstar Freight', contactEmail: 'north@example.com', status: 'active' },
  { id: 3, name: 'Quiet Logistics', contactEmail: 'quiet@example.com', status: 'active' },
];
let drivers = [
  { id: 1, username: 'driver1', name: 'driver1' },
  { id: 5, username: 'driver2', name: 'Dana Driver' },
  { id: 7, username: 'driver3', name: 'Theo Trucker' },
  { id: 9, username: 'driver4', name: 'Nia NoSales' },
];
// driver1 has two sponsors. Nia belongs to one but has bought nothing.
let memberships = [[1, 1], [1, 2], [5, 1], [7, 2], [9, 3]];
let purchases = [
  { id: 21, sponsorId: 2, driverId: 7, item: 'Rain-X wiper blades', cents: 3200, points: 320, day: '2026-10-22' },
  { id: 12, sponsorId: 1, driverId: 1, item: 'Tire pressure gauge', cents: 1299, points: 130, day: '2026-10-22' },
  { id: 30, sponsorId: 2, driverId: 1, item: 'Seat cushion', cents: 4000, points: 400, day: '2026-10-20' },
  { id: 22, sponsorId: 2, driverId: 7, item: 'Noise-cancelling headset', cents: 12999, points: 1300, day: '2026-10-19' },
  { id: 1, sponsorId: 1, driverId: 1, item: 'Insulated travel mug', cents: 2499, points: 250, day: '2026-10-14' },
  { id: 2, sponsorId: 1, driverId: 5, item: 'Wireless "pro" earbuds', cents: 5900, points: 590, day: '2026-10-11' },
  { id: 23, sponsorId: 2, driverId: 7, item: '=HYPERLINK("http://evil.example")', cents: 2650, points: 265, day: '2026-09-28' },
  { id: 3, sponsorId: 1, driverId: 1, item: 'Dash camera', cents: 8999, points: 900, day: '2026-08-20' },
];
const stamp = day => new Date(`${day}T15:00:00Z`);
const sponsorName = id => sponsors.find(s => s.id === id).name;
const driver = id => drivers.find(d => d.id === id);
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

    // The dropdown: each driver once, members of the scope or anyone who bought there.
    if (sql.startsWith('SELECT u.id, u.username, COALESCE')) {
      const scope = params[0] || null;
      expect(params).toHaveLength(scope ? 2 : 0);
      return drivers
        .filter(d => memberships.some(([id, s]) => id === d.id && (!scope || s === scope)) ||
          purchases.some(p => p.driverId === d.id && (!scope || p.sponsorId === scope)))
        .map(d => ({ id: d.id, username: d.username, displayName: d.name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    // Shared emulation of the purchases filter: sponsor, driver, from, to.
    const filtered = () => {
      let rows = purchases; let i = 0;
      if (sql.includes('p.sponsor_id = ?')) { const v = params[i++]; rows = rows.filter(p => p.sponsorId === v); }
      if (sql.includes('p.driver_id = ?')) { const v = params[i++]; rows = rows.filter(p => p.driverId === v); }
      if (sql.includes('p.purchased_at >= ?')) { const v = params[i++]; rows = rows.filter(p => p.day >= v); }
      if (sql.includes('p.purchased_at < DATE_ADD(?, INTERVAL 1 DAY)')) { const v = params[i++]; rows = rows.filter(p => p.day <= v); }
      expect(params).toHaveLength(i);
      return rows;
    };
    const sortRows = (rows, keyMap) => {
      const order = sql.match(/ORDER BY (\S+) (ASC|DESC),/);
      expect(order).not.toBeNull();
      const key = keyMap[order[1]];
      expect(key).toBeDefined();
      return [...rows].sort((a, b) => {
        const av = a[key]; const bv = b[key];
        const cmp = av instanceof Date || typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return (order[2] === 'ASC' ? cmp : -cmp) || b.id - a.id;
      });
    };
    const page = rows => {
      const paging = sql.match(/LIMIT (\d+) OFFSET (\d+)$/);
      if (paging) return rows.slice(Number(paging[2]), Number(paging[2]) + Number(paging[1]));
      expect(sql).not.toContain('LIMIT');
      return rows;
    };

    if (sql.startsWith('SELECT u.id, COALESCE')) {
      const groups = new Map();
      for (const p of filtered()) {
        const g = groups.get(p.driverId) || { id: p.driverId, driverName: driver(p.driverId).name, driverUsername: driver(p.driverId).username, sponsors: new Set(), sales: 0, _cents: 0, _points: 0, lastPurchase: stamp(p.day) };
        g.sponsors.add(sponsorName(p.sponsorId)); g.sales += 1; g._cents += p.cents; g._points += p.points;
        if (stamp(p.day) > g.lastPurchase) g.lastPurchase = stamp(p.day);
        groups.set(p.driverId, g);
      }
      const rows = [...groups.values()].map(g => ({
        ...g, sponsorNames: [...g.sponsors].sort().join(', '), totalCents: String(g._cents), points: String(g._points),
      }));
      return page(sortRows(rows, { driverName: 'driverName', sponsorNames: 'sponsorNames', sales: 'sales', totalCents: '_cents', points: '_points', lastPurchase: 'lastPurchase' }));
    }
    if (sql.startsWith('SELECT COUNT(DISTINCT p.driver_id) AS total')) return [{ total: new Set(filtered().map(p => p.driverId)).size }];
    if (sql.startsWith('SELECT p.id, p.purchased_at AS purchasedAt')) {
      const rows = filtered().map(p => ({
        id: p.id, purchasedAt: stamp(p.day), sponsorName: sponsorName(p.sponsorId), driverName: driver(p.driverId).name,
        driverUsername: driver(p.driverId).username, item: p.item, amountCents: p.cents, points: p.points,
      }));
      return page(sortRows(rows, { 'p.purchased_at': 'purchasedAt', 's.name': 'sponsorName', driverName: 'driverName', 'p.description': 'item', 'p.amount_cents': 'amountCents', 'p.points_spent': 'points' }));
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM purchases p')) return [{ total: filtered().length }];
    if (sql.startsWith('SELECT COUNT(*) AS sales, COALESCE(SUM(p.amount_cents), 0) AS totalCents')) {
      const rows = filtered();
      return [{ sales: rows.length, totalCents: String(rows.reduce((a, p) => a + p.cents, 0)), points: String(rows.reduce((a, p) => a + p.points, 0)) }];
    }
    if (sql.startsWith("SELECT DATE_FORMAT(p.purchased_at, '%Y-%m-%d') AS day")) {
      const days = new Map();
      for (const p of filtered()) {
        const d = days.get(p.day) || { day: p.day, sales: 0, cents: 0 };
        d.sales += 1; d.cents += p.cents; days.set(p.day, d);
      }
      return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ day: d.day, sales: d.sales, totalCents: String(d.cents) }));
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
const PAGE = '/reports/sales-by-driver';
const reportTable = page => page.text.slice(page.text.indexOf('table table--sortable'));
const bodyRows = page => (reportTable(page).match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0].split('<tr').length - 1;
const firstRow = page => reportTable(page).match(/<tbody>[\s\S]*?<\/tr>/)[0];
const lastQuery = prefix => db.query.mock.calls.filter(([sql]) => sql.startsWith(prefix)).pop();
const csvLines = res => res.text.replace(/^﻿/, '').trim().split('\r\n');
const chartLabels = page => [...page.text.matchAll(/class="chart__label"[^>]*>([^<]+)</g)].map(match => match[1]);
const options = (page, id) => [...page.text.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))[0].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);

// Swaps in other data for one test.
async function withData(next, run) {
  const saved = { drivers, memberships, purchases };
  ({ drivers = saved.drivers, memberships = saved.memberships, purchases = saved.purchases } = next);
  try { await run(); } finally { ({ drivers, memberships, purchases } = saved); }
}

describe('AD-32: access and the report page', () => {
  test('admins only; sponsors and drivers get the denied-access page', async () => {
    await request(app).get(PAGE).expect(302).expect('Location', '/login');
    const sponsor = await login('sponsor1');
    const denied = await sponsor.get(PAGE).expect(403);
    expect(denied.text).toContain("You don't have access to this page");
    await sponsor.get(`${PAGE}.csv`).expect(403);
    const driverUser = await login('driver1');
    await driverUser.get(PAGE).expect(403);
    await driverUser.get(`${PAGE}.csv`).expect(403);
  });

  test('reachable from the admin Reports menu and home page, and only this menu item lights up', async () => {
    const agent = await login('admin1');
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('<a class="site-menu__item" href="/reports/sales-by-driver">Sales by driver');
    expect(home.text).toContain('<a class="action" href="/reports/sales-by-driver">');
    const page = await agent.get(PAGE).expect(200);
    expect(page.text).toContain('<a class="site-menu__item is-active" href="/reports/sales-by-driver" aria-current="page">Sales by driver');
    expect(page.text).toContain('<a class="site-menu__item" href="/reports/sales">Sales by sponsor');
    const sponsor = await login('sponsor1');
    expect((await sponsor.get('/')).text).not.toContain('/reports/sales-by-driver');
  });

  test('the default view is the summary across everything, with the filter summary and loading hooks', async () => {
    const agent = await login('admin1');
    const page = await agent.get(PAGE).expect(200);
    for (const line of [
      'Sponsor</dt><dd>All sponsors</dd>', 'Driver</dt><dd>All drivers</dd>', 'Dates</dt><dd>All time</dd>',
      'Version</dt><dd>Summary, one row per driver</dd>', 'Sorted by</dt><dd>driver, ascending</dd>', 'Results</dt><dd>3 drivers, 8 sales</dd>',
    ]) expect(page.text).toContain(line);
    expect(page.text).toContain('id="report-status"');
    expect(page.text).toContain('<script src="/report.js" defer></script>');
    expect(page.text).toContain('type="date"');
    expect(page.text).toContain('Showing 1 to 3 of 3 drivers');
  });

  test('summary: one row per driver with purchases, with sponsors, totals, and a grand total', async () => {
    const agent = await login('admin1');
    const page = await agent.get(PAGE).expect(200);
    expect(bodyRows(page)).toBe(3);
    expect(reportTable(page)).toMatch(/Theo Trucker <span class="muted small">\(driver3\)<\/span><\/td>\s*<td>Northstar Freight<\/td>\s*<td class="num">3<\/td>\s*<td class="num">\$188\.49<\/td>\s*<td class="num">1,885<\/td>\s*<td class="nowrap">2026-10-22 15:00<\/td>/);
    expect(reportTable(page)).toMatch(/Grand total, all drivers<\/th>\s*<td class="num">8<\/td>\s*<td class="num cell-strong">\$415\.46<\/td>\s*<td class="num">4,155<\/td>/);
    // Nia is a member but has bought nothing: in the dropdown, not in the report.
    expect(options(page, 'driver')).toContain('9');
    expect(reportTable(page)).not.toContain('Nia NoSales');
    for (const label of ['Driver', 'Sponsors', 'Sales', 'Total', 'Points spent', 'Last purchase (UTC)']) expect(page.text).toContain(`${label}<span class="sort-arrow"`);
    expect(page.text).toContain('Download CSV (summary)');
  });

  test('detailed: one row per purchase with date, driver, sponsor, item, amount, and points', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?version=detailed`).expect(200);
    expect(bodyRows(page)).toBe(8);
    expect(page.text).toContain('Version</dt><dd>Detailed, one row per purchase</dd>');
    expect(page.text).toContain('Results</dt><dd>8 sales</dd>');
    const first = firstRow(page);
    for (const cell of ['2026-10-22 15:00', 'Theo Trucker', 'Northstar Freight', 'Rain-X wiper blades', '$32.00', '<td class="num">320</td>']) expect(first).toContain(cell);
    expect(page.text).toContain('Total for these filters, 8 sales</th>');
    expect(page.text).toContain('Download CSV (all 8 sales)');
    expect(page.text).toContain('Wireless &#34;pro&#34; earbuds');
  });

  test('the version switch keeps the sponsor, driver, and dates, and an unknown version falls back to summary', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=2&driver=1&from=2026-10-01&to=2026-10-31`).expect(200);
    expect(page.text).toContain(`href="${PAGE}?sponsor=2&amp;driver=1&amp;from=2026-10-01&amp;to=2026-10-31&amp;version=detailed"`);
    const other = await agent.get(`${PAGE}?version=spreadsheet`).expect(200);
    expect(other.text).toContain('Version</dt><dd>Summary, one row per driver</dd>');
  });
});

describe('a driver with several sponsors', () => {
  test('is one row, naming both sponsors, with each purchase counted once', async () => {
    const agent = await login('admin1');
    const page = await agent.get(PAGE).expect(200);
    expect(reportTable(page).match(/driver1<\/td>/g)).toHaveLength(1);
    expect(reportTable(page)).toMatch(/driver1<\/td>\s*<td>Demo Sponsor, Northstar Freight<\/td>\s*<td class="num">4<\/td>\s*<td class="num">\$167\.97<\/td>\s*<td class="num">1,680<\/td>/);
  });

  test('the totals never join memberships, the only query that reads them is the dropdown', async () => {
    const agent = await login('admin1');
    await agent.get(PAGE).expect(200);
    await agent.get(`${PAGE}?version=detailed`).expect(200);
    await agent.get(`${PAGE}.csv`).expect(200);
    const readers = db.query.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('driver_sponsors'));
    expect(readers.length).toBeGreaterThan(0);
    for (const sql of readers) expect(sql.startsWith('SELECT u.id, u.username, COALESCE')).toBe(true);
    // And the dropdown cannot repeat a driver: it asks with EXISTS, not a join.
    expect(readers[0]).toContain('EXISTS (SELECT 1 FROM driver_sponsors');
    expect(readers[0]).not.toContain('JOIN');
  });

  test('narrowing to one sponsor shows only the purchases made with that sponsor', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=2`).expect(200);
    expect(reportTable(page)).toMatch(/driver1<\/td>\s*<td>Northstar Freight<\/td>\s*<td class="num">1<\/td>\s*<td class="num">\$40\.00<\/td>/);
    expect(page.text).toContain('Results</dt><dd>2 drivers, 4 sales</dd>');
  });

  test('purchases stay on the report after a sponsorship is removed', async () => {
    await withData({ memberships: [[1, 1], [5, 1], [7, 2], [9, 3]] }, async () => {
      const agent = await login('admin1');
      const page = await agent.get(`${PAGE}?sponsor=2`).expect(200);
      expect(options(page, 'driver')).toContain('1');
      expect(reportTable(page)).toMatch(/driver1<\/td>\s*<td>Northstar Freight<\/td>/);
    });
  });
});

describe('AD-33: sponsor filter', () => {
  test('offers All Sponsors, and one sponsor narrows both versions, the total, and the driver dropdown', async () => {
    const agent = await login('admin1');
    const all = await agent.get(PAGE).expect(200);
    expect(all.text).toContain('<option value="all">All Sponsors</option>');
    expect(options(all, 'driver')).toEqual(['all', '5', '1', '9', '7']);

    const summary = await agent.get(`${PAGE}?sponsor=2`).expect(200);
    expect(bodyRows(summary)).toBe(2);
    expect(summary.text).toContain('Sponsor</dt><dd>Northstar Freight</dd>');
    expect(reportTable(summary)).toMatch(/Grand total, all drivers<\/th>\s*<td class="num">4<\/td>\s*<td class="num cell-strong">\$228\.49<\/td>/);
    expect(summary.text).toContain('value="2" selected');
    expect(options(summary, 'driver')).toEqual(['all', '1', '7']);
    expect(lastQuery('SELECT u.id, COALESCE')[1]).toEqual([2]);

    const detail = await agent.get(`${PAGE}?sponsor=2&version=detailed`).expect(200);
    expect(bodyRows(detail)).toBe(4);
    expect(lastQuery('SELECT p.id')[1]).toEqual([2]);
  });

  test('"all" and blank mean every sponsor; an unknown sponsor is refused', async () => {
    const agent = await login('admin1');
    expect(bodyRows(await agent.get(`${PAGE}?sponsor=all`).expect(200))).toBe(3);
    expect(bodyRows(await agent.get(`${PAGE}?sponsor=`).expect(200))).toBe(3);
    const bad = await agent.get(`${PAGE}?sponsor=99`).expect(400);
    expect(bad.text).toContain('Choose a sponsor from the list.');
    await agent.get(`${PAGE}.csv?sponsor=abc`).expect(400);
  });
});

describe('AD-34: driver filter', () => {
  test('offers All Drivers, and one driver narrows both versions and the total', async () => {
    const agent = await login('admin1');
    const all = await agent.get(PAGE).expect(200);
    expect(all.text).toContain('<option value="all">All Drivers</option>');
    expect(all.text).toContain('Dana Driver (driver2)</option>');

    const summary = await agent.get(`${PAGE}?driver=1`).expect(200);
    expect(bodyRows(summary)).toBe(1);
    expect(summary.text).toContain('Driver</dt><dd>driver1</dd>');
    expect(summary.text).toContain('<option value="1" selected>');
    expect(reportTable(summary)).toMatch(/Grand total<\/th>\s*<td class="num">4<\/td>\s*<td class="num cell-strong">\$167\.97<\/td>/);
    expect(lastQuery('SELECT u.id, COALESCE')[1]).toEqual([1]);

    const detail = await agent.get(`${PAGE}?driver=1&version=detailed`).expect(200);
    expect(bodyRows(detail)).toBe(4);
    expect(detail.text).toContain('Seat cushion');
    expect(detail.text).not.toContain('Rain-X');
  });

  test('sponsor and driver combine', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=1&driver=1&version=detailed`).expect(200);
    expect(bodyRows(page)).toBe(3);
    expect(lastQuery('SELECT p.id')[1]).toEqual([1, 1]);
    expect(page.text).toContain('Total for these filters, 3 sales</th>');
    expect(page.text).not.toContain('Seat cushion');
  });

  test('a driver left selected after changing the sponsor is dropped with an explanation', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=2&driver=5`).expect(200);
    expect(page.text).toContain('Dana Driver has no membership or purchases with Northstar Freight, so this shows all of Northstar Freight&#39;s drivers.');
    expect(page.text).toContain('Driver</dt><dd>All drivers</dd>');
    expect(bodyRows(page)).toBe(2);
    expect(page.text).not.toContain('driver=5');
    const csv = await agent.get(`${PAGE}.csv?sponsor=2&driver=5`).expect(200);
    expect(csvLines(csv)).toHaveLength(4);
  });

  test('"all" and blank mean every driver; an unknown or malformed driver is refused', async () => {
    const agent = await login('admin1');
    expect(bodyRows(await agent.get(`${PAGE}?driver=all`).expect(200))).toBe(3);
    expect(bodyRows(await agent.get(`${PAGE}?driver=`).expect(200))).toBe(3);
    for (const bad of ['99', 'abc', '1;DROP']) {
      const res = await agent.get(`${PAGE}?driver=${bad}`).expect(400);
      expect(res.text).toContain('Choose a driver from the list.');
    }
    await agent.get(`${PAGE}.csv?driver=99`).expect(400);
    await agent.get(`${PAGE}?sponsor=2&driver=99`).expect(400);
  });
});

test('the loading indicator stays out of sight until report.js shows it', () => {
  // A display rule on .report-status would otherwise beat the hidden attribute.
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  expect(css).toContain('.report-status[hidden] { display: none; }');
});

describe('date range', () => {
  test('inclusive dates apply to both versions and every total', async () => {
    const agent = await login('admin1');
    const detail = await agent.get(`${PAGE}?version=detailed&from=2026-10-11&to=2026-10-19`).expect(200);
    expect(bodyRows(detail)).toBe(3);
    expect(lastQuery('SELECT p.id')[1]).toEqual(['2026-10-11', '2026-10-19']);
    expect(detail.text).toContain('Dates</dt><dd>2026-10-11 to 2026-10-19</dd>');
    const summary = await agent.get(`${PAGE}?sponsor=1&driver=1&from=2026-10-01&to=2026-10-31`).expect(200);
    expect(lastQuery('SELECT u.id, COALESCE')[1]).toEqual([1, 1, '2026-10-01', '2026-10-31']);
    expect(reportTable(summary)).toMatch(/Grand total<\/th>\s*<td class="num">2<\/td>\s*<td class="num cell-strong">\$37\.98<\/td>/);
  });

  test('quick ranges keep the sponsor, driver, version, and sort; bad dates are refused', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=2&driver=7&version=detailed`).expect(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(page.text).toContain(`href="${PAGE}?sponsor=2&amp;driver=7&amp;version=detailed&amp;from=${today.slice(0, 7)}-01&amp;to=${today}&amp;sort=date&amp;dir=desc"`);
    expect(page.text).toContain('>This month</a>');
    expect(page.text).toContain('Last 90 days');
    const bad = await agent.get(`${PAGE}?from=2026-02-30`).expect(400);
    expect(bad.text).toContain('Enter the start date as YYYY-MM-DD.');
    const reversed = await agent.get(`${PAGE}?from=2026-10-20&to=2026-10-01`).expect(400);
    expect(reversed.text).toContain('start date must be on or before the end date');
  });

  test('no purchases shows the empty message in both versions, with no table or chart', async () => {
    const agent = await login('admin1');
    for (const url of [`${PAGE}?from=2026-01-01&to=2026-01-31`, `${PAGE}?version=detailed&from=2026-01-01&to=2026-01-31`, `${PAGE}?sponsor=3`, `${PAGE}?driver=9`]) {
      const page = await agent.get(url).expect(200);
      expect(page.text).toContain('for these filters.');
      expect(page.text).toContain('The report ran successfully and found no purchases');
      expect(page.text).not.toContain('<tbody>');
      expect(page.text).not.toContain('class="chart__svg');
    }
  });
});

describe('sorting and paging', () => {
  test('summary sorts through its own allowlist and flips on the active header', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sort=dollars&dir=desc`).expect(200);
    expect(lastQuery('SELECT u.id, COALESCE')[0]).toContain('ORDER BY totalCents DESC, driverName ASC, u.id ASC');
    expect(firstRow(page)).toContain('Theo Trucker');
    expect(page.text).toContain(`href="${PAGE}?version=summary&amp;sort=dollars&amp;dir=asc"`);
    expect(page.text).toContain('Sorted by</dt><dd>total dollars, descending</dd>');
    await agent.get(`${PAGE}?sort=sponsors`).expect(200);
    expect(lastQuery('SELECT u.id, COALESCE')[0]).toContain('ORDER BY sponsorNames ASC');
    await agent.get(`${PAGE}?sort=last`).expect(200);
    expect(lastQuery('SELECT u.id, COALESCE')[0]).toContain('ORDER BY lastPurchase DESC');
    await agent.get(`${PAGE}?sort=1;DROP&dir=up`).expect(200);
    expect(lastQuery('SELECT u.id, COALESCE')[0]).toContain('ORDER BY driverName ASC');
  });

  test('detailed sorts through its allowlist, and a summary-only column falls back to date', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?version=detailed&sort=amount&dir=asc`).expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.amount_cents ASC, p.id DESC');
    expect(firstRow(page)).toContain('$12.99');
    await agent.get(`${PAGE}?version=detailed&sort=last`).expect(200);
    expect(lastQuery('SELECT p.id')[0]).toContain('ORDER BY p.purchased_at DESC');
  });

  test('both versions page at 25 while the totals, charts, and CSV cover every row', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, username: `bulk${i}`, name: `Bulk Driver ${String(i).padStart(2, '0')}` }));
    const bought = many.map((d, i) => ({ id: 500 + i, sponsorId: 1, driverId: d.id, item: `Item ${i}`, cents: 1000 + i, points: 10 + i, day: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}` }));
    await withData({ drivers: many, memberships: [], purchases: bought }, async () => {
      const agent = await login('admin1');
      const first = await agent.get(PAGE).expect(200);
      expect(bodyRows(first)).toBe(25);
      expect(first.text).toContain('Showing 1 to 25 of 30 drivers');
      expect(first.text).toContain('Results</dt><dd>30 drivers, 30 sales</dd>');
      expect(reportTable(first)).toMatch(/Grand total, all drivers<\/th>\s*<td class="num">30<\/td>/);
      expect(lastQuery('SELECT u.id, COALESCE')[0]).toMatch(/LIMIT 25 OFFSET 0$/);

      // The chart names the top 10 and folds the other 20, so all 30 count.
      expect(first.text).toContain('<h2 class="section-title">Top 10 drivers by sales</h2>');
      expect(chartLabels(first)).toHaveLength(11);
      expect(chartLabels(first)[0]).toBe('Bulk Driver 29');
      expect(first.text).toContain('data-tip-value="$201.90" data-tip-label="All others (20 drivers), 20 sales');

      const second = await agent.get(`${PAGE}?page=2`).expect(200);
      expect(bodyRows(second)).toBe(5);
      expect(second.text).toContain('Showing 26 to 30 of 30');
      expect(second.text).toContain('Page 2 of 2');
      expect(second.text).toContain('Top 10 drivers by sales');
      const far = await agent.get(`${PAGE}?page=50`).expect(200);
      expect(far.text).toContain('Page 2 of 2');

      const detail = await agent.get(`${PAGE}?version=detailed&page=2`).expect(200);
      expect(bodyRows(detail)).toBe(5);

      const csv = await agent.get(`${PAGE}.csv`).expect(200);
      expect(csvLines(csv)).toHaveLength(32);
      expect(lastQuery('SELECT u.id, COALESCE')[0]).not.toContain('LIMIT');
    });
  });
});

describe('charts', () => {
  test('totals by driver run largest first, with a whole name and username in the tooltip', async () => {
    const agent = await login('admin1');
    for (const version of ['summary', 'detailed']) {
      const page = await agent.get(`${PAGE}?version=${version}`).expect(200);
      expect(page.text).toContain('<h2 class="section-title">Sales by driver</h2>');
      expect(chartLabels(page)).toEqual(['Theo Trucker', 'driver1', 'Dana Driver']);
      expect(page.text).toContain('data-tip-value="$188.49" data-tip-label="Theo Trucker (driver3), 3 sales, 1,885 points"');
      expect(page.text).toContain('data-tip-label="driver1, 4 sales, 1,680 points"');
      expect(page.text).toContain('<h2 class="section-title">Sales over time</h2>');
      expect(page.text).toContain('Total dollars per week. The highest is $169.99 in the week of Oct 15, 2026.');
    }
  });

  test('one driver is a figure instead of a one-bar chart, and sales over time narrows to them', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?driver=7`).expect(200);
    expect(chartLabels(page)).toEqual([]);
    expect(page.text).toContain('<span class="total__value">$188.49</span>');
    expect(page.text).toContain('3 sales, 1,885 points');
    expect(page.text).toContain('<h2 class="section-title">Sales over time</h2>');
  });

  test('names are escaped in the chart, its tooltip data, and the table', async () => {
    const evil = '<img src=x onerror=alert(1)>"';
    await withData({ drivers: drivers.map(d => (d.id === 7 ? { ...d, name: evil } : d)) }, async () => {
      const agent = await login('admin1');
      const page = await agent.get(PAGE).expect(200);
      expect(page.text).not.toContain('<img src=x');
      expect(page.text).toContain('&lt;img src=x onerror=alert(1)&gt;&#34;');
      expect(page.text).not.toContain('data-tip-label="<img');
    });
  });
});

describe('CSV download', () => {
  test('the button carries the on-screen filters, version, and sort', async () => {
    const agent = await login('admin1');
    const page = await agent.get(`${PAGE}?sponsor=2&driver=7&version=detailed&from=2026-10-01&to=2026-10-31&sort=amount&dir=desc`).expect(200);
    expect(page.text).toContain(`href="${PAGE}.csv?sponsor=2&amp;driver=7&amp;version=detailed&amp;from=2026-10-01&amp;to=2026-10-31&amp;sort=amount&amp;dir=desc"`);
  });

  test('summary: one row per driver plus the total, in the on-screen order', async () => {
    const agent = await login('admin1');
    const res = await agent.get(`${PAGE}.csv?version=summary&from=2026-08-01&to=2026-10-31`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sales-by-driver-summary-from-2026-08-01-to-2026-10-31.csv"');
    const lines = csvLines(res);
    expect(lines[0]).toBe('"Driver","Username","Sponsors","Number of sales","Total (USD)","Points spent","Last purchase (UTC)"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('"Dana Driver","driver2","Demo Sponsor",1,59,590,"2026-10-11 15:00"');
    expect(lines[2]).toBe('"driver1","driver1","Demo Sponsor, Northstar Freight",4,167.97,1680,"2026-10-22 15:00"');
    expect(lines[3]).toBe('"Theo Trucker","driver3","Northstar Freight",3,188.49,1885,"2026-10-22 15:00"');
    expect(lines[4]).toBe('"All drivers","","",8,415.46,4155,""');
  });

  test('detailed: one row per purchase, escaped, with a total row', async () => {
    const agent = await login('admin1');
    const res = await agent.get(`${PAGE}.csv?version=detailed&sponsor=2`).expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="sales-by-driver-detailed.csv"');
    const lines = csvLines(res);
    expect(lines[0]).toBe('"Date (UTC)","Driver","Username","Sponsor","Item","Amount (USD)","Points spent"');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('"2026-10-22 15:00","Theo Trucker","driver3","Northstar Freight","Rain-X wiper blades",32,320');
    expect(lines[4]).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    expect(lines[5]).toBe('"Total","","","","4 sales",228.49,2285');
  });

  test('an empty range still returns a valid CSV with only the header and total', async () => {
    const agent = await login('admin1');
    for (const version of ['summary', 'detailed']) {
      const res = await agent.get(`${PAGE}.csv?version=${version}&from=2026-01-01&to=2026-01-31`).expect(200);
      expect(csvLines(res)).toHaveLength(2);
    }
  });
});
