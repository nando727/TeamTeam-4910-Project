const db = require('../db');

// Driver memberships (RC#2): a driver may belong to several sponsors.

async function listDriverSponsors(driverId) {
  return db.query(
    'SELECT s.id, s.name, s.status, ds.point_balance AS balance, ds.joined_at AS joinedAt ' +
      'FROM driver_sponsors ds JOIN sponsors s ON s.id = ds.sponsor_id WHERE ds.driver_id = ? ORDER BY s.name, s.id',
    [driverId]
  );
}

class MembershipError extends Error {
  constructor(message, status = 409) { super(message); this.name = 'MembershipError'; this.status = status; }
}

// Adds a membership. The balance starts at zero.
async function addDriverSponsor(driverId, sponsorId) {
  try {
    await db.query('INSERT INTO driver_sponsors (driver_id, sponsor_id) VALUES (?, ?)', [driverId, sponsorId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new MembershipError('This driver already belongs to that sponsor.');
    if (err.code === 'ER_NO_REFERENCED_ROW_2') throw new MembershipError('That sponsor no longer exists.', 404);
    throw err;
  }
}

// Removes one membership and leaves the others. Point history stays in
// point_transactions; the balance for that sponsor goes with the row.
async function removeDriverSponsor(driverId, sponsorId) {
  const result = await db.query('DELETE FROM driver_sponsors WHERE driver_id = ? AND sponsor_id = ?', [driverId, sponsorId]);
  return result.affectedRows > 0;
}

module.exports = { listDriverSponsors, addDriverSponsor, removeDriverSponsor, MembershipError };
