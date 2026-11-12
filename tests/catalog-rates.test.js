import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
const require = createRequire(import.meta.url);
const { pointCost } = require('../src/catalog/pricing');
const catalog = require('../src/catalog/store');
const db = require('../src/db');
const provider = require('../src/products/provider');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
let hash;
beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  vi.spyOn(provider, 'searchProducts').mockResolvedValue([]);
  vi.spyOn(provider, 'listCategories').mockResolvedValue([]);
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0 }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) return [{ id: 1, username: params[0], role: params[0], status: 'active', sponsor_id: 7, password_hash: hash }];
    if (sql.startsWith('INSERT')) return { affectedRows: 1 };
    if (sql.includes('FROM catalog_items') || sql.includes('FROM sponsor_point_rates')) return [];
    throw new Error(sql);
  });
});
afterEach(() => vi.restoreAllMocks());

test.each([[10, 10, 100], ['24.99', 10, 250], ['24.99', 20, 500], ['0.01', 10, 1], [0, 10, 1]])('price %s at rate %i costs %i whole points', (price, rate, expected) => {
  expect(pointCost(price, rate)).toBe(expected);
});

test('driver catalog and cart use the same sponsor-specific rate rather than the stored manual cost', async () => {
  db.query.mockResolvedValue([{ id: 3, price_value: '10.01', points_cost: 9999, points_per_dollar: 20 }]);
  expect((await catalog.listCatalogForDriver(1))[0].points_cost).toBe(201);
  expect((await catalog.findDriverCatalogItems(1, 7, [3]))[0].points_cost).toBe(201);
  expect((await catalog.findCatalogItem(7, 3)).points_cost).toBe(201);
  expect(db.query.mock.calls.every(([sql]) => sql.includes('sponsor_point_rates'))).toBe(true);
});

test('rate setting defaults to 10 and only a sponsor can change its own rate with a form token', async () => {
  const sponsor = request.agent(app);
  await sponsor.post('/login').type('form').send({ username: 'sponsor', password: 'Password1!' }).expect(302);
  const page = await sponsor.get('/catalog').expect(200);
  expect(page.text).toContain('value="10"');
  const token = page.text.match(/name="token" value="([^"]+)"/)[1];
  await sponsor.post('/catalog/rate').send({ rate: 20 }).expect(403);
  await sponsor.post('/catalog/rate').send({ token, rate: 0 }).expect(400);
  await sponsor.post('/catalog/rate').send({ token, rate: 1.5 }).expect(400);
  await sponsor.post('/catalog/rate').send({ token, rate: 20, sponsorId: 99 }).expect(303);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sponsor_point_rates'), [7, 20, 20]);
  const driver = request.agent(app);
  await driver.post('/login').type('form').send({ username: 'driver', password: 'Password1!' }).expect(302);
  await driver.post('/catalog/rate').send({ token, rate: 20 }).expect(403);
});
