// Story AA-71: signed-in sessions live in MySQL, not in this process's memory.
//
// express-session's default store is a JavaScript object held by the running
// Node process. That is fine on a laptop and wrong everywhere else:
//
//   * every deployment restarts the process, so shipping a change signed out
//     everyone who was using the site;
//   * two instances behind one load balancer would each only recognise the
//     sessions they created, so a visitor would appear signed out at random.
//
// The sessions table (migration 016) gives every instance the same view, and a
// restart no longer loses anything.
//
// Writes go through src/db.js like everything else, so the session id is always
// a query parameter and never built into SQL.

const { Store } = require('express-session');
const db = require('../db');
const { idleLimitMs } = require('./session-timeout');

const DEFAULT_ROW_HOURS = 24;
const DEFAULT_PRUNE_MINUTES = 60;

// How long a session row is kept. This is NOT the session's own lifetime:
// sessionTimeout (src/auth/session-timeout.js) decides that from lastActivity,
// and it is the only thing that should.
//
// The row is deliberately kept well past the idle limit. If the row vanished
// at the idle limit instead, a visitor coming back to an expired session would
// arrive with no session at all, and the site cannot tell that apart from
// someone who was never signed in — so they would be dropped on the login page
// with no explanation, losing the "your session expired" message that story
// 22208 exists to provide. Keeping the row means the expiry is explained.
function rowLifetimeMs() {
  const hours = Number.parseFloat(process.env.SESSION_ROW_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_ROW_HOURS;
  // Never shorter than two idle windows, however it is configured, so the
  // reasoning above holds even for a long idle limit or a short row lifetime.
  return Math.max(safe * 60 * 60 * 1000, idleLimitMs() * 2);
}

// A session cookie with an explicit expiry sets the row's expiry; ours has no
// maxAge (it dies with the browser), so the row lifetime above applies.
function expiresAtMs(session) {
  const cookieExpiry = session && session.cookie && session.cookie.expires;
  const parsed = cookieExpiry ? new Date(cookieExpiry).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now() + rowLifetimeMs();
}

// Expiries cross between MySQL and Node, which is where this project has been
// bitten twice: a DATETIME arrives with no zone and Node rebuilds it in the
// machine's local zone, so a UTC database and an eastern laptop disagree by
// four hours. Both directions stay inside SQL here — written with
// FROM_UNIXTIME, compared against NOW() — so there is nothing to misread.
const EXPIRES_AT = 'FROM_UNIXTIME(? / 1000)';

class MysqlSessionStore extends Store {
  // express-session hands us a callback rather than awaiting a promise, so
  // every path has to end in exactly one done() call.
  get(sid, done) {
    db.query(
      'SELECT data FROM sessions WHERE session_id = ? AND expires_at > NOW()',
      [sid]
    ).then(rows => {
      if (!rows[0]) return done(null, null);
      let session;
      try {
        session = JSON.parse(rows[0].data);
      } catch (err) {
        // Unreadable row: drop it and treat the visitor as signed out rather
        // than failing every request they make from now on.
        return this.destroy(sid, () => done(null, null));
      }
      done(null, session);
    }).catch(done);
  }

  set(sid, session, done) {
    const expiry = expiresAtMs(session);
    db.query(
      `INSERT INTO sessions (session_id, data, expires_at) VALUES (?, ?, ${EXPIRES_AT}) ` +
        `ON DUPLICATE KEY UPDATE data = ?, expires_at = ${EXPIRES_AT}`,
      [sid, JSON.stringify(session), expiry, JSON.stringify(session), expiry]
    ).then(() => done(null)).catch(done);
  }

  // Called for a session that was read but not changed. Ours change on nearly
  // every request (lastActivity slides forward), so this rarely runs — but
  // without it an untouched session could age out while still in use.
  touch(sid, session, done) {
    db.query(
      `UPDATE sessions SET expires_at = ${EXPIRES_AT} WHERE session_id = ?`,
      [expiresAtMs(session), sid]
    ).then(() => done(null)).catch(done);
  }

  destroy(sid, done) {
    db.query('DELETE FROM sessions WHERE session_id = ?', [sid])
      .then(() => done(null)).catch(done);
  }
}

// Expired rows are never read again — get() filters them out in SQL — but
// nothing deletes them either, and every sign-in writes one. Left alone the
// table would only ever grow.
async function pruneExpiredSessions() {
  const result = await db.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  return (result && result.affectedRows) || 0;
}

function pruneIntervalMs() {
  const minutes = Number.parseFloat(process.env.SESSION_PRUNE_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PRUNE_MINUTES;
  return safe * 60 * 1000;
}

// Started by src/server.js rather than by the app itself, so importing the app
// in a test never leaves a timer running.
//
// A failed sweep is logged and nothing more: expired rows are already ignored,
// so not clearing them is untidy rather than harmful, and it must never be a
// reason for the site to stop serving requests.
function startPruning(log = console) {
  const sweep = () => pruneExpiredSessions().catch(err => {
    log.error('Could not clear expired sessions:', err.message);
  });

  const timer = setInterval(sweep, pruneIntervalMs());
  // Nothing should stay alive just to wait for the next sweep.
  if (timer.unref) timer.unref();
  // One sweep now, so a deployment tidies up without waiting an hour.
  sweep();
  return timer;
}

module.exports = {
  MysqlSessionStore,
  rowLifetimeMs,
  pruneExpiredSessions,
  pruneIntervalMs,
  startPruning,
};
