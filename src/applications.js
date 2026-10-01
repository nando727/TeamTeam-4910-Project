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
  const result = await db.query(
    `UPDATE sponsor_applications SET status = ?, rejection_reason = ? WHERE id = ? AND sponsor_id = ?`,
    [status, rejectionReason, applicationId, sponsorId]
  );
  return result.affectedRows > 0;
}

module.exports = { listApplicationsForSponsor, setApplicationStatus, VALID_STATUSES};
