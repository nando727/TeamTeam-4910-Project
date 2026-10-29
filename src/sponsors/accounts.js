const db = require('../db');

// Sponsor-scoped account data access. Every function takes the sponsor's own
// id (taken from the session, never from the request) so a sponsor can only
// see or touch accounts that belong to their organization.

// LIKE treats % and _ as wildcards; escape them so typed text is literal.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// A driver belongs to an organization through driver_sponsors; a sponsor user
// belongs through users.sponsor_id. Takes two sponsor-id params (in this order).
const MEMBER_OF_ORG = `(
  (u.role = 'sponsor' AND u.sponsor_id = ?) OR
  (u.role = 'driver' AND EXISTS (
    SELECT 1 FROM driver_sponsors ds WHERE ds.driver_id = u.id AND ds.sponsor_id = ?
  ))
)`;

// SF-21: name and balance range filters, combined with AND.
async function listDriversForSponsor(sponsorId, { name = null, minBalance = null, maxBalance = null } = {}) {
  const params = [sponsorId];
  const conditions = ['ds.sponsor_id = ?'];

  if (name) {
    conditions.push('u.name LIKE ?');
    params.push(`%${escapeLike(name)}%`);
  }
  if (minBalance !== null) {
    conditions.push('u.balance >= ?');
    params.push(minBalance);
  }
  if (maxBalance !== null) {
    conditions.push('u.balance <= ?');
    params.push(maxBalance);
  }

  return db.query(
    `SELECT u.id, u.name, u.email, u.username, u.status, u.balance
     FROM users u
     JOIN driver_sponsors ds ON ds.driver_id = u.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.name`,
    params
  );
}

async function listSponsorAccounts(sponsorId) {
  return db.query(
    `SELECT id, name, email, username, status
     FROM users
     WHERE role = 'sponsor' AND sponsor_id = ?
     ORDER BY name`,
    [sponsorId]
  );
}

// Returns the account only if it is a driver or sponsor user in this
// organization; null otherwise (wrong org, admin, nonexistent).
async function findOrgMember(sponsorId, userId) {
  const rows = await db.query(
    `SELECT u.id, u.name, u.email, u.username, u.role, u.status
     FROM users u
     WHERE u.id = ? AND ${MEMBER_OF_ORG}`,
    [userId, sponsorId, sponsorId]
  );
  return rows[0] || null;
}

// SF-24: permanently removes an account and the rows that point at it, all or
// nothing. login_attempts is left alone (it is the audit log and has no FK).
// Returns false if the account isn't in this organization. If some other table
// still references the user, MySQL raises ER_ROW_IS_REFERENCED_2 and the whole
// delete rolls back, so the caller can report it.
async function deleteOrgMember(sponsorId, userId) {
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT u.id, u.role FROM users u WHERE u.id = ? AND ${MEMBER_OF_ORG} FOR UPDATE`,
      [userId, sponsorId, sponsorId]
    );
    if (!rows.length) {
      await conn.rollback();
      return false;
    }

    await conn.execute('DELETE FROM setup_tokens WHERE user_id = ?', [userId]);
    if (rows[0].role === 'driver') {
      await conn.execute('DELETE FROM driver_sponsors WHERE driver_id = ?', [userId]);
      await conn.execute('DELETE FROM sponsor_applications WHERE driver_id = ?', [userId]);
    }
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);

    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listDriversForSponsor, listSponsorAccounts, findOrgMember, deleteOrgMember };
