import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const provider = require('../src/fakestore/client');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
let hash;
let catalog;
let detail;

beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  catalog = [];
  detail = null;
  vi.spyOn(provider, 'listProducts').mockResolvedValue([{ productId: 3 }, { productId: 4 }]);
  vi.spyOn(provider, 'getProduct').mockResolvedValue({ productId: 3, description: 'High visibility jacket' });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users')) return [{ id: 1, username: params[0],
      role: ['sponsor', 'admin'].includes(params[0]) ? params[0] : 'driver', status: 'active',
      sponsor_id: 7, password_hash: hash }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM catalog_items')) return (detail || catalog).map(item => ({ price_value: '10.00', image_url: null, ...item, product_id: item.product_id || item.id }));
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function login(username = 'driver') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

test('catalog requires a driver login and appears in driver navigation', async () => {
  await request(app).get('/driver/catalog').expect(302);
  await request(app).get('/driver/catalog/7/3').expect(302);
  const sponsor = await login('sponsor');
  await sponsor.get('/driver/catalog').expect(403);
  await sponsor.get('/driver/catalog/7/3').expect(403);
  const admin = await login('admin');
  await admin.get('/driver/catalog').expect(403);
  await admin.get('/driver/catalog/7/3').expect(403);
  const driver = await login();
  const page = await driver.get('/driver/catalog').expect(200);
  expect(page.text).toContain('href="/driver/catalog"');
  expect(page.text).toContain('There are no available products');
});

test('catalog scopes selections to current memberships, including admin-added sponsors', async () => {
  catalog = [{ sponsorId: 7, sponsorName: 'Northstar', id: 3, name: 'Safety Jacket',
    description: 'High visibility jacket', price_value: '45.99', image_url: 'https://example.com/jacket.jpg' }];
  const driver = await login();
  const page = await driver.get('/driver/catalog').expect(200);
  expect(page.text).toContain('Northstar');
  expect(page.text).toContain('Safety Jacket');
  expect(page.text).toContain('$45.99');
  expect(page.text).toContain('src="https://example.com/jacket.jpg"');
  expect(page.text).toContain('alt="Safety Jacket"');
  expect(page.text).toContain('href="/driver/catalog/7/3"');
  const [sql, params] = db.query.mock.calls.find(([query]) => query.includes('FROM catalog_items'));
  expect(params).toEqual([1]);
  expect(sql).toContain('ds.driver_id = ?');
  expect(sql).not.toContain('sponsor_applications');
  expect(provider.listProducts).toHaveBeenCalledWith({ allowStale: false });
  expect(sql).toContain('JOIN driver_sponsors ds ON ds.sponsor_id = c.sponsor_id');
});

test('product detail shows its name and rejects products outside the current sponsor catalog', async () => {
  detail = [{ sponsorId: 7, sponsorName: 'Northstar', id: 3, name: 'Safety Jacket',
    description: 'High visibility jacket', price_value: '45.99', image_url: 'https://example.com/jacket.jpg' }];
  const driver = await login();
  const page = await driver.get('/driver/catalog/7/3').expect(200);
  expect(page.text).toContain('<h1>Safety Jacket</h1>');
  expect(page.text).toContain('High visibility jacket');
  expect(page.text).toContain('$45.99');
  expect(page.text).toContain('src="https://example.com/jacket.jpg"');
  const [sql, params] = db.query.mock.calls.find(([query]) => query.includes('FROM catalog_items'));
  expect(params).toEqual([1]);
  expect(sql).toContain('ds.driver_id = ?');
  expect(sql).not.toContain('sponsor_applications');
  expect(provider.getProduct).toHaveBeenCalledWith(3, { allowStale: false });
  detail = [];
  await driver.get('/driver/catalog/8/3').expect(404);
  await driver.get('/driver/catalog/7/3').expect(404);
});

test('catalog groups multiple sponsors and escapes product names and descriptions', async () => {
  catalog = [
    { sponsorId: 7, sponsorName: 'Northstar', id: 3, name: '<script>reward</script>' },
    { sponsorId: 7, sponsorName: 'Northstar', id: 4, name: 'Second reward' },
    { sponsorId: 8, sponsorName: 'Southstar', id: 3, name: '<script>reward</script>' },
  ];
  const driver = await login();
  const page = await driver.get('/driver/catalog?driverId=99&sponsorId=99').expect(200);
  expect(page.text.match(/id="sponsor-7"/g)).toHaveLength(1);
  expect(page.text).toContain('id="sponsor-8"');
  expect(page.text).toContain('/driver/catalog/8/3');
  expect(page.text).toContain('/driver/catalog/7/4');
  expect(page.text).toContain('&lt;script&gt;reward&lt;/script&gt;');
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM catalog_items'), [1]);
  detail = [catalog[0]];
  provider.getProduct.mockResolvedValue({ description: '<script>details</script>' });
  const product = await driver.get('/driver/catalog/7/3').expect(200);
  expect(product.text).toContain('&lt;script&gt;details&lt;/script&gt;');
});

test('invalid product identifiers are rejected before querying the catalog', async () => {
  const driver = await login();
  await driver.get('/driver/catalog/7/3junk').expect(404);
  await driver.get('/driver/catalog/0/3').expect(404);
  expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM catalog_items'))).toBe(false);
});

test('provider removal hides saved products and disables selection on their detail pages', async () => {
  catalog = [{ sponsorId: 7, sponsorName: 'Northstar', id: 20, product_id: 3, name: 'Saved reward' }];
  provider.listProducts.mockResolvedValue([]);
  provider.getProduct.mockRejectedValue(new provider.FakeStoreError('That product is no longer available.', 404));
  const driver = await login();
  const page = await driver.get('/driver/catalog').expect(200);
  expect(page.text).not.toContain('Saved reward');
  expect(page.text).toContain('There are no available products');
  const unavailable = await driver.get('/driver/catalog/7/20').expect(200);
  expect(unavailable.text).toContain('Currently unavailable');
  expect(unavailable.text).toMatch(/<button[^>]+disabled/);
  expect(provider.getProduct).toHaveBeenCalledWith(3, { allowStale: false });
});

test('detail and cards label unknown availability and prevent selection', async () => {
  catalog = [{ sponsorId: 7, sponsorName: 'Northstar', id: 3, name: 'Reward' }];
  provider.listProducts.mockResolvedValue([{ productId: 3, availability: 'unknown' }]);
  provider.getProduct.mockResolvedValue({ description: 'Saved description', availability: 'unknown' });
  const driver = await login();
  const list = await driver.get('/driver/catalog').expect(200);
  expect(list.text).toContain('Availability could not be confirmed');
  expect(list.text).toMatch(/<button[^>]+disabled/);
  const page = await driver.get('/driver/catalog/7/3').expect(200);
  expect(page.text).toContain('Unable to confirm current availability');
  expect(page.text).toMatch(/<button[^>]+disabled/);
});

test('provider outage is shown as an error rather than an empty or stale catalog', async () => {
  catalog = [{ sponsorId: 7, id: 20, product_id: 3, name: 'Saved reward' }];
  provider.listProducts.mockRejectedValue(new provider.FakeStoreError('Could not reach the product service.'));
  const driver = await login();
  const page = await driver.get('/driver/catalog').expect(502);
  expect(page.text).toContain('Could not reach the product service.');
  expect(page.text).not.toContain('Saved reward');
});

test('Ford driver catalog URL opens the same driver page', async () => {
  const driver = await login();
  await driver.get('/my-catalog').expect(302).expect('Location', '/driver/catalog');
});
