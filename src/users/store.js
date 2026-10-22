const db = require('../db');
const { hashPassword } = require('../auth/password');

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

// Shared by POST /api/users and the admin "Create user" page. Hashes through
// the single shared helper and enforces unique email + username.
async function createUser({ name, email, username, password, role }) {
  const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new DuplicateError('A user with that email already exists.');
  }

  const passwordHash = await hashPassword(password);

  try {
    const result = await db.query(
      'INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, username, passwordHash, role]
    );
    return { id: result.insertId, name, email, username, role };
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

// Replaces the stored hash. Every caller must run passwordProblems() first;
// this function only hashes and saves.
async function updateUserPassword(id, password) {
  const passwordHash = await hashPassword(password);
  const result = await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  return result.affectedRows > 0;
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

  return findUserById(id);
}

// Backlog AA-13: end every session for an account at once.
//
// Sessions are held in memory, so there is no list to delete. Each session
// records when it was issued; stamping this column with the current time means
// every session issued before now is refused on its next request, wherever it
// is. Returns the timestamp that was set.
async function revokeSessions(id) {
  // NOW(3): whole seconds are too coarse to order against a login in the
  // same second. See migration 013.
  await db.query('UPDATE users SET sessions_valid_from = NOW(3) WHERE id = ?', [id]);
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
  VALID_ROLES, USER_STATUSES, DuplicateError,
  createUser, findUserById, findUserCredentials, updateUserContact, updateUserPassword,
  listUsers, updateUserStatus, countRecentFailedLogins,
  revokeSessions, sessionsRevokedSince,
};
