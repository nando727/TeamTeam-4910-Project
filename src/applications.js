const db = require('./db');
const VALID_STATUSES = ['pending', 'approved', 'rejected'];

//helper to catch strange characters in filter entry
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// `sponsor_applications` INSERT — driver_id, sponsor_id, full_name,
// contact_email, reason, plus status/rejection_reason seen in its SELECT.
async function listApplicationsForSponsor(sponsorId,{ status = null, search = null } = {}) {
  const params = [sponsorId];
  const conditions = ['sponsor_id = ?'];

  //for the status portion of the filter first
  if (status && VALID_STATUSES.includes(status)){
    conditions.push('status = ?');
    params.push(status);
  }

  //currently not a real distinction between a filter for email or name: subject to change
  if (search) {
    conditions.push('(full_name LIKE ? OR contact_email LIKE ?)');
    const pattern = `%${escapeLike(search)}%`;
    params.push(pattern, pattern);
  }

  return db.query(
    `SELECT id, full_name, contact_email, reason, status
     FROM sponsor_applications
     WHERE ${conditions.join(' AND ')}
     ORDER BY id DESC`,
     params
  );
}


async function setApplicationStatus(applicationId, status, sponsorId, rejectionReason = null) {
  if (!sponsorId || !['approved', 'rejected'].includes(status)) return false;
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [applications] = await conn.execute(
      'SELECT driver_id, status FROM sponsor_applications WHERE id = ? AND sponsor_id = ? FOR UPDATE',
      [applicationId, sponsorId]
    );
    // The existing sponsor UI only offers decisions for pending applications.
    if (!applications.length || applications[0].status !== 'pending') {
      await conn.rollback();
      return false;
    }
    await conn.execute(
      'UPDATE sponsor_applications SET status = ?, rejection_reason = ? WHERE id = ? AND sponsor_id = ?',
      [status, status === 'rejected' ? rejectionReason : null, applicationId, sponsorId]
    );
    if (status === 'approved') {
      await conn.execute(
        'INSERT INTO driver_sponsors (driver_id, sponsor_id) VALUES (?, ?)',
        [applications[0].driver_id, sponsorId]
      );
    }
    // Approval and membership must either both save or both roll back.
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      const conflict = new Error('This driver already belongs to a sponsor. A driver can join only one sponsor at a time.');
      conflict.code = 'DRIVER_ALREADY_SPONSORED';
      throw conflict;
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listApplicationsForSponsor, setApplicationStatus, VALID_STATUSES};
