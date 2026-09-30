const db = require('./db');
const VALID_STATUSES = ['pending', 'approved', 'rejected'];

// `sponsor_applications` INSERT — driver_id, sponsor_id, full_name,
// contact_email, reason, plus status/rejection_reason seen in its SELECT.

async function listApplicationsForSponsor(sponsorId, filter = null) {
  const params = [sponsorId];
  let where = 'WHERE sponsor_id = ?';

  //for the status portion of the filter first
  if (filter && VALID_STATUSES.includes(filter)){
    where += ' AND status = ?';
    params.push(filter);
  }

  return db.query(
    `SELECT id, full_name, contact_email, reason, status
     FROM sponsor_applications
     ${where}
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
