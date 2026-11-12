const db = require('../db');
const { hashPassword, verifyPassword, NO_PASSWORD } = require('../auth/password');
const { invalidateSetupTokens } = require('../auth/setup-tokens');
const { invalidateResetTokens } = require('../auth/password-reset');
const { recordPasswordUsed, recentPasswordHashes } = require('../auth/password-history');
const { notifyPasswordChanged, notifiesFor } = require('../auth/password-notice');
const { notifyEmailChanged } = require('../auth/contact-notice');

// How a password came to be set, for the audit log. Anything else is recorded
// as 'unknown' rather than dropped.
const PASSWORD_CHANGE_METHODS = ['profile', 'admin-reset', 'reset-link', 'setup-link'];

const VALID_ROLES = ['driver', 'sponsor', 'admin'];
const USER_STATUSES = ['active', 'disabled', 'revoked'];

// Thrown when a unique value (email or username) is already taken, so both the
// JSON API and the server-rendered pages can map it to a 409 / form error.
class DuplicateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuplicateError';
    this.status = 409;
  }
}

// Stories 22232 (AA-29) and 28211 (AA-79): thrown when the new password is one
// the account has had recently -- the one in force, or one of the last few it
// replaced. A 400 with a sentence the user can act on, not a 500.
class SamePasswordError extends Error {
  constructor(message = 'You have used that password before. Choose one this account has not had recently.') {
    super(message);
    this.name = 'SamePasswordError';
  }
}

// Shared by POST /api/users and the admin "Create user" page. Hashes through
// the single shared helper and enforces unique email + username.
async function createUser({ name, email, username, password, role, sponsorId = null }) {
  const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new DuplicateError('A user with that email already exists.');
  }

  // password null: the account can only be claimed through a setup link.
  const passwordHash = password === null ? NO_PASSWORD : await hashPassword(password);

  try {
    // sponsor_id links a sponsor-role login to its organization; null otherwise.
    const result = await db.query(
      'INSERT INTO users (name, email, username, password_hash, role, sponsor_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, username, passwordHash, role, sponsorId || null]
    );
    // Story 28211 (AA-79): an account created with a password remembers it, so
    // that password is refused later like any other it has had. Without this,
    // the password an administrator typed on the create-user page was forgotten
    // the moment the user chose their own, and could be set straight back.
    //
    // This is the one hash the app writes outside updateUserPassword, and it
    // has to be: there is no account to update yet. Recorded after the INSERT,
    // which is what gives us an id to record it against.
    //
    // An account created without a password has nothing to remember.
    // NO_PASSWORD is a placeholder and not a hash of anything, so storing it
    // would be storing a row that can never match.
    if (passwordHash !== NO_PASSWORD) {
      await recordPasswordUsed(result.insertId, passwordHash);
    }
    return { id: result.insertId, name, email, username, role, sponsorId: sponsorId || null };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new DuplicateError('A user with that username already exists.');
    }
    throw err;
  }
}

async function findUserById(id) {
  const rows = await db.query(
    'SELECT id, name, email, username, role, status, sponsor_id FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

// Username + hash by id, for verifying the current password before a change.
async function findUserCredentials(id) {
  const rows = await db.query('SELECT id, username, password_hash FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

// Stories 22232 (AA-29) and 28211 (AA-79): has this account had this password
// recently? Both halves of one rule, asked as one question: the hash in force
// now, which users holds, and the last PASSWORD_HISTORY_LIMIT hashes it has
// replaced, which password_history holds.
//
// The current password is read from users and not from history, even though it
// is normally the newest history row too. users is the authority on what the
// password is, so the half of this rule that matters most does not rest on the
// newest table being complete -- an account created with a password, or one
// whose rows predate migration 021, is still refused its current password.
//
// Used by updateUserPassword below, and directly by the routes that have
// something to undo if the answer is yes and so cannot wait to be told by a
// thrown error.
//
// An account with no usable password yet holds NO_PASSWORD, which is not a
// bcrypt hash and verifies against nothing, so claiming an account through a
// setup link can never be refused by this.
async function matchesRecentPassword(id, password) {
  const account = await findUserCredentials(id);
  const hashes = account ? [account.password_hash] : [];
  for (const hash of await recentPasswordHashes(id)) {
    // Comparing the same hash twice would cost a second bcrypt pass for nothing.
    if (!hashes.includes(hash)) hashes.push(hash);
  }
  // One comparison per hash, in order, newest first: the likeliest answer is
  // the current password, and a match stops the rest.
  for (const hash of hashes) {
    if (await verifyPassword(password, hash)) return true;
  }
  return false;
}

// Replaces the stored hash. Every caller must run passwordProblems() first;
// this function only hashes and saves.
// Story 22225 (AA-23): whenever a password is set, any setup link for the
// account that was never used is spent.
//
// Without this, an account created with a link and then given a password some
// other way -- an administrator's reset, or the visitor using "forgot
// password" instead of the link they were sent -- kept a working setup link
// until it expired. Anyone holding that link (a forwarded email, a shared
// inbox, the server log it is written to) could set the password again and
// take the account over.
//
// Every password in the app is written here, which is the point: the four
// paths that set one cannot each be relied on to remember this.
//
// The link is spent BEFORE the new password is stored, deliberately. If the
// write fails after it, the worst case is a link an administrator has to
// resend. The other order fails the wrong way round: a failed void leaves a
// live link to an account whose password has just changed.
//
// Audit log requirement: the change is recorded in password_changes. `method`
// says which route set it and `changedBy` who was signed in at the time, both
// of which only the caller knows. An unrecognised or missing method is still
// recorded, as 'unknown': a password change nobody can account for is exactly
// the thing the log exists to show, so it must never be the quiet case.
async function updateUserPassword(id, password, { method, changedBy = null } = {}) {
  // Stories 22232 (AA-29) and 28211 (AA-79): a new password has to be a new
  // password, and not one of the last few either. First, before the links below
  // are spent: a refused change must leave the account exactly as it was. Here
  // rather than in the four routes for the same reason the link voiding is here
  // -- a rule that each caller has to remember is a rule one of them eventually
  // will not.
  if (await matchesRecentPassword(id, password)) throw new SamePasswordError();
  // Hashing first keeps the window between voiding and writing as short as it
  // can be; it touches nothing, so a failure here changes nothing.
  const passwordHash = await hashPassword(password);
  await invalidateSetupTokens(id);
  // Story AA-27 (22229): and any reset link waiting in an inbox. Someone who
  // asked for a link, then got back in another way and changed the password,
  // has left a live link behind in mail they may not control any more. The
  // link that is being used right now is already spent by the time this runs,
  // so a reset through a link voids only the others.
  await invalidateResetTokens(id);
  const result = await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  if (!result.affectedRows) return false;

  // Written after the password, so the log only claims changes that happened.
  // The two statements are not in one transaction: if this insert fails the
  // request errors out with the password already changed and no record of it.
  // A transaction is the real answer and db.js would need a helper for one.
  await recordPasswordChange(id, changedBy, method);

  // Story 28211 (AA-79): and the hash is remembered, so this password cannot
  // come back round again later. After the audit row, deliberately: the log is
  // a graded requirement and nothing added here should be able to cost it.
  await recordPasswordUsed(id, passwordHash);

  // Story AA-25 (22227): and the owner is told, after the change is both made
  // and recorded, so the mail can never announce something that did not
  // happen. The account is loaded here rather than in the notice module to
  // keep that module clear of the database; the lookup is skipped for the
  // methods that send nothing, so claiming a new account costs no extra query.
  //
  // Sending cannot fail this function: sendMail turns a dead mail server into
  // a logged error. A password the owner asked to change stays changed even
  // when the notice does not go out.
  if (notifiesFor(method)) {
    await notifyPasswordChanged(await findUserById(id), { method });
  }
  return true;
}

// Never the password and never the hash: whose password changed, who changed
// it, how, and when (the column defaults to the database's clock).
async function recordPasswordChange(userId, changedByUserId, method) {
  await db.query(
    'INSERT INTO password_changes (user_id, changed_by_user_id, method) VALUES (?, ?, ?)',
    [userId, changedByUserId, PASSWORD_CHANGE_METHODS.includes(method) ? method : 'unknown']
  );
}

// Failed sign-ins for a username in the last 24 hours. Read-only: the audit
// log is never modified, not even after an admin resets the password.
async function countRecentFailedLogins(username) {
  const rows = await db.query(
    'SELECT COUNT(*) AS count FROM login_attempts WHERE username = ? AND success = 0 AND attempted_at > NOW() - INTERVAL 1 DAY',
    [username]
  );
  return Number((rows[0] && rows[0].count) || 0);
}

// Read-only list for the admin "Manage users" page (every account) and the
// "Admin accounts" page (role = 'admin').
async function listUsers({ role } = {}) {
  if (role === undefined) {
    return db.query('SELECT id, username, role, status FROM users ORDER BY username, id');
  }
  if (!VALID_ROLES.includes(role)) throw new Error(`Invalid user role: ${role}`);
  return db.query('SELECT id, username, role, status FROM users WHERE role = ? ORDER BY username, id', [role]);
}

// ---- Manage users: search, filters, paging (sprint 9) ----------------------
//
// The admin list used to be every account in one page, with no way to find
// one. These build the same list with a search box and three filters, and
// count it for paging. The two share one WHERE clause so the count and the
// page can never describe different sets of rows.
//
// LIKE treats % and _ as wildcards; escape them so typed text is literal.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

// A driver belongs to an organization through driver_sponsors; a sponsor user
// belongs through users.sponsor_id. An account matches the sponsor filter if
// either is true, so one filter answers "who belongs to this organization?"
// for both kinds of account. Takes the sponsor id twice, in this order.
const BELONGS_TO_SPONSOR = `(
  u.sponsor_id = ? OR EXISTS (
    SELECT 1 FROM driver_sponsors ds WHERE ds.driver_id = u.id AND ds.sponsor_id = ?
  )
)`;

function userFilter({ search = null, role = null, status = null, sponsorId = null } = {}) {
  const conditions = [];
  const params = [];
  if (search) {
    // One box, three columns: whichever the administrator happens to know.
    conditions.push('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
    const pattern = `%${escapeLike(search)}%`;
    params.push(pattern, pattern, pattern);
  }
  if (role && VALID_ROLES.includes(role)) { conditions.push('u.role = ?'); params.push(role); }
  if (status && USER_STATUSES.includes(status)) { conditions.push('u.status = ?'); params.push(status); }
  if (sponsorId) { conditions.push(BELONGS_TO_SPONSOR); params.push(sponsorId, sponsorId); }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')} ` : '', params };
}

// One page of the filtered list. `limit` and `offset` are validated integers
// from the route, never user text, so they are inlined.
//
// The organization column is a subquery per row rather than a join, because a
// driver may belong to several and a join would repeat the account once per
// membership -- which would also make the count disagree with the page.
async function searchUsers(filters = {}, { limit = 25, offset = 0 } = {}) {
  const { where, params } = userFilter(filters);
  const paging = ` LIMIT ${Number.isInteger(limit) && limit > 0 ? limit : 25} OFFSET ${Number.isInteger(offset) && offset > 0 ? offset : 0}`;
  return db.query(
    'SELECT u.id, u.name, u.email, u.username, u.role, u.status, u.sponsor_id AS sponsorId, ' +
      'CASE WHEN u.role = \'sponsor\' THEN (SELECT s.name FROM sponsors s WHERE s.id = u.sponsor_id) ' +
      'ELSE (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR \', \') FROM driver_sponsors ds ' +
      'JOIN sponsors s ON s.id = ds.sponsor_id WHERE ds.driver_id = u.id) END AS sponsorNames ' +
      'FROM users u ' + where + 'ORDER BY u.username, u.id' + paging,
    params
  );
}

async function countUsers(filters = {}) {
  const { where, params } = userFilter(filters);
  const rows = await db.query('SELECT COUNT(*) AS total FROM users u ' + where, params);
  return Number((rows[0] && rows[0].total) || 0);
}

// ---- Changing a role (sprint 9) -------------------------------------------

// How many administrators could sign in right now. The last one cannot be
// demoted: an installation with no active admin has no way back in, because
// every page that could fix it is behind the admin guard.
async function countActiveAdmins() {
  const rows = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
  return Number((rows[0] && rows[0].total) || 0);
}

// What changing this account's role would remove, counted before anything is
// written, so the confirmation page can list it exactly rather than warn
// vaguely. Also counts what is kept, because "your purchases stay on record"
// is the half of this people most want to hear.
//
// Everything here is tied to the role the account is leaving: memberships and
// applications belong to a driver, the organization link belongs to a sponsor
// user. An admin has no role-specific rows of its own.
async function roleChangeImpact(id, newRole) {
  const user = await findUserById(id);
  if (!user || user.role === newRole) return null;

  const impact = { from: user.role, to: newRole, removes: [], keeps: [] };
  if (user.role === 'driver') {
    const [memberships] = await db.query(
      'SELECT COUNT(*) AS total, COALESCE(SUM(point_balance), 0) AS points FROM driver_sponsors WHERE driver_id = ?',
      [id]
    );
    const [applications] = await db.query('SELECT COUNT(*) AS total FROM sponsor_applications WHERE driver_id = ?', [id]);
    const [preferences] = await db.query('SELECT COUNT(*) AS total FROM driver_alert_preferences WHERE driver_id = ?', [id]);
    const [removalAlerts] = await db.query('SELECT COUNT(*) AS total FROM sponsor_removal_alerts WHERE driver_id = ?', [id]);
    const memberCount = Number(memberships.total);
    const points = Number(memberships.points);
    if (memberCount) {
      impact.removes.push({
        key: 'memberships', count: memberCount,
        text: `${memberCount} sponsorship${memberCount === 1 ? '' : 's'}, including ${points.toLocaleString('en-US')} point${points === 1 ? '' : 's'} held with ${memberCount === 1 ? 'that sponsor' : 'those sponsors'}`,
      });
    }
    if (Number(applications.total)) {
      impact.removes.push({ key: 'applications', count: Number(applications.total), text: `${applications.total} sponsor application${Number(applications.total) === 1 ? '' : 's'}, with their decisions and reasons` });
    }
    if (Number(preferences.total)) {
      impact.removes.push({ key: 'preferences', count: Number(preferences.total), text: 'their point-alert preference' });
    }
    if (Number(removalAlerts.total)) {
      impact.removes.push({ key: 'removalAlerts', count: Number(removalAlerts.total), text: `${removalAlerts.total} sponsor-removal alert${Number(removalAlerts.total) === 1 ? '' : 's'}` });
    }
    const [transactions] = await db.query('SELECT COUNT(*) AS total FROM point_transactions WHERE driver_id = ?', [id]);
    const [purchases] = await db.query('SELECT COUNT(*) AS total FROM purchases WHERE driver_id = ?', [id]);
    if (Number(transactions.total)) impact.keeps.push(`${transactions.total} point change${Number(transactions.total) === 1 ? '' : 's'} in the point history`);
    if (Number(purchases.total)) impact.keeps.push(`${purchases.total} purchase${Number(purchases.total) === 1 ? '' : 's'} in the sales, fee, and invoice reports`);
  }
  if (user.role === 'sponsor' && user.sponsor_id) {
    const [sponsor] = await db.query('SELECT name FROM sponsors WHERE id = ?', [user.sponsor_id]);
    impact.removes.push({ key: 'sponsorLink', count: 1, text: `their link to ${sponsor ? sponsor.name : 'their organization'}, so they will no longer act for it` });
  }
  impact.keeps.push('the account itself, its username, email, and password');
  return impact;
}

// Changes the role and clears away what belonged to the old one, all or
// nothing. The rows deleted here are the ones roleChangeImpact counted, so
// the confirmation page and the database can never disagree about what went.
//
// Point history and purchases are deliberately left alone: they are the
// financial record the sales, fee, and invoice reports are built on, and a
// role change is not a reason to rewrite what a sponsor was billed for.
//
// The row is locked and the role re-read inside the transaction, so two
// administrators changing the same account at once cannot both act on a role
// that has already changed.
async function changeUserRole(id, newRole) {
  if (!VALID_ROLES.includes(newRole)) throw new Error(`Invalid user role: ${newRole}`);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return { changed: false, reason: 'missing' };
    }
    const from = rows[0].role;
    if (from === newRole) {
      await conn.rollback();
      return { changed: false, reason: 'same', from };
    }

    const removed = {};
    if (from === 'driver') {
      const [memberships] = await conn.execute('DELETE FROM driver_sponsors WHERE driver_id = ?', [id]);
      const [applications] = await conn.execute('DELETE FROM sponsor_applications WHERE driver_id = ?', [id]);
      const [preferences] = await conn.execute('DELETE FROM driver_alert_preferences WHERE driver_id = ?', [id]);
      const [removalAlerts] = await conn.execute('DELETE FROM sponsor_removal_alerts WHERE driver_id = ?', [id]);
      removed.memberships = memberships.affectedRows;
      removed.applications = applications.affectedRows;
      removed.preferences = preferences.affectedRows;
      removed.removalAlerts = removalAlerts.affectedRows;
    }
    // A sponsor user's organization link goes whichever role they move to; an
    // account that is not a sponsor user must not keep acting for one.
    if (from === 'sponsor') {
      const [unlinked] = await conn.execute('UPDATE users SET sponsor_id = NULL WHERE id = ?', [id]);
      removed.sponsorLink = unlinked.affectedRows;
    }
    await conn.execute('UPDATE users SET role = ? WHERE id = ?', [newRole, id]);
    await conn.commit();
    return { changed: true, from, to: newRole, removed };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Sets an account's status; returns true when a row was updated.
async function updateUserStatus(id, status) {
  if (!USER_STATUSES.includes(status)) throw new Error(`Invalid user status: ${status}`);
  const result = await db.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  return result.affectedRows > 0;
}

// Updates the editable profile fields and returns the fresh row.
async function updateUserContact(id, { name, email }) {
  const current = await findUserById(id);
  if (!current) return null;

  // Only a changed email is checked, so an account keeps working even if an
  // older row already shares its address.
  if (email !== current.email) {
    const taken = await db.query('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id]);
    if (taken.length > 0) {
      throw new DuplicateError('A user with that email already exists.');
    }
  }

  try {
    await db.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new DuplicateError('A user with that email already exists.');
    }
    throw err;
  }

  const updated = await findUserById(id);

  // Story AA-25 (22227): a changed address is announced to the address being
  // replaced, so the password notice cannot be routed away from the owner in
  // silence first. See src/auth/contact-notice.js.
  //
  // Both rows were already loaded for this function's own work, so the notice
  // costs no extra query. As with the password notice, a send that fails is
  // logged by sendMail and does not undo the change.
  await notifyEmailChanged(current, updated);
  return updated;
}

// Backlog AA-13: end every session for an account at once.
//
// Sessions are held in memory, so there is no list to delete. Each session
// records when it was issued; stamping this column with the current time means
// every session issued before now is refused on its next request, wherever it
// is. Returns the timestamp that was set.
// Returns the cutoff as epoch milliseconds, so a caller that wants to keep one
// session alive can stamp it just after. UNIX_TIMESTAMP reads the column in the
// database's own zone, the mirror of FROM_UNIXTIME below; a plain SELECT would
// hand Node a Date reinterpreted in the machine's local zone.
async function revokeSessions(id) {
  // NOW(3): whole seconds are too coarse to order against a login in the
  // same second. See migration 013.
  await db.query('UPDATE users SET sessions_valid_from = NOW(3) WHERE id = ?', [id]);
  const rows = await db.query(
    'SELECT UNIX_TIMESTAMP(sessions_valid_from) * 1000 AS cutoff_ms FROM users WHERE id = ?',
    [id]
  );
  return rows[0] ? Number(rows[0].cutoff_ms) : null;
}

// Was this account revoked after the given session was issued?
//
// MySQL does the comparison, deliberately. The column is a DATETIME written by
// NOW(), so it carries the database's wall-clock time with no zone attached:
// read into Node it becomes a Date in the machine's local zone, which on a UTC
// database and an eastern laptop lands hours away and refuses every session.
// Handing MySQL the epoch instead keeps both sides in the database's own zone.
//
// A session with no issue time predates this feature, and 0 maps to 1970, so
// any cutoff is later and the session is refused.
async function sessionsRevokedSince(id, issuedAtMs) {
  const rows = await db.query(
    'SELECT sessions_valid_from > FROM_UNIXTIME(? / 1000) AS revoked FROM users WHERE id = ?',
    [issuedAtMs, id]
  );
  return Boolean(rows[0] && rows[0].revoked);
}

module.exports = {
  VALID_ROLES, USER_STATUSES, DuplicateError, SamePasswordError,
  createUser, findUserById, findUserCredentials, updateUserContact, updateUserPassword,
  matchesRecentPassword,
  PASSWORD_CHANGE_METHODS,
  listUsers, updateUserStatus, countRecentFailedLogins,
  revokeSessions, sessionsRevokedSince,
  searchUsers, countUsers, countActiveAdmins, roleChangeImpact, changeUserRole,
};
