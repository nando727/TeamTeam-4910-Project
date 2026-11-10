const db = require('../db');

// Every query takes the organization (or driver) from the session, never from
// the request, so one sponsor can't read or change another's catalogue.

async function listCatalog(sponsorId) {
  return db.query(
    `SELECT id, product_id, title, category, image_url, price_value, points_cost
     FROM catalog_items WHERE sponsor_id = ? ORDER BY id DESC`,
    [sponsorId]
  );
}

// Returns the set of product ids this sponsor already saved, so the browse
// list can show "Added" instead of an Add button.
async function savedProductIds(sponsorId) {
  const rows = await db.query('SELECT product_id FROM catalog_items WHERE sponsor_id = ?', [sponsorId]);
  return new Set(rows.map((r) => r.product_id));
}

// Throws the raw ER_DUP_ENTRY error when the sponsor already saved this product.
async function addCatalogItem(sponsorId, product, pointsCost) {
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
  return db.query(
    `SELECT c.id, c.product_id, c.title, c.title AS name, c.category, c.image_url, c.price_value, c.points_cost,
            c.sponsor_id AS sponsorId, s.name AS sponsorName
     FROM catalog_items c
     JOIN driver_sponsors ds ON ds.sponsor_id = c.sponsor_id
     JOIN sponsors s ON s.id = c.sponsor_id
     WHERE ds.driver_id = ?
     ORDER BY s.name, c.title, c.id`,
    [driverId]
  );
}

// One item from this sponsor's catalogue, or null.
async function findCatalogItem(sponsorId, id) {
  const rows = await db.query(
    `SELECT id, product_id, title, category, image_url, price_value, points_cost
     FROM catalog_items WHERE id = ? AND sponsor_id = ?`,
    [id, sponsorId]
  );
  return rows[0] || null;
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

module.exports = {
  listCatalog, savedProductIds, addCatalogItem, removeCatalogItem, listCatalogForDriver,
  findCatalogItem, listDriversForPurchase, sponsorName,
};
