// Sprint 8: a sponsor buys a catalog item for one of their own drivers. The
// points are spent through adjustPoints, which writes the purchases row the
// sales, fee, and invoice reports read, in the same transaction.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const provider = require('../src/fakestore/client');
const { adjustPoints } = require('../src/points/store');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let hash;
let conn;
let lockedBalance;
let items;
let drivers;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  lockedBalance = 1200;
  // Sponsor 7 (Northstar Freight) owns items 31 and 32; item 99 belongs to another sponsor.
  items = [
    { id: 31, sponsor_id: 7, product_id: 3, title: 'Insulated "travel" mug', category: 'kitchen', image_url: 'https://fakestoreapi.com/img/mug.png', price_value: '24.99', points_cost: 250 },
    { id: 32, sponsor_id: 7, product_id: 4, title: 'Noise-cancelling headset', category: 'electronics', image_url: null, price_value: '129.99', points_cost: 1300 },
    { id: 99, sponsor_id: 8, product_id: 5, title: 'Someone else\'s item', category: '', image_url: null, price_value: '5.00', points_cost: 10 },
  ];
  drivers = [
    { id: 21, username: 'driver3', displayName: 'Theo Trucker', balance: 1200 },
    { id: 22, username: 'pat', displayName: 'pat', balance: 100 },
  ];
  conn = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async sql => {
      if (sql.includes('FOR UPDATE')) return [[{ point_balance: lockedBalance }]];
      if (sql.startsWith('INSERT INTO point_transactions')) return [{ insertId: 501 }];
      return [{ affectedRows: 1, insertId: 900 }];
    }),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  vi.spyOn(provider, 'searchProducts').mockResolvedValue([]);
  vi.spyOn(provider, 'listCategories').mockResolvedValue([]);
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const role = { sponsor7: 'sponsor', driver21: 'driver', admin1: 'admin' }[params[0]];
      return role ? [{ id: role === 'sponsor' ? 70 : role === 'driver' ? 21 : 3, username: params[0], role, status: 'active', sponsor_id: role === 'sponsor' ? 7 : null, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return [];
    if (sql.includes('FROM catalog_items WHERE id = ? AND sponsor_id = ?')) return items.filter(i => i.id === params[0] && i.sponsor_id === params[1]);
    if (sql.includes('FROM catalog_items WHERE sponsor_id = ? ORDER BY')) return items.filter(i => i.sponsor_id === params[0]);
    if (sql.startsWith('SELECT product_id FROM catalog_items')) return items.filter(i => i.sponsor_id === params[0]);
    if (sql.includes("u.role = 'driver' AND u.status = 'active'")) { expect(params).toEqual([7]); return drivers; }
    if (sql.startsWith('SELECT name FROM sponsors WHERE id')) return [{ name: 'Northstar Freight' }];
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username = 'sponsor7') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}
const hidden = (page, name) => (page.text.match(new RegExp(`name="${name}" value="([^"]+)"`)) || [])[1];
const purchaseInsert = () => conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO purchases'));

describe('adjustPoints with a purchase', () => {
  const purchase = { description: 'Mug', amountCents: 2499 };

  test('writes the point change, balance, alert, and purchases row in one transaction', async () => {
    const balance = await adjustPoints({ driverId: 21, sponsorId: 7, userId: 70, amount: -250, reason: 'Catalog purchase: Mug', purchase });
    expect(balance).toBe(950);
    const order = conn.execute.mock.calls.map(([sql]) => sql.split(' ').slice(0, 3).join(' '));
    expect(order).toEqual(['SELECT point_balance FROM', 'INSERT INTO point_transactions', 'UPDATE driver_sponsors SET', 'INSERT INTO point_alerts', 'INSERT INTO purchases']);
    expect(purchaseInsert()[1]).toEqual([21, 7, 'Mug', 2499, 250]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  test('refuses when the locked balance is short, writing nothing', async () => {
    lockedBalance = 100;
    const error = await adjustPoints({ driverId: 21, sponsorId: 7, userId: 70, amount: -250, reason: 'Catalog purchase: Mug', purchase }).catch(e => e);
    expect(error).toMatchObject({ status: 409, code: 'INSUFFICIENT_POINTS', balance: 100, cost: 250 });
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });

  test('exactly enough points is enough', async () => {
    lockedBalance = 250;
    await expect(adjustPoints({ driverId: 21, sponsorId: 7, userId: 70, amount: -250, reason: 'r', purchase })).resolves.toBe(0);
  });

  test.each([
    [{ amount: 250, purchase }],
    [{ amount: -250, purchase: { description: '', amountCents: 1 } }],
    [{ amount: -250, purchase: { description: 'x'.repeat(256), amountCents: 1 } }],
    [{ amount: -250, purchase: { description: 'Mug', amountCents: 1.5 } }],
  ])('rejects a malformed purchase %#', async extra => {
    const error = await adjustPoints({ driverId: 21, sponsorId: 7, userId: 70, reason: 'r', ...extra }).catch(e => e);
    expect(error.status).toBe(400);
    expect(db.pool.getConnection).not.toHaveBeenCalled();
  });

  test('ordinary adjustments are unchanged: a deduction may still go below zero and writes no purchase', async () => {
    lockedBalance = 10;
    await expect(adjustPoints({ driverId: 21, sponsorId: 7, userId: 70, amount: -30, reason: 'Late paperwork' })).resolves.toBe(-20);
    expect(purchaseInsert()).toBeUndefined();
  });
});

describe('the purchase pages', () => {
  test('sponsors only', async () => {
    await request(app).get('/catalog/31/buy').expect(302).expect('Location', '/login');
    const driver = await login('driver21');
    await driver.get('/catalog/31/buy').expect(403);
    const admin = await login('admin1');
    await admin.get('/catalog/31/buy').expect(403);
  });

  test('each item in the sponsor catalog has a clear purchase button', async () => {
    const agent = await login();
    const page = await agent.get('/catalog').expect(200);
    expect(page.text).toContain('<a class="button-link button--small" href="/catalog/31/buy">Buy for a driver</a>');
    expect(page.text).toContain('href="/catalog/32/buy"');
    expect(page.text).not.toContain('/catalog/99/buy');
  });

  test('lists only the sponsor\'s own active drivers, with their balance with this sponsor', async () => {
    const agent = await login();
    const page = await agent.get('/catalog/31/buy').expect(200);
    expect(page.text).toContain('Insulated &#34;travel&#34; mug');
    expect(page.text).toContain('<strong>250 points</strong>');
    expect(page.text).toContain('<option value="21" >Theo Trucker (driver3): 1,200 points</option>');
    expect(page.text).toContain('<option value="22" >pat: 100 points</option>');
    expect(page.text).not.toContain('Confirm purchase');
  });

  test('another sponsor\'s item, or a nonsense id, is refused', async () => {
    const agent = await login();
    await agent.get('/catalog/99/buy').expect(302).expect('Location', '/catalog');
    expect((await agent.get('/catalog')).text).toContain('That item is not in your catalog.');
    await agent.get('/catalog/abc/buy').expect(302);
  });

  test('a driver who is not one of theirs is refused', async () => {
    const agent = await login();
    const page = await agent.get('/catalog/31/buy?driver=55').expect(400);
    expect(page.text).toContain('Choose one of your drivers from the list.');
  });

  test('not enough points gives a clear message and no confirm button', async () => {
    const agent = await login();
    const page = await agent.get('/catalog/31/buy?driver=22').expect(409);
    expect(page.text).toContain('pat has 100 points with Northstar Freight. This item costs 250 points, so they need 150 more points.');
    expect(page.text).not.toContain('Confirm purchase');
  });

  test('review, confirm, and the purchase is written for the reports', async () => {
    const agent = await login();
    const review = await agent.get('/catalog/31/buy?driver=21').expect(200);
    expect(review.text).toContain('Buy "Insulated &#34;travel&#34; mug" for Theo Trucker?');
    expect(review.text).toMatch(/Balance with Northstar Freight<\/dt><dd>1,200 points<\/dd>\s*<dt>Balance after<\/dt><dd><strong>950 points<\/strong>/);
    expect(review.text).toContain('data-submit-once');
    const token = hidden(review, 'token');
    const confirmId = hidden(review, 'confirmId');
    await agent.post('/catalog/31/buy').type('form').send({ token, driver: '21', confirmId }).expect(303).expect('Location', '/catalog');

    const [txSql, txParams] = conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO point_transactions'));
    expect(txSql).toContain('changed_by_user_id');
    expect(txParams).toEqual([21, 7, 70, -250, 'Catalog purchase: Insulated "travel" mug']);
    expect(purchaseInsert()[1]).toEqual([21, 7, 'Insulated "travel" mug', 2499, 250]);
    expect(conn.commit).toHaveBeenCalledTimes(1);

    const catalogPage = await agent.get('/catalog').expect(200);
    expect(catalogPage.text).toContain('Bought &#34;Insulated &#34;travel&#34; mug&#34; for Theo Trucker for 250 points. Their balance with Northstar Freight is now 950 points.');
  });

  test('a second confirmation of the same review buys nothing', async () => {
    const agent = await login();
    const review = await agent.get('/catalog/31/buy?driver=21');
    const form = { token: hidden(review, 'token'), driver: '21', confirmId: hidden(review, 'confirmId') };
    await agent.post('/catalog/31/buy').type('form').send(form).expect(303);
    await agent.post('/catalog/31/buy').type('form').send(form).expect(303);
    expect(conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO purchases'))).toHaveLength(1);
    expect((await agent.get('/catalog')).text).toContain('That purchase was not confirmed, or it has already been made.');
  });

  test('a forged confirmation, or one for another driver or item, buys nothing', async () => {
    const agent = await login();
    const review = await agent.get('/catalog/31/buy?driver=21');
    const token = hidden(review, 'token');
    const confirmId = hidden(review, 'confirmId');
    await agent.post('/catalog/31/buy').type('form').send({ token, driver: '21', confirmId: 'x'.repeat(64) }).expect(303);
    await agent.get('/catalog/31/buy?driver=21');
    await agent.post('/catalog/31/buy').type('form').send({ token, driver: '22', confirmId }).expect(303);
    await agent.post('/catalog/32/buy').type('form').send({ token, driver: '21', confirmId }).expect(303);
    await agent.post('/catalog/31/buy').type('form').send({ driver: '21', confirmId }).expect(403);
    expect(purchaseInsert()).toBeUndefined();
  });

  test('if the points were spent elsewhere in the meantime, the confirmation says why', async () => {
    const agent = await login();
    const review = await agent.get('/catalog/31/buy?driver=21');
    lockedBalance = 40;
    const page = await agent.post('/catalog/31/buy').type('form').send({ token: hidden(review, 'token'), driver: '21', confirmId: hidden(review, 'confirmId') }).expect(409);
    expect(page.text).toContain('Theo Trucker has 40 points with Northstar Freight. This item costs 250 points, so they need 210 more points.');
    expect(purchaseInsert()).toBeUndefined();
  });

  test('an item removed after the review is not bought', async () => {
    const agent = await login();
    const review = await agent.get('/catalog/31/buy?driver=21');
    items = items.filter(i => i.id !== 31);
    await agent.post('/catalog/31/buy').type('form').send({ token: hidden(review, 'token'), driver: '21', confirmId: hidden(review, 'confirmId') }).expect(303);
    expect((await agent.get('/catalog')).text).toContain('That item is no longer in your catalog, so nothing was bought.');
    expect(conn.execute).not.toHaveBeenCalled();
  });

  test('a sponsor with no drivers is told so', async () => {
    drivers = [];
    const agent = await login();
    const page = await agent.get('/catalog/31/buy').expect(200);
    expect(page.text).toContain('You have no active drivers yet, so there is nobody to buy for.');
  });
});
