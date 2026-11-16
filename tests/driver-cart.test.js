// Sprint 9: a driver fills a cart from one sponsor's catalog, reviews it, and
// checks out. The points are spent through the points store in one
// transaction with the purchases rows, a short cart writes nothing, and a
// confirmation cannot be replayed.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');
const { app } = require('../src/app');

let hash;
let conn;
let executed;
let balances;
let items;
let memberships;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

const originalTransport = process.env.MAIL_TRANSPORT;
beforeEach(() => {
  clearOutbox();
  process.env.MAIL_TRANSPORT = 'silent';
  executed = [];
  balances = { 7: 1000, 8: 50 };
  memberships = { 7: 'Northstar Freight', 8: 'Southstar Haulage' };
  items = [
    { id: 31, sponsor_id: 7, product_id: 3, title: 'Insulated mug', category: 'kitchen', image_url: 'https://fakestoreapi.com/img/mug.png', price_value: '24.99', points_cost: 250 },
    { id: 32, sponsor_id: 7, product_id: 1004, title: 'Headset', category: 'electronics', image_url: null, price_value: '39.99', points_cost: 400 },
    { id: 41, sponsor_id: 8, product_id: 5, title: 'Gloves', category: '', image_url: null, price_value: '1.00', points_cost: 10 },
  ];
  conn = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async (sql, params) => {
      executed.push([sql, params]);
      if (sql.includes('FOR UPDATE')) return [[{ point_balance: balances[params[1]] }]];
      // Inside the transaction the next lock sees the balance just written.
      if (sql.startsWith('UPDATE driver_sponsors SET point_balance')) { balances[params[2]] = params[0]; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO point_transactions')) return [{ insertId: 500 + executed.length }];
      if (sql.startsWith('INSERT INTO purchases')) return [{ insertId: 900 + executed.length }];
      return [{ affectedRows: 1 }];
    }),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  // The catalog page itself, for the tests that land back on it after adding.
  const provider = require('../src/fakestore/client');
  vi.spyOn(provider, 'listProducts').mockImplementation(async () => items.map(i => ({ productId: i.product_id })));
  vi.spyOn(provider, 'getProduct').mockResolvedValue({ productId: 3, description: 'Keeps coffee hot' });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const role = { driver21: 'driver', sponsor7: 'sponsor' }[params[0]];
      return role ? [{ id: role === 'driver' ? 21 : 70, username: params[0], role, status: 'active', sponsor_id: role === 'sponsor' ? 7 : null, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return [{ id: 21, username: 'driver21', name: 'Theo Trucker', email: 'theo@example.com', role: 'driver', status: 'active' }];
    if (sql.includes('FROM driver_alert_preferences')) return [];
    // The driver's balance with one sponsor.
    if (sql.startsWith('SELECT ds.point_balance AS balance, s.name')) {
      const [, sponsorId] = params;
      return memberships[sponsorId] ? [{ balance: balances[sponsorId], name: memberships[sponsorId] }] : [];
    }
    // Everything in the catalogs the driver can buy from, for the catalog
    // page. Only that query aliases the title as `name`; the by-id lookup
    // below shares its JOIN, so matching on the JOIN would shadow it.
    if (sql.includes('c.title AS name')) {
      return items.filter(i => memberships[i.sponsor_id]).map(i => ({ ...i, sponsorId: i.sponsor_id, sponsorName: memberships[i.sponsor_id] }));
    }
    // Catalog items by id for one sponsor the driver belongs to.
    if (sql.includes('c.sponsor_id = ? AND c.id IN')) {
      const [, sponsorId, ...ids] = params;
      if (!memberships[sponsorId]) return [];
      return items.filter(i => i.sponsor_id === sponsorId && ids.includes(i.id)).map(i => ({ ...i, sponsorId: i.sponsor_id, sponsorName: memberships[sponsorId] }));
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  if (originalTransport === undefined) delete process.env.MAIL_TRANSPORT; else process.env.MAIL_TRANSPORT = originalTransport;
});

async function driver() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'driver21', password: 'Password1!' }).expect(302);
  return { agent };
}
// The form token is per session; any page with a form shows it. The empty
// cart has none, so the alert settings page is used.
async function tokenOf(agent) {
  const page = await agent.get('/points/settings').expect(200);
  return page.text.match(/name="token" value="([a-f0-9]+)"/)[1];
}
const add = (agent, token, body) => agent.post('/driver/cart/add').type('form').send({ token, ...body });

test('unavailable offers cannot be added even by posting the form directly', async () => {
  const provider = require('../src/products/provider');
  provider.getProduct.mockResolvedValue({ availability: 'unavailable' });
  const { agent } = await driver();
  const token = await tokenOf(agent);
  await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
  expect((await agent.get('/driver/cart')).text).toContain('Your cart is empty');
  expect(executed).toHaveLength(0);
});

describe('the cart', () => {
  test('is for drivers only, and starts empty with a link to the catalog', async () => {
    await request(app).get('/driver/cart').expect(302);
    const { agent } = await driver();
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Your cart is empty.');
    expect(page.text).toContain('href="/driver/catalog"');
    // The header links to the cart and to the order history.
    expect(page.text).toContain('href="/driver/cart"');
    expect(page.text).toContain('href="/driver/orders"');
  });

  test('adds an item from a sponsor catalog, shows it with the balance, and counts it in the header', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    const added = await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    // Adding keeps you where you were; it does not throw you into the cart.
    expect(added.headers.location).toBe('/driver/catalog');
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Added &#34;Insulated mug&#34;. Your cart has 1 item from Northstar Freight.');
    expect(page.text).toContain('Insulated mug');
    expect(page.text).toContain('Cart (1)');
    expect(page.text).toContain('Your balance with Northstar Freight');
    expect(page.text).toContain('1,000 points');
    expect(page.text).toContain('href="/driver/cart/checkout"');
    // Adding the same item again raises the quantity, capped at ten.
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '9' }).expect(303);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '5' }).expect(303);
    const more = await agent.get('/driver/cart').expect(200);
    expect(more.text).toContain('value="10"');
    expect(more.text).toContain('Cart (10)');
  });

  test('refuses an item the driver cannot buy, and a bad quantity', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    // Item 41 belongs to sponsor 8; claiming it is sponsor 7's finds nothing.
    await add(agent, token, { itemId: '41', sponsorId: '7' }).expect(303);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '0' }).expect(303);
    let page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Choose an item and a quantity from 1 to 10.');
    expect(page.text).toContain('Your cart is empty.');
    // A membership that has ended makes the sponsor's items unavailable too.
    delete memberships[8];
    await add(agent, token, { itemId: '41', sponsorId: '8' }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Your cart is empty.');
  });

  test('never mixes sponsors: a second sponsor\'s item asks to replace the cart', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    await add(agent, token, { itemId: '41', sponsorId: '8' }).expect(303);
    let page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Replace your cart?');
    expect(page.text).toContain('Southstar Haulage');
    expect(page.text).toContain('Insulated mug');
    // Keeping the cart leaves it as it was.
    await agent.post('/driver/cart/conflict/keep').type('form').send({ token }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).not.toContain('Replace your cart?');
    expect(page.text).toContain('Insulated mug');
    // Replacing empties it first.
    await add(agent, token, { itemId: '41', sponsorId: '8', replace: '1' }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Gloves');
    expect(page.text).not.toContain('Insulated mug');
    expect(page.text).toContain('Your balance with Southstar Haulage');
  });

  test('quantities can be changed, lines removed, and the cart emptied', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    await add(agent, token, { itemId: '32', sponsorId: '7' }).expect(303);
    await agent.post('/driver/cart/update').type('form').send({ token, itemId: '31', quantity: '2' }).expect(303);
    let page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('900 points');
    await agent.post('/driver/cart/update').type('form').send({ token, itemId: '31', quantity: '0' }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).not.toContain('Insulated mug');
    expect(page.text).toContain('Headset');
    await agent.post('/driver/cart/remove').type('form').send({ token, itemId: '32' }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Your cart is empty.');
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    await agent.post('/driver/cart/clear').type('form').send({ token }).expect(303);
    page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Your cart is empty.');
  });

  test('drops an item that left the catalog and says so', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    await add(agent, token, { itemId: '32', sponsorId: '7' }).expect(303);
    items = items.filter(i => i.id !== 32);
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('1 item is no longer in the catalog and was removed from your cart.');
    expect(page.text).toContain('Insulated mug');
    expect(page.text).not.toContain('Headset');
  });

  test('blocks checkout when points are short, on the page and on the server', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    balances[7] = 300;
    await add(agent, token, { itemId: '32', sponsorId: '7' }).expect(303);
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('You need 100 more points with Northstar Freight');
    expect(page.text).not.toContain('href="/driver/cart/checkout"');
    const review = await agent.get('/driver/cart/checkout').expect(302);
    expect(review.headers.location).toBe('/driver/cart');
    expect(conn.beginTransaction).not.toHaveBeenCalled();
  });
});

describe('checkout', () => {
  async function filledCart() {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '2' }).expect(303);
    await add(agent, token, { itemId: '32', sponsorId: '7' }).expect(303);
    const review = await agent.get('/driver/cart/checkout').expect(200);
    const confirmId = review.text.match(/name="confirmId" value="([a-f0-9]{64})"/)[1];
    return { agent, token, review, confirmId };
  }

  test('reviews the order, then writes every line in one transaction and shows the success page with confetti', async () => {
    const { agent, token, review, confirmId } = await filledCart();
    expect(review.text).toContain('Spend 900 points with Northstar Freight?');
    expect(review.text).toContain('Balance after');
    expect(review.text).toContain('100 points');
    expect(review.text).toContain('data-submit-once');

    const done = await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    expect(done.headers.location).toBe('/driver/cart/complete');

    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    expect(conn.commit).toHaveBeenCalledOnce();
    expect(conn.rollback).not.toHaveBeenCalled();
    const sqls = executed.map(([sql]) => sql);
    // The balance is locked and checked once for the whole cart, then once per line.
    expect(sqls.filter(sql => sql.includes('FOR UPDATE'))).toHaveLength(3);
    const purchases = executed.filter(([sql]) => sql.startsWith('INSERT INTO purchases'));
    expect(purchases.map(([, params]) => params)).toEqual([
      [21, 7, 'Insulated mug ×2', 4998, 500],
      [21, 7, 'Headset', 3999, 400],
    ]);
    const transactions = executed.filter(([sql]) => sql.startsWith('INSERT INTO point_transactions'));
    expect(transactions.map(([, params]) => params)).toEqual([
      [21, 7, 21, -500, 'Catalog purchase: Insulated mug ×2'],
      [21, 7, 21, -400, 'Catalog purchase: Headset'],
    ]);
    const updates = executed.filter(([sql]) => sql.startsWith('UPDATE driver_sponsors'));
    expect(updates.map(([, params]) => params[0])).toEqual([500, 100]);
    expect(sqls.filter(sql => sql.startsWith('INSERT INTO point_alerts'))).toHaveLength(2);

    const page = await agent.get('/driver/cart/complete').expect(200);
    expect(page.text).toContain('Order placed!');
    expect(page.text).toContain('900 points');
    expect(page.text).toContain('2 × Insulated mug');
    expect(page.text).toContain('is now <strong>100 points</strong>');
    expect(page.text).toContain('data-confetti');
    expect(page.text).toContain('<script src="/confetti.js" defer></script>');
    expect(page.text).not.toContain('Cart (');
    // The success page is shown once; the cart is gone.
    await agent.get('/driver/cart/complete').expect(302);
    const cart = await agent.get('/driver/cart').expect(200);
    expect(cart.text).toContain('Your cart is empty.');

    // The driver is told by email, after the commit.
    const [mail] = sentMessages();
    expect(mail.to).toBe('theo@example.com');
    expect(mail.subject).toBe('Your order with Northstar Freight');
    expect(mail.text).toContain('2 × Insulated mug — 500 points');
    expect(mail.text).toContain('now 100 points');
    expect(mail.text).toContain('/driver/orders');
  });

  test('a second submit of the same confirmation buys nothing', async () => {
    const { agent, token, confirmId } = await filledCart();
    await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    const again = await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    expect(again.headers.location).toBe('/driver/cart');
    expect(conn.beginTransaction).toHaveBeenCalledOnce();
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('not confirmed, or it has already been placed');
  });

  test('a forged or stale confirmation buys nothing', async () => {
    const { agent, token, confirmId } = await filledCart();
    await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId: 'f'.repeat(64) }).expect(303);
    // The id was spent by that attempt, so even the real one is refused now.
    await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    // Review again, then the cart changes before the confirmation arrives.
    const review = await agent.get('/driver/cart/checkout').expect(200);
    const fresh = review.text.match(/name="confirmId" value="([a-f0-9]{64})"/)[1];
    items.find(i => i.id === 32).points_per_dollar = 20;
    await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId: fresh }).expect(303);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Your cart changed since you reviewed it');
    expect(page.text).toContain('Headset');
  });

  test('an offer becoming unavailable after review prevents checkout without spending points', async () => {
    const { agent, token, confirmId } = await filledCart();
    const provider = require('../src/products/provider');
    provider.getProduct.mockResolvedValue({ availability: 'unavailable' });
    await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    expect(conn.beginTransaction).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
    expect((await agent.get('/driver/cart')).text).toContain('Nothing was bought.');
  });

  test('a balance that dropped under the lock rolls everything back', async () => {
    const { agent, token, confirmId } = await filledCart();
    // The page saw 1,000; by the time the row is locked it is 899.
    balances[7] = 899;
    const res = await agent.post('/driver/cart/checkout').type('form').send({ token, confirmId }).expect(303);
    expect(res.headers.location).toBe('/driver/cart');
    expect(conn.rollback).toHaveBeenCalledOnce();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(executed.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    expect(sentMessages()).toHaveLength(0);
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('You have 899 points with Northstar Freight and this cart costs 900 points, so nothing was bought.');
    expect(page.text).toContain('Insulated mug');
  });

  test('a sponsor cannot use the cart', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'sponsor7', password: 'Password1!' }).expect(302);
    await agent.get('/driver/cart').expect(403);
    await agent.get('/driver/cart/checkout').expect(403);
    await agent.post('/driver/cart/add').type('form').send({ itemId: '31', sponsorId: '7' }).expect(403);
  });
});

describe('the catalog pages', () => {
  test('show the points cost and an add-to-cart form, and the detail page takes a quantity', async () => {
    const catalogStore = require('../src/catalog/store');
    const provider = require('../src/fakestore/client');
    vi.spyOn(provider, 'listProducts').mockResolvedValue([{ productId: 3 }]);
    vi.spyOn(provider, 'getProduct').mockResolvedValue({ productId: 3, description: 'Keeps coffee hot' });
    vi.spyOn(catalogStore, 'listCatalogForDriver').mockResolvedValue([
      { id: 31, product_id: 3, title: 'Insulated mug', name: 'Insulated mug', price_value: '24.99', points_cost: 250, image_url: null, sponsorId: 7, sponsorName: 'Northstar Freight' },
    ]);
    const { agent } = await driver();
    const list = await agent.get('/driver/catalog').expect(200);
    expect(list.text).toContain('250 points');
    expect(list.text).toContain('action="/driver/cart/add"');
    expect(list.text).toContain('name="itemId" value="31"');
    expect(list.text).toContain('name="sponsorId" value="7"');
    const detail = await agent.get('/driver/catalog/7/31').expect(200);
    expect(detail.text).toContain('250 points');
    expect(detail.text).toContain('name="quantity"');
    expect(detail.text).toContain('max="10"');
  });
});

describe('the confetti script', () => {
  test('is small, library-free, and skips under reduced motion', () => {
    const script = readFileSync(new URL('../public/confetti.js', import.meta.url), 'utf8');
    expect(script.length).toBeLessThan(4000);
    expect(script).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches) return");
    expect(script).toContain("querySelector('[data-confetti]')");
    expect(script).toContain('requestAnimationFrame');
    expect(script).not.toMatch(/import |require\(|https?:\/\//);
  });
});

describe('adding without losing your place', () => {
  test('returns to the catalog, with a notice that links to the cart', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    const res = await add(agent, token, { itemId: '31', sponsorId: '7', back: '/driver/catalog' }).expect(303);
    expect(res.headers.location).toBe('/driver/catalog');
    const page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).toContain('Added &#34;Insulated mug&#34;');
    expect(page.text).toContain('href="/driver/cart"');
    expect(page.text).toContain('View your cart');
    // Read once: it is not still sitting there on the next visit.
    const again = await agent.get('/driver/catalog').expect(200);
    expect(again.text).not.toContain('Added &#34;Insulated mug&#34;');
  });

  test('returns to the product page when the add came from there', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    const res = await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '3', back: '/driver/catalog/7/31' }).expect(303);
    expect(res.headers.location).toBe('/driver/catalog/7/31');
  });

  test('a back value of its own choosing cannot send the driver off the site', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    for (const back of ['https://evil.example', '//evil.example', '/admin/manage-users', '/driver/catalog/7/31/../..']) {
      const res = await add(agent, token, { itemId: '31', sponsorId: '7', back }).expect(303);
      expect(res.headers.location).toBe('/driver/catalog');
    }
  });

  test('says how many you have once there is more than one', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '2' }).expect(303);
    const page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).toContain('and you now have 3');
  });

  test('says when a quantity is capped instead of quietly rounding it down', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '8' }).expect(303);
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '8' }).expect(303);
    const page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).toContain('You can have at most 10 of one item');
    expect(page.text).toContain('stays at 10');
    const cart = await agent.get('/driver/cart').expect(200);
    expect(cart.text).toContain('value="10"');
  });

  test('a full cart says so without moving the driver either', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    // Twenty different items, then one more.
    items = Array.from({ length: 21 }, (_, i) => ({
      id: 100 + i, sponsor_id: 7, product_id: 3, title: `Item ${i}`, category: '', image_url: null, price_value: '1.00', points_cost: 1,
    }));
    for (let i = 0; i < 20; i++) await add(agent, token, { itemId: String(100 + i), sponsorId: '7' }).expect(303);
    const res = await add(agent, token, { itemId: '120', sponsorId: '7', back: '/driver/catalog' }).expect(303);
    expect(res.headers.location).toBe('/driver/catalog');
    const page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).toContain('Your cart can hold 20 different items.');
  });

  test('the question about two sponsors is asked once and does not come back', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    const asked = await add(agent, token, { itemId: '41', sponsorId: '8' }).expect(303);
    // The one add that does go to the cart: the question lives there.
    expect(asked.headers.location).toBe('/driver/cart');
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Replace your cart?');
    // Walking away instead of answering leaves nothing behind.
    const later = await agent.get('/driver/cart').expect(200);
    expect(later.text).not.toContain('Replace your cart?');
    expect(later.text).toContain('Insulated mug');
  });

  test('answering it with a replacement comes back to the cart', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    const res = await add(agent, token, { itemId: '41', sponsorId: '8', replace: '1', back: '/driver/cart' }).expect(303);
    expect(res.headers.location).toBe('/driver/cart');
    const page = await agent.get('/driver/cart').expect(200);
    expect(page.text).toContain('Gloves');
    expect(page.text).not.toContain('Insulated mug');
  });
});

describe('one add at a time', () => {
  test('the catalog and product forms are in a group the script disables together', async () => {
    const catalogStore = require('../src/catalog/store');
    const provider = require('../src/fakestore/client');
    vi.spyOn(provider, 'listProducts').mockResolvedValue([{ productId: 3 }]);
    vi.spyOn(provider, 'getProduct').mockResolvedValue({ productId: 3, description: 'Keeps coffee hot' });
    vi.spyOn(catalogStore, 'listCatalogForDriver').mockResolvedValue([
      { id: 31, product_id: 3, title: 'Insulated mug', name: 'Insulated mug', price_value: '24.99', points_cost: 250, image_url: null, sponsorId: 7, sponsorName: 'Northstar Freight' },
    ]);
    const { agent } = await driver();
    const list = await agent.get('/driver/catalog').expect(200);
    expect(list.text).toContain('data-submit-group="cart-add"');
    const detail = await agent.get('/driver/catalog/7/31').expect(200);
    expect(detail.text).toContain('data-submit-group="cart-add"');
  });

  test('the script disables the whole group and releases it when the page returns', () => {
    const script = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
    expect(script).toContain("form[data-submit-group]");
    expect(script).toContain("button.disabled = true");
    // Without this a cached back-navigation leaves every button dead.
    expect(script).toContain("window.addEventListener('pageshow'");
    expect(script).toContain('button.disabled = false');
  });
});

describe('the floating mini-cart', () => {
  test('appears for a driver once the cart holds something, with the count and the link', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    // Nothing in the cart: no corner shortcut anywhere.
    let page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).not.toContain('class="mini-cart"');
    await add(agent, token, { itemId: '31', sponsorId: '7', quantity: '2' }).expect(303);
    page = await agent.get('/driver/catalog').expect(200);
    expect(page.text).toContain('class="mini-cart" href="/driver/cart"');
    expect(page.text).toContain('aria-label="View your cart, 2 items"');
    expect(page.text).toContain('<span class="mini-cart__count" aria-hidden="true">2</span>');
    // And on pages that are not about shopping at all.
    const settings = await agent.get('/points/settings').expect(200);
    expect(settings.text).toContain('class="mini-cart"');
  });

  test('stays off the cart pages, which it would only point back at', async () => {
    const { agent } = await driver();
    const token = await tokenOf(agent);
    await add(agent, token, { itemId: '31', sponsorId: '7' }).expect(303);
    const cart = await agent.get('/driver/cart').expect(200);
    expect(cart.text).not.toContain('class="mini-cart"');
    const checkout = await agent.get('/driver/cart/checkout').expect(200);
    expect(checkout.text).not.toContain('class="mini-cart"');
  });
});
