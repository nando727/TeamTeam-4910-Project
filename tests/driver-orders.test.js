// Sprint 9: a driver's order history, newest first, with sponsor and date
// filters, paging, and a CSV, read from the same purchases query as the
// Sales by Driver report but pinned to the signed-in driver.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let hash;
let purchases;
let queries;
beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  queries = [];
  purchases = [
    { id: 2, purchasedAt: new Date('2026-11-02T10:00:00Z'), sponsorName: 'Northstar Freight', driverName: 'Theo', driverUsername: 'driver21', item: 'Headset', amountCents: 12999, points: 400 },
    { id: 1, purchasedAt: new Date('2026-10-20T09:00:00Z'), sponsorName: 'Southstar Haulage', driverName: 'Theo', driverUsername: 'driver21', item: 'Gloves', amountCents: 500, points: 10 },
  ];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const role = { driver21: 'driver', admin1: 'admin' }[params[0]];
      return role ? [{ id: role === 'driver' ? 21 : 3, username: params[0], role, status: 'active', sponsor_id: null, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return [{ id: 3, username: 'admin1', role: 'admin', status: 'active' }];
    if (sql.startsWith('SELECT s.id, s.name FROM sponsors s')) return [{ id: 7, name: 'Northstar Freight' }, { id: 8, name: 'Southstar Haulage' }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM purchases')) return [{ total: purchases.length }];
    if (sql.startsWith('SELECT COUNT(*) AS sales')) return [{ sales: purchases.length, totalCents: 13499, points: 410 }];
    if (sql.startsWith('SELECT p.id, p.purchased_at AS purchasedAt')) return purchases;
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function login(username = 'driver21') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

describe('My orders', () => {
  test('is for drivers only', async () => {
    await request(app).get('/driver/orders').expect(302);
    const admin = await login('admin1');
    await admin.get('/driver/orders').expect(403);
    await admin.get('/driver/orders.csv').expect(403);
  });

  test('lists what the driver bought, newest first, pinned to the signed-in driver', async () => {
    const agent = await login();
    const page = await agent.get('/driver/orders').expect(200);
    expect(page.text).toContain('<h1>My orders</h1>');
    expect(page.text.indexOf('Headset')).toBeLessThan(page.text.indexOf('Gloves'));
    expect(page.text).toContain('2026-11-02 10:00');
    expect(page.text).toContain('Northstar Freight');
    expect(page.text).toContain('$129.99');
    expect(page.text).toContain('>400<');
    expect(page.text).toContain('Showing 1 to 2 of 2 items');
    // Filtered by the session's driver id, not anything from the request.
    const [sql, params] = queries.find(([q]) => q.startsWith('SELECT p.id, p.purchased_at'));
    expect(sql).toContain('p.driver_id = ?');
    expect(params).toEqual([21]);
    expect(sql).toContain('ORDER BY p.purchased_at DESC');
    // The report chrome: filters, quick ranges, summary, CSV link.
    expect(page.text).toContain('class="filters"');
    expect(page.text).toContain('<option value="7"');
    expect(page.text).toContain('Last 30 days');
    expect(page.text).toContain('report-summary__item');
    expect(page.text).toContain('href="/driver/orders.csv?sort=date&amp;dir=desc"');
  });

  test('a driver id in the query string changes nothing', async () => {
    const agent = await login();
    await agent.get('/driver/orders?driver=99').expect(200);
    const [, params] = queries.find(([q]) => q.startsWith('SELECT p.id, p.purchased_at'));
    expect(params).toEqual([21]);
  });

  test('filters by sponsor and date, keeps them in the links, and refuses bad values', async () => {
    const agent = await login();
    const page = await agent.get('/driver/orders?sponsor=7&from=2026-10-01&to=2026-11-30').expect(200);
    const [sql, params] = queries.find(([q]) => q.startsWith('SELECT p.id, p.purchased_at'));
    expect(sql).toContain('p.sponsor_id = ?');
    expect(params).toEqual([7, 21, '2026-10-01', '2026-11-30']);
    expect(page.text).toContain('<option value="7" selected>');
    expect(page.text).toContain('href="/driver/orders.csv?sponsor=7&amp;from=2026-10-01&amp;to=2026-11-30');
    const bad = await agent.get('/driver/orders?sponsor=99&from=nope').expect(400);
    expect(bad.text).toContain('Choose a sponsor from the list.');
    expect(bad.text).toContain('Enter the start date as YYYY-MM-DD.');
  });

  test('says plainly when nothing matches', async () => {
    purchases = [];
    const agent = await login();
    const page = await agent.get('/driver/orders?sponsor=8').expect(200);
    expect(page.text).toContain('No orders with Southstar Haulage.');
    expect(page.text).toContain('browse the catalog');
  });

  test('the CSV has the same rows and a total line', async () => {
    const agent = await login();
    const res = await agent.get('/driver/orders.csv?sponsor=7').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('my-orders.csv');
    expect(res.text).toContain('"Date (UTC)","Sponsor","Item","Amount (USD)","Points spent"');
    expect(res.text).toContain('"2026-11-02 10:00","Northstar Freight","Headset",129.99,400');
    expect(res.text).toContain('"Total","","2 items",134.99,410');
  });
});
