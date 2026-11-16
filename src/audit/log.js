const db = require('../db');

// Story AA-55 (22263): the one door into the audit log. Everything the audit
// requirement names -- login attempts, password changes, point changes, driver
// application decisions -- is written through here, into audit_events
// (db/migrations/022_audit_events.sql), in one shape.
//
// One function and one statement, for the same reason updateUserPassword is
// one function: a record that four callers each write their own way is four
// shapes to read back and four places for a field to go missing.

// The categories the project description names, and the event types that make
// up each one. The spec's audit log reports are filtered "by audit log
// category", so the categories are the fixed, user-facing list and event_type
// is the finer-grained thing underneath it.
//
// Some of these types have no writer yet -- login attempts arrive in story
// AA-55's later work, point changes and application decisions after that. The
// names are declared here first so the reader is whole: a category that
// matches nothing is a report that quietly says nothing happened.
//
// 'other' exists so that every row in the table belongs to exactly one
// category. recordEvent below records an unrecognised type rather than
// dropping it, and a filter that could hide those rows forever would undo
// that. tests/audit-reader.test.js checks nothing escapes the categories.
const EVENT_CATEGORIES = {
  'driver-applications': ['application.decided'],
  'point-changes': ['points.changed'],
  'password-changes': ['password.changed'],
  'login-attempts': ['login.succeeded', 'login.failed'],
  other: ['unknown'],
};

// Every type any writer may use, derived rather than listed twice: a new
// writer adds its type to a category above, in the commit that adds the
// writer, and both the writer and the reader know about it at once.
const EVENT_TYPES = Object.values(EVENT_CATEGORIES).flat();

/* detail is VARCHAR(2048), wide enough for a rejection_reason (2000) whole
 * a longer one is cut rather than refused, and the cut is marked so nobody
   reads a truncated reason as the whole of it
*/
const MAX_DETAIL = 2048;
const ELLIPSIS = '...';

// How many rows a single read returns. The reports this feeds are filtered by
// date range, so this is a ceiling against a runaway query, not paging.
const DEFAULT_LIMIT = 500;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function detailText(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail);
  if (text.length <= MAX_DETAIL) return text;
  return text.slice(0, MAX_DETAIL - ELLIPSIS.length) + ELLIPSIS;
}

/* appends one event, returns its id
 * occurred_at is deliberately absent from the statement so the database's
   clock sets it and no caller can choose a time (aa-59)
 * throws if the insert fails, and callers do not catch it -- a record that
   goes missing quietly is the one failure this table cannot tolerate
*/
async function recordEvent({ type, actorId = null, subjectId = null, sponsorId = null, detail = null } = {}, conn = null) {
  const known = EVENT_TYPES.includes(type);
  // an unrecognised type is recorded as 'unknown' with what the caller said
  // kept in the detail, never dropped
  const text = known ? detail : [`type=${type}`, detail].filter(Boolean).join(' ');
  const sql = 'INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, sponsor_id, detail) '
    + 'VALUES (?, ?, ?, ?, ?)';
  const params = [known ? type : 'unknown', actorId, subjectId, sponsorId, detailText(text)];

  // conn is the caller's open transaction. adjustPoints and setApplicationStatus
  // each run on their own connection, and db.query takes a different one from
  // the pool -- the row would commit apart from the change it records, so a
  // rollback would leave a record of something that never happened
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await db.query(sql, params);
  return result.insertId;
}

// Story AA-57 (22265): reading the log back without losing the records that
// have no sponsor, no actor, or no subject.
//
// Three of audit_events' columns are nullable because the requirement makes
// them nullable: a password change and a login attempt have no sponsor in the
// list of fields the spec asks for, a reset-link password change has no signed
// in actor, and a failed login for a username that does not exist has no
// subject at all. Every obvious way to write this query deletes those rows
// from the report without saying so:
//
//   WHERE sponsor_id = ?        a NULL is not equal to anything, not even NULL
//   JOIN users ON id = actor_…  an inner join drops the row, not just the name
//   event_type IN (…)           a category list that forgot a type
//
// So: the joins are LEFT joins, a sponsor is matched through the drivers it
// sponsors as well as the column, and the category lists are checked by a
// test. Reading the whole log back is the only way anyone finds out a record
// was never written, which is why this is a story of its own.
//
// Returns the newest first, with names rather than ids: the UI may not make
// anyone deal in computer-generated ids, and a report of numbers is unreadable
// anyway. occurred_at crosses as epoch milliseconds (story AA-59) because a
// DATETIME handed to the driver comes back as a local-midnight Date.
async function findEvents({ sponsorId = null, category = null, from = null, to = null, limit = DEFAULT_LIMIT } = {}) {
  const where = [];
  const params = [];

  // An admin asking for all sponsors passes nothing here and the column is
  // never mentioned, so sponsor-less rows stay in. Asking for one sponsor
  // means that sponsor's business: records stamped with the organization, plus
  // records about one of its drivers, which is where the sponsor-less password
  // changes and login attempts of its own drivers come back.
  //
  // A sponsor-less record about nobody in particular is in no sponsor's view
  // by the same rule, and that is correct rather than a leak of the same bug:
  // the spec restricts a sponsor's report to the sponsor's drivers. The admin
  // report is the one that must show every row, and it does.
  if (sponsorId !== null && sponsorId !== undefined) {
    where.push('(ae.sponsor_id = ? OR EXISTS ('
      + 'SELECT 1 FROM driver_sponsors ds '
      + ' WHERE ds.driver_id = ae.subject_user_id AND ds.sponsor_id = ?))');
    params.push(sponsorId, sponsorId);
  }

  if (category !== null && category !== undefined) {
    const types = EVENT_CATEGORIES[category];
    // A category nobody recognises is refused rather than matched against
    // nothing. An empty audit report and a misspelled filter look identical on
    // screen, and only one of them means nothing happened.
    if (!types) throw new UnknownCategoryError(category);
    // The placeholders are counted from our own constant above and the values
    // are bound, so no part of this string comes from a request.
    where.push(`ae.event_type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }

  // Dates arrive as plain YYYY-MM-DD, the way a report's date range is picked,
  // and the comparison stays in SQL so the database's clock is the only clock
  // involved. `to` is inclusive of its whole day: a range ending today that
  // compared <= '2026-11-09' would hide everything that happened after
  // midnight this morning, which is most of what anyone looks for.
  if (from !== null && from !== undefined) {
    if (!DATE_ONLY.test(from)) throw new BadDateError(from);
    where.push('ae.occurred_at >= ?');
    params.push(from);
  }
  if (to !== null && to !== undefined) {
    if (!DATE_ONLY.test(to)) throw new BadDateError(to);
    where.push('ae.occurred_at < ? + INTERVAL 1 DAY');
    params.push(to);
  }

  const rows = await db.query(
    'SELECT ae.id, ae.event_type, ae.detail, '
      + 'UNIX_TIMESTAMP(ae.occurred_at) * 1000 AS occurred_at_ms, '
      + 'actor.username AS actor_username, '
      + 'subject.username AS subject_username, '
      + 'sponsor.name AS sponsor_name '
      + '  FROM audit_events ae '
      + '  LEFT JOIN users actor ON actor.id = ae.actor_user_id '
      + '  LEFT JOIN users subject ON subject.id = ae.subject_user_id '
      + '  LEFT JOIN sponsors sponsor ON sponsor.id = ae.sponsor_id '
      + (where.length ? ` WHERE ${where.join(' AND ')} ` : ' ')
      + ' ORDER BY ae.occurred_at DESC, ae.id DESC '
      + ' LIMIT ?',
    [...params, Number(limit) || DEFAULT_LIMIT]
  );

  return rows.map(row => ({
    id: row.id,
    type: row.event_type,
    category: categoryOf(row.event_type),
    occurredAtMs: Number(row.occurred_at_ms),
    actor: row.actor_username,
    subject: row.subject_username,
    sponsor: row.sponsor_name,
    detail: row.detail,
  }));
}

// Which category a stored type belongs to. A type with no category would be a
// row no filtered report can reach, so an unrecognised one reads as 'other'
// rather than null -- the same choice recordEvent makes going the other way.
function categoryOf(type) {
  const found = Object.keys(EVENT_CATEGORIES).find(name => EVENT_CATEGORIES[name].includes(type));
  return found || 'other';
}

class UnknownCategoryError extends Error {
  constructor(category) {
    super(`Unknown audit log category: ${category}`);
    this.name = 'UnknownCategoryError';
  }
}

class BadDateError extends Error {
  constructor(value) {
    super(`Audit log dates must be YYYY-MM-DD, got: ${value}`);
    this.name = 'BadDateError';
  }
}

module.exports = {
  recordEvent, findEvents, categoryOf,
  EVENT_TYPES, EVENT_CATEGORIES, MAX_DETAIL, DEFAULT_LIMIT,
  UnknownCategoryError, BadDateError,
};
