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

// Point changes, newest first. Every filter is optional; the date range is
// inclusive of both days. Sponsor scope is part of the query, so a sponsor
// cannot see another organization's drivers no matter what the form sends.
async function listPointChanges({ sponsorId = null, driverId = null, from = null, to = null } = {}) {
  const conditions = [];
  const params = [];
  if (sponsorId) { conditions.push('t.sponsor_id = ?'); params.push(sponsorId); }
  if (driverId) { conditions.push('t.driver_id = ?'); params.push(driverId); }
  if (from) { conditions.push('t.created_at >= ?'); params.push(from); }
  if (to) { conditions.push('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') + ' ' : '';
  return db.query(
    'SELECT t.id, t.driver_id AS driverId, COALESCE(NULLIF(u.name, \'\'), u.username) AS driverName, ' +
      'u.username AS driverUsername, t.points_change AS pointsChange, t.reason, t.created_at AS changedAt, ' +
      's.name AS sponsorName, b.username AS changedBy ' +
      'FROM point_transactions t JOIN users u ON u.id = t.driver_id JOIN sponsors s ON s.id = t.sponsor_id ' +
      'LEFT JOIN users b ON b.id = t.changed_by_user_id ' +
      where + 'ORDER BY t.created_at DESC, t.id DESC',
    params
  );
}

module.exports = { listDriversInScope, listPointChanges };
