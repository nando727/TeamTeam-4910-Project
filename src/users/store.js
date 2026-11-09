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
};
