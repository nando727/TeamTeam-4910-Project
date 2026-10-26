const db = require('../db');

// Drivers the viewer may report on: every member of the scoped sponsor (or of
// any sponsor, for an admin), with the balance the driver sees on /driver/programs.
async function listDriversInScope({ sponsorId = null } = {}) {
  const params = [];
  let where = '';
  if (sponsorId) {
    where = 'WHERE ds.sponsor_id = ? ';
    params.push(sponsorId);
  }
  return db.query(
    'SELECT ds.driver_id AS id, u.username, COALESCE(NULLIF(u.name, \'\'), u.username) AS displayName, ' +
      's.id AS sponsorId, s.name AS sponsorName, ds.point_balance AS balance ' +
      'FROM driver_sponsors ds JOIN users u ON u.id = ds.driver_id JOIN sponsors s ON s.id = ds.sponsor_id ' +
      where + 'ORDER BY displayName, u.username',
    params
  );
}

// Sortable columns, by the key that appears in the URL. Only these names ever
// reach the ORDER BY clause.
const SORT_COLUMNS = {
  date: 't.created_at',
  driver: 'driverName',
  change: 't.points_change',
  sponsor: 's.name',
  madeBy: 'b.username',
  reason: 't.reason',
};
const SORT_DIRECTIONS = ['asc', 'desc'];

// The WHERE clause shared by the list, the count, and the chart, so the three
// always describe the same set of rows. Sponsor scope is part of it, so a
// sponsor cannot see another organization's drivers no matter what the form sends.
function changeFilter({ sponsorId = null, driverId = null, from = null, to = null } = {}) {
  const conditions = [];
  const params = [];
  if (sponsorId) { conditions.push('t.sponsor_id = ?'); params.push(sponsorId); }
  if (driverId) { conditions.push('t.driver_id = ?'); params.push(driverId); }
  if (from) { conditions.push('t.created_at >= ?'); params.push(from); }
  if (to) { conditions.push('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') + ' ' : '', params };
}

// Point changes for the page or the CSV. `limit` and `offset` are validated
// integers from the route, never user text, so they are inlined.
async function listPointChanges(filters = {}, { sort = 'date', dir = 'desc', limit = null, offset = 0 } = {}) {
  const column = SORT_COLUMNS[sort] || SORT_COLUMNS.date;
  const direction = SORT_DIRECTIONS.includes(dir) ? dir.toUpperCase() : 'DESC';
  const { where, params } = changeFilter(filters);
  const paging = Number.isInteger(limit) && limit > 0
    ? ` LIMIT ${limit} OFFSET ${Number.isInteger(offset) && offset > 0 ? offset : 0}`
    : '';
  return db.query(
    'SELECT t.id, t.driver_id AS driverId, COALESCE(NULLIF(u.name, \'\'), u.username) AS driverName, ' +
      'u.username AS driverUsername, t.points_change AS pointsChange, t.reason, t.created_at AS changedAt, ' +
      's.name AS sponsorName, b.username AS changedBy ' +
      'FROM point_transactions t JOIN users u ON u.id = t.driver_id JOIN sponsors s ON s.id = t.sponsor_id ' +
      'LEFT JOIN users b ON b.id = t.changed_by_user_id ' +
      where + `ORDER BY ${column} ${direction}, t.id DESC` + paging,
    params
  );
}

async function countPointChanges(filters = {}) {
  const { where, params } = changeFilter(filters);
  const rows = await db.query('SELECT COUNT(*) AS total FROM point_transactions t ' + where, params);
  return Number((rows[0] && rows[0].total) || 0);
}

// Per-day totals for the chart, over the whole filtered set (not one page).
async function dailyPointTotals(filters = {}) {
  const { where, params } = changeFilter(filters);
  return db.query(
    "SELECT DATE_FORMAT(t.created_at, '%Y-%m-%d') AS day, " +
      'SUM(CASE WHEN t.points_change > 0 THEN t.points_change ELSE 0 END) AS awarded, ' +
      'SUM(CASE WHEN t.points_change < 0 THEN t.points_change ELSE 0 END) AS deducted, ' +
      'SUM(t.points_change) AS net ' +
      'FROM point_transactions t ' + where + 'GROUP BY day ORDER BY day',
    params
  );
}

// Story AD-11: every sponsor with its drivers' purchases in one calendar month.
// `monthStart` and `nextMonthStart` are YYYY-MM-01 strings from the route.
async function monthlySponsorPurchases(monthStart, nextMonthStart) {
  return db.query(
    'SELECT s.id, s.name, s.status, COUNT(p.id) AS purchases, COALESCE(SUM(p.amount_cents), 0) AS totalCents ' +
      'FROM sponsors s LEFT JOIN purchases p ON p.sponsor_id = s.id AND p.purchased_at >= ? AND p.purchased_at < ? ' +
      'GROUP BY s.id, s.name, s.status ORDER BY s.name, s.id',
    [monthStart, nextMonthStart]
  );
}

// Months that have at least one purchase, newest first, for the month picker.
async function listPurchaseMonths() {
  const rows = await db.query(
    "SELECT DISTINCT DATE_FORMAT(purchased_at, '%Y-%m') AS month FROM purchases ORDER BY month DESC"
  );
  return rows.map(row => row.month);
}

// ---- Sales by Sponsor (stories AD-25 to AD-29) ---------------------------------

const SALES_VERSIONS = ['summary', 'detailed'];
// Sortable columns per version; only these reach ORDER BY.
const SALES_SORT_COLUMNS = {
  summary: { sponsor: 's.name', status: 's.status', sales: 'sales', dollars: 'totalCents', points: 'points' },
  detailed: { date: 'p.purchased_at', sponsor: 's.name', driver: 'driverName', item: 'p.description', amount: 'p.amount_cents', points: 'p.points_spent' },
};

function orderClause(version, sort, dir, tieBreak) {
  const columns = SALES_SORT_COLUMNS[version];
  const column = columns[sort] || Object.values(columns)[0];
  const direction = SORT_DIRECTIONS.includes(dir) ? dir.toUpperCase() : 'ASC';
  return `ORDER BY ${column} ${direction}, ${tieBreak}`;
}
function pagingClause(limit, offset) {
  return Number.isInteger(limit) && limit > 0
    ? ` LIMIT ${limit} OFFSET ${Number.isInteger(offset) && offset > 0 ? offset : 0}`
    : '';
}
// Date conditions on purchases, inclusive of both days.
function purchaseDateFilter({ from = null, to = null } = {}) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push('p.purchased_at >= ?'); params.push(from); }
  if (to) { conditions.push('p.purchased_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  return { conditions, params };
}

// Summary: one row per sponsor in scope. The date filter sits in the JOIN so a
// sponsor with no sales in the range still appears with zeros.
async function salesSummary({ sponsorId = null, from = null, to = null } = {}, { sort = 'sponsor', dir = 'asc', limit = null, offset = 0 } = {}) {
  const dates = purchaseDateFilter({ from, to });
  const params = [...dates.params];
  let where = '';
  if (sponsorId) { where = 'WHERE s.id = ? '; params.push(sponsorId); }
  return db.query(
    'SELECT s.id, s.name, s.status, COUNT(p.id) AS sales, COALESCE(SUM(p.amount_cents), 0) AS totalCents, ' +
      'COALESCE(SUM(p.points_spent), 0) AS points ' +
      'FROM sponsors s LEFT JOIN purchases p ON p.sponsor_id = s.id' +
      (dates.conditions.length ? ' AND ' + dates.conditions.join(' AND ') : '') + ' ' +
      where + 'GROUP BY s.id, s.name, s.status ' +
      orderClause('summary', sort, dir, 's.name ASC, s.id ASC') + pagingClause(limit, offset),
    params
  );
}

async function countSponsorsInScope({ sponsorId = null } = {}) {
  const rows = sponsorId
    ? await db.query('SELECT COUNT(*) AS total FROM sponsors WHERE id = ?', [sponsorId])
    : await db.query('SELECT COUNT(*) AS total FROM sponsors');
  return Number((rows[0] && rows[0].total) || 0);
}

function salesFilter({ sponsorId = null, from = null, to = null } = {}) {
  const { conditions, params } = purchaseDateFilter({ from, to });
  if (sponsorId) { conditions.unshift('p.sponsor_id = ?'); params.unshift(sponsorId); }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') + ' ' : '', params };
}

// Detailed: one row per purchase.
async function salesDetail(filters = {}, { sort = 'date', dir = 'desc', limit = null, offset = 0 } = {}) {
  const { where, params } = salesFilter(filters);
  return db.query(
    'SELECT p.id, p.purchased_at AS purchasedAt, s.name AS sponsorName, ' +
      'COALESCE(NULLIF(u.name, \'\'), u.username) AS driverName, u.username AS driverUsername, ' +
      'p.description AS item, p.amount_cents AS amountCents, p.points_spent AS points ' +
      'FROM purchases p JOIN sponsors s ON s.id = p.sponsor_id JOIN users u ON u.id = p.driver_id ' +
      where + orderClause('detailed', sort, dir, 'p.id DESC') + pagingClause(limit, offset),
    params
  );
}

async function countSales(filters = {}) {
  const { where, params } = salesFilter(filters);
  const rows = await db.query('SELECT COUNT(*) AS total FROM purchases p ' + where, params);
  return Number((rows[0] && rows[0].total) || 0);
}

// Grand totals for the whole filtered set (both versions, every page).
async function salesTotals(filters = {}) {
  const { where, params } = salesFilter(filters);
  const rows = await db.query(
    'SELECT COUNT(*) AS sales, COALESCE(SUM(p.amount_cents), 0) AS totalCents, COALESCE(SUM(p.points_spent), 0) AS points ' +
      'FROM purchases p ' + where,
    params
  );
  const row = rows[0] || {};
  return { sales: Number(row.sales || 0), totalCents: Number(row.totalCents || 0), points: Number(row.points || 0) };
}

module.exports = {
  SORT_COLUMNS, SORT_DIRECTIONS, SALES_SORT_COLUMNS, SALES_VERSIONS,
  listDriversInScope, listPointChanges, countPointChanges, dailyPointTotals,
  monthlySponsorPurchases, listPurchaseMonths,
  salesSummary, countSponsorsInScope, salesDetail, countSales, salesTotals,
};
