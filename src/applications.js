const db = require('./db');

// NOTE: table/columns are named as inferred from sponsors/routes.js's
// `sponsor_applications` INSERT — driver_id, sponsor_id, full_name,
// contact_email, reason, plus status/rejection_reason seen in its SELECT.

async function listApplicationsForSponsor(sponsorId) {
  return db.query(
    `SELECT id, full_name, contact_email, reason, status
     FROM sponsor_applications
     WHERE sponsor_id = ?
     ORDER BY id DESC`,
    [sponsorId]
  );
}

// Scoped to sponsorId in the WHERE clause — not just the application id — so
// one sponsor can't approve/reject another sponsor's applicant by guessing or
// tampering with an id in the form post. Returns false if the row didn't
// match (wrong sponsor, or id doesn't exist), so the caller can 404/403.
//
// status must be 'approved' or 'rejected' per the schema's enum.
async function setApplicationStatus(applicationId, status, sponsorId, rejectionReason = null) {
  const result = await db.query(
    `UPDATE sponsor_applications SET status = ?, rejection_reason = ? WHERE id = ? AND sponsor_id = ?`,
    [status, rejectionReason, applicationId, sponsorId]
  );
  return result.affectedRows > 0;
}

module.exports = { listApplicationsForSponsor, setApplicationStatus };
