// Sprint 9: the administrator audit log (migration 022). One row per action
// an administrator takes on an account.
//
// Writing is deliberately forgiving: a failed log line must never undo the
// change it was describing, because the change has already happened by the
// time this is called. A failure is reported to the server log instead, which
// is the same choice the app makes for the mail it sends after a change.
// Reading is for the admin page, newest first.

const db = require('../db');

// The actions the app records. Anything else is stored as 'other' rather than
// dropped: an action nobody can account for is exactly what a log is for.
const ACTIONS = {
  'role-change': 'Role changed',
  'status-change': 'Status changed',
  'password-reset': 'Password reset',
  'unlock': 'Sign-in unlocked',
  'sponsorship-added': 'Sponsorship added',
  'sponsorship-removed': 'Sponsorship removed',
  other: 'Other',
};

const actionLabel = action => ACTIONS[action] || ACTIONS.other;

async function recordAdminAction({ adminUserId = null, targetUserId = null, action, detail = null }) {
  const name = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? action : 'other';
  try {
    await db.query(
      'INSERT INTO admin_actions (admin_user_id, target_user_id, action, detail) VALUES (?, ?, ?, ?)',
      [adminUserId, targetUserId, name, detail ? String(detail).slice(0, 500) : null]
    );
    return true;
  } catch (err) {
    // The action itself already happened; losing the record is bad but undoing
    // the action would be worse, and there is nothing to undo it with here.
    console.error(`[audit] could not record "${name}" by admin ${adminUserId} on user ${targetUserId}: ${err.message}`);
    return false;
  }
}

function auditFilter({ action = null, targetUserId = null } = {}) {
  const conditions = [];
  const params = [];
  if (action && Object.prototype.hasOwnProperty.call(ACTIONS, action)) { conditions.push('a.action = ?'); params.push(action); }
  if (targetUserId) { conditions.push('a.target_user_id = ?'); params.push(targetUserId); }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')} ` : '', params };
}

// Newest first. The usernames are joined in so a deleted account still shows
// as an id rather than as nothing. `limit` and `offset` are validated
// integers from the route, never user text, so they are inlined.
async function listAdminActions(filters = {}, { limit = 25, offset = 0 } = {}) {
  const { where, params } = auditFilter(filters);
  const paging = ` LIMIT ${Number.isInteger(limit) && limit > 0 ? limit : 25} OFFSET ${Number.isInteger(offset) && offset > 0 ? offset : 0}`;
  return db.query(
    'SELECT a.id, a.action, a.detail, a.created_at AS createdAt, ' +
      'a.admin_user_id AS adminUserId, admin.username AS adminUsername, ' +
      'a.target_user_id AS targetUserId, target.username AS targetUsername, target.role AS targetRole ' +
      'FROM admin_actions a ' +
      'LEFT JOIN users admin ON admin.id = a.admin_user_id ' +
      'LEFT JOIN users target ON target.id = a.target_user_id ' +
      where + 'ORDER BY a.created_at DESC, a.id DESC' + paging,
    params
  );
}

async function countAdminActions(filters = {}) {
  const { where, params } = auditFilter(filters);
  const rows = await db.query('SELECT COUNT(*) AS total FROM admin_actions a ' + where, params);
  return Number((rows[0] && rows[0].total) || 0);
}

module.exports = { ACTIONS, actionLabel, recordAdminAction, listAdminActions, countAdminActions };
