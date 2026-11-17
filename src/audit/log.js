/* aa-55 the audit log
 * every event is stored once: sign-ins in login_attempts, point changes in
   point_transactions, unlocks in login_unlocks, everything else in audit_events
 * recordEvent writes audit_events, findEvents reads all four as one list
*/
const db = require('../db');

// stored: true means recordEvent writes it, the rest already live in another table
const EVENT_TYPES = {
  'login.succeeded': { label: 'Signed in', category: 'sign-ins' },
  'login.failed': { label: 'Failed sign-in', category: 'sign-ins' },
  'password.changed': { label: 'Password changed', category: 'passwords', stored: true },
  'points.changed': { label: 'Points changed', category: 'points' },
  'application.decided': { label: 'Application decided', category: 'applications', stored: true },
  'role.changed': { label: 'Role changed', category: 'accounts', stored: true },
  'status.changed': { label: 'Status changed', category: 'accounts', stored: true },
  'sponsorship.added': { label: 'Sponsorship added', category: 'accounts', stored: true },
  'sponsorship.removed': { label: 'Sponsorship removed', category: 'accounts', stored: true },
  'account.unlocked': { label: 'Sign-in unlocked', category: 'accounts' },
  'invoice.emailed': { label: 'Invoice emailed', category: 'billing', stored: true },
  unknown: { label: 'Other', category: 'other', stored: true },
};

// what the audit log page filters by, the first four are the ones the spec names
const CATEGORIES = {
  'sign-ins': 'Sign-in attempts',
  passwords: 'Password changes',
  points: 'Point changes',
  applications: 'Driver applications',
  accounts: 'Account changes',
  billing: 'Billing',
  other: 'Other',
};

const MAX_DETAIL = 2048; // the column's width, fits a 2000 character rejection reason
const DEFAULT_LIMIT = 25;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const typeLabel = type => (EVENT_TYPES[type] || EVENT_TYPES.unknown).label;

function detailText(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail);
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 3)}...`;
}

/* appends one event, returns its id or null if the write failed
 * occurred_at is left to the database's clock (aa-59)
 * aa-60 a failed write is reported and never thrown, so the action it
   describes still completes
 * conn is the caller's open transaction, so the event commits with the change
 * a type it doesn't write is stored as 'unknown', never dropped
*/
async function recordEvent({ type, actorId = null, subjectId = null, sponsorId = null, detail = null } = {}, conn = null) {
  const known = Boolean(EVENT_TYPES[type] && EVENT_TYPES[type].stored);
  const text = known ? detail : [`type=${type}`, detail].filter(Boolean).join(' ');
  const sql = 'INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, sponsor_id, detail) '
    + 'VALUES (?, ?, ?, ?, ?)';
  const params = [known ? type : 'unknown', actorId, subjectId, sponsorId, detailText(text)];
  try {
    const result = conn ? (await conn.execute(sql, params))[0] : await db.query(sql, params);
    return result.insertId;
  } catch (err) {
    console.error(`[audit] could not record "${type}": ${err.message}`);
    return null;
  }
}

// the four tables as one list of events, each in the same seven columns
const ALL_EVENTS = `
  SELECT ae.id, ae.occurred_at, ae.event_type AS type, ae.actor_user_id, ae.subject_user_id,
         NULL AS username, ae.sponsor_id, ae.detail
    FROM audit_events ae
  UNION ALL
  SELECT la.id, la.attempted_at, IF(la.success, 'login.succeeded', 'login.failed'), NULL, u.id,
         la.username, NULL, CONCAT('from ', COALESCE(la.source_ip, 'an unknown address'))
    FROM login_attempts la LEFT JOIN users u ON u.username = la.username
  UNION ALL
  SELECT pt.id, pt.created_at, 'points.changed', pt.changed_by_user_id, pt.driver_id,
         NULL, pt.sponsor_id, CONCAT(IF(pt.points_change > 0, '+', ''), pt.points_change, ' points: ', pt.reason)
    FROM point_transactions pt
  UNION ALL
  SELECT lu.id, lu.unlocked_at, 'account.unlocked', lu.unlocked_by, u.id,
         lu.username, NULL, NULL
    FROM login_unlocks lu LEFT JOIN users u ON u.username = lu.username`;

/* turns the filters into a WHERE clause, every value is bound
 * aa-57 an event with no sponsor (a sign-in, a password change) is matched
   through the driver it is about, because '= ?' never matches NULL
 * one that names another sponsor is not, a shared driver's other program stays private
 * `to` covers its whole day
*/
function whereFor({ category = null, userId = null, sponsorId = null, from = null, to = null } = {}) {
  const where = [];
  const params = [];
  if (category) {
    const types = Object.keys(EVENT_TYPES).filter(type => EVENT_TYPES[type].category === category);
    if (!types.length) throw new Error(`Unknown audit log category: ${category}`);
    where.push(`e.type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (userId) {
    where.push('e.subject_user_id = ?');
    params.push(userId);
  }
  if (sponsorId) {
    where.push('(e.sponsor_id = ? OR (e.sponsor_id IS NULL AND EXISTS (SELECT 1 FROM driver_sponsors ds '
      + 'WHERE ds.driver_id = e.subject_user_id AND ds.sponsor_id = ?)))');
    params.push(sponsorId, sponsorId);
  }
  for (const [value, clause] of [[from, 'e.occurred_at >= ?'], [to, 'e.occurred_at < ? + INTERVAL 1 DAY']]) {
    if (!value) continue;
    if (!DATE_ONLY.test(value)) throw new Error(`Audit log dates must be YYYY-MM-DD, got: ${value}`);
    where.push(clause);
    params.push(value);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/* newest first, with names instead of ids
 * LEFT joins, so an event with no actor, account or sponsor is still listed
 * the time crosses as epoch ms, a DATETIME would be rebuilt in Node's local zone
*/
async function findEvents(filters = {}, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const { where, params } = whereFor(filters);
  const rows = await db.query(
    `SELECT e.type, e.detail, UNIX_TIMESTAMP(e.occurred_at) * 1000 AS occurred_at_ms,
            actor.username AS actor_username,
            e.subject_user_id, COALESCE(subject.username, e.username) AS subject_username,
            subject.role AS subject_role, sponsor.name AS sponsor_name
       FROM (${ALL_EVENTS}) e
       LEFT JOIN users actor ON actor.id = e.actor_user_id
       LEFT JOIN users subject ON subject.id = e.subject_user_id
       LEFT JOIN sponsors sponsor ON sponsor.id = e.sponsor_id
      ${where}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ? OFFSET ?`,
    [...params, String(Number(limit) > 0 ? Math.floor(limit) : DEFAULT_LIMIT), String(Number(offset) > 0 ? Math.floor(offset) : 0)]
  );
  return rows.map(row => ({
    type: row.type,
    label: typeLabel(row.type),
    occurredAt: new Date(Number(row.occurred_at_ms)),
    actor: row.actor_username,
    subject: row.subject_username,
    subjectId: row.subject_user_id,
    subjectRole: row.subject_role,
    sponsor: row.sponsor_name,
    detail: row.detail,
  }));
}

async function countEvents(filters = {}) {
  const { where, params } = whereFor(filters);
  const rows = await db.query(`SELECT COUNT(*) AS total FROM (${ALL_EVENTS}) e ${where}`, params);
  return Number((rows[0] && rows[0].total) || 0);
}

module.exports = {
  recordEvent, findEvents, countEvents, typeLabel,
  EVENT_TYPES, CATEGORIES, MAX_DETAIL, DEFAULT_LIMIT,
};
