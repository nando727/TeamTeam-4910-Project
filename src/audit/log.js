const db = require('../db');

// Story AA-55 (22263): the one door into the audit log. Everything the audit
// requirement names -- login attempts, password changes, point changes, driver
// application decisions -- is written through here, into audit_events
// (db/migrations/022_audit_events.sql), in one shape.
//
// One function and one statement, for the same reason updateUserPassword is
// one function: a record that four callers each write their own way is four
// shapes to read back and four places for a field to go missing.

// The events the app writes. VARCHAR in the table, a list here: a new writer
// adds its type to this list in the commit that adds the writer, so the column
// stays enumerable without a migration standing in the way.
const EVENT_TYPES = ['password.changed'];

// detail is VARCHAR(255). A long one is cut rather than refused -- losing the
// tail of a reason is a smaller loss than failing the thing being recorded --
// and the cut is marked so nobody reads a truncated reason as the whole of it.
const MAX_DETAIL = 255;
const ELLIPSIS = '...';

function detailText(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail);
  if (text.length <= MAX_DETAIL) return text;
  return text.slice(0, MAX_DETAIL - ELLIPSIS.length) + ELLIPSIS;
}

// Appends one event. Returns its id.
//
// occurred_at is deliberately absent from the statement: the database's own
// clock sets it, so every row in the table is timed by the same clock and
// nothing can write a time of its own choosing (story AA-59).
//
// This throws if the insert fails, and callers do not catch it. An audit
// record that goes missing quietly is the one failure this table cannot
// tolerate -- a request that errors out is visible, and a log with a hole in
// it is not. Where that leaves a change made with nothing recorded, the
// README says so plainly rather than the code pretending otherwise.
async function recordEvent({ type, actorId = null, subjectId = null, sponsorId = null, detail = null } = {}) {
  const known = EVENT_TYPES.includes(type);
  // An event nobody can account for is exactly what an audit log exists to
  // show, so an unrecognised type is recorded as 'unknown' with what the
  // caller said kept in the detail. Never dropped, and never let through to
  // make the column mean less than it says.
  const text = known ? detail : [`type=${type}`, detail].filter(Boolean).join(' ');
  const result = await db.query(
    'INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, sponsor_id, detail) '
      + 'VALUES (?, ?, ?, ?, ?)',
    [known ? type : 'unknown', actorId, subjectId, sponsorId, detailText(text)]
  );
  return result.insertId;
}

module.exports = { recordEvent, EVENT_TYPES, MAX_DETAIL };
