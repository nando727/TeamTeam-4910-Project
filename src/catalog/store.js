const db = require('../db');
const { pointCost } = require('./pricing');

function priced(rows) {
  return rows.map(row => ({ ...row, points_cost: pointCost(row.price_value, row.points_per_dollar ?? 10) }));
}

async function conversionRate(sponsorId) {
  const rows = await db.query('SELECT points_per_dollar FROM sponsor_point_rates WHERE sponsor_id = ?', [sponsorId]);
  return rows.length ? Number(rows[0].points_per_dollar) : 10;
}


// Every query takes the organization (or driver) from the session, never from
// the request, so one sponsor can't read or change another's catalogue.

async function listCatalog(sponsorId) {
  return priced(await db.query(
    `SELECT id, product_id, title, category, image_url, price_value, points_cost,
       COALESCE((SELECT points_per_dollar FROM sponsor_point_rates r WHERE r.sponsor_id = catalog_items.sponsor_id), 10) AS points_per_dollar
     FROM catalog_items WHERE sponsor_id = ? ORDER BY id DESC`,
    [sponsorId]
  ));
}

// Returns the set of product ids this sponsor already saved, so the browse
// list can show "Added" instead of an Add button.
async function savedProductIds(sponsorId) {
  const rows = await db.query('SELECT product_id FROM catalog_items WHERE sponsor_id = ?', [sponsorId]);
  return new Set(rows.map((r) => r.product_id));
}

// Throws the raw ER_DUP_ENTRY error when the sponsor already saved this product.
async function addCatalogItem(sponsorId, product) {
  const pointsCost = pointCost(product.priceValue, await conversionRate(sponsorId));
  return db.query(
    `INSERT INTO catalog_items (sponsor_id, product_id, title, category, image_url, price_value, points_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sponsorId, product.productId, product.title, product.category || null, product.imageUrl || null, product.priceValue, pointsCost]
  );
}

//deletes rows that are specifically for the item under said organization
async function removeCatalogItem(sponsorId, id) {
  const result = await db.query('DELETE FROM catalog_items WHERE id = ? AND sponsor_id = ?', [id, sponsorId]);
  return result.affectedRows > 0;
}

// A driver sees the catalogue of the organization they belong to.
async function listCatalogForDriver(driverId) {
  return priced(await db.query(
    `SELECT c.id, c.product_id, c.title, c.title AS name, c.category, c.image_url, c.price_value, c.points_cost,
            c.sponsor_id AS sponsorId, s.name AS sponsorName,
            COALESCE((SELECT points_per_dollar FROM sponsor_point_rates r WHERE r.sponsor_id = c.sponsor_id), 10) AS points_per_dollar
     FROM catalog_items c
     JOIN driver_sponsors ds ON ds.sponsor_id = c.sponsor_id
     JOIN sponsors s ON s.id = c.sponsor_id
     WHERE ds.driver_id = ?
     ORDER BY s.name, c.title, c.id`,
    [driverId]
  ));
}

// One item from this sponsor's catalogue, or null.
async function findCatalogItem(sponsorId, id) {
  const rows = await db.query(
    `SELECT id, product_id, title, category, image_url, price_value, points_cost,
       COALESCE((SELECT points_per_dollar FROM sponsor_point_rates r WHERE r.sponsor_id = catalog_items.sponsor_id), 10) AS points_per_dollar
     FROM catalog_items WHERE id = ? AND sponsor_id = ?`,
    [id, sponsorId]
  );
  return rows.length ? priced(rows)[0] : null;
}

// The drivers a sponsor may buy for: active driver accounts that belong to this
// sponsor, each with the balance they hold with this sponsor.
async function listDriversForPurchase(sponsorId) {
  return db.query(
    `SELECT u.id, u.username, COALESCE(NULLIF(u.name, ''), u.username) AS displayName, ds.point_balance AS balance
     FROM driver_sponsors ds JOIN users u ON u.id = ds.driver_id
     WHERE ds.sponsor_id = ? AND u.role = 'driver' AND u.status = 'active'
     ORDER BY displayName, u.username`,
    [sponsorId]
  );
}

async function sponsorName(sponsorId) {
  const rows = await db.query('SELECT name FROM sponsors WHERE id = ?', [sponsorId]);
  return rows[0] ? rows[0].name : 'your organization';
}

// Sprint 9, the driver's cart: the catalog items a driver may buy right now,
// by id, from one sponsor they belong to. Anything that is not in that
// sponsor's catalog any more, or that the driver may not buy because the
// membership is gone, is simply absent from the result, and the cart drops it.
// The ids come from the session and are validated integers; the list is
// expanded into placeholders rather than inlined.
async function findDriverCatalogItems(driverId, sponsorId, ids) {
  const wanted = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
  if (!wanted.length) return [];
  return priced(await db.query(
    `SELECT c.id, c.product_id, c.title, c.category, c.image_url, c.price_value, c.points_cost,
            c.sponsor_id AS sponsorId, s.name AS sponsorName,
            COALESCE((SELECT points_per_dollar FROM sponsor_point_rates r WHERE r.sponsor_id = c.sponsor_id), 10) AS points_per_dollar
     FROM catalog_items c
     JOIN driver_sponsors ds ON ds.sponsor_id = c.sponsor_id AND ds.driver_id = ?
     JOIN sponsors s ON s.id = c.sponsor_id
     WHERE c.sponsor_id = ? AND c.id IN (${wanted.map(() => '?').join(', ')})
     ORDER BY c.title, c.id`,
    [driverId, sponsorId, ...wanted]
  ));
}

// The driver's balance with one sponsor, or null when they are not a member.
async function driverBalance(driverId, sponsorId) {
  const rows = await db.query(
    'SELECT ds.point_balance AS balance, s.name FROM driver_sponsors ds JOIN sponsors s ON s.id = ds.sponsor_id WHERE ds.driver_id = ? AND ds.sponsor_id = ?',
    [driverId, sponsorId]
  );
  return rows[0] ? { balance: Number(rows[0].balance), sponsorName: rows[0].name } : null;
}

// Sponsors to filter a driver's order history by: every sponsor they belong
// to, plus any they have bought from before, so a purchase made with a sponsor
// that later removed them is still findable.
async function listSponsorsForDriverOrders(driverId) {
  return db.query(
    `SELECT s.id, s.name FROM sponsors s
     WHERE EXISTS (SELECT 1 FROM driver_sponsors ds WHERE ds.driver_id = ? AND ds.sponsor_id = s.id)
        OR EXISTS (SELECT 1 FROM purchases p WHERE p.driver_id = ? AND p.sponsor_id = s.id)
     ORDER BY s.name, s.id`,
    [driverId, driverId]
  );
}

module.exports = {
  conversionRate, listCatalog, savedProductIds, addCatalogItem, removeCatalogItem, listCatalogForDriver,
  findCatalogItem, listDriversForPurchase, sponsorName,
  findDriverCatalogItems, driverBalance, listSponsorsForDriverOrders,
};
