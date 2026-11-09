const { randomBytes, createHash } = require('crypto');
const db = require('../db');

// Forgot-password tokens. The raw token goes only into the link; the table
// holds its SHA-256 hash, so a database read cannot be turned into a working
// link. Tokens expire after 30 minutes and are spent on first use.
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const EXPIRY_MINUTES = 30;


const DEFAULT_MAX_REQUESTS = 3;
const DEFAULT_WINDOW_MINUTES = 15;

function requestPolicy() {
  const max = Number.parseInt(process.env.RESET_LINK_MAX_REQUESTS, 10);
  const minutes = Number.parseFloat(process.env.RESET_LINK_WINDOW_MINUTES);
  return {
    maxRequests: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_REQUESTS,
    windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES,
  };
}

// Counted from the rows the requests already leave behind, so there is no new
// table and nothing to clean up. created_at is the database's own clock, and
// the comparison stays in SQL where it cannot be rebuilt in another zone.
async function recentRequestCount(userId, windowMinutes) {
  const rows = await db.query(
    'SELECT COUNT(*) AS requests FROM password_resets ' +
      'WHERE user_id = ? AND created_at > NOW() - INTERVAL ? MINUTE',
    [userId, windowMinutes]
  );
  return Number((rows[0] && rows[0].requests) || 0);
}

// Whether this account has had its allowance of links for now.
async function requestsExhausted(userId) {
  const { maxRequests, windowMinutes } = requestPolicy();
  return (await recentRequestCount(userId, windowMinutes)) >= maxRequests;
}

const hashToken = token => createHash('sha256').update(token).digest('hex');

async function invalidateResetTokens(userId) {
  const result = await db.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  return result.affectedRows || 0;
}

// Issues a fresh token for a user and retires any earlier unused ones, so at
// most one live link exists per account. Returns the raw token for the link.
async function createResetToken(userId) {
  await invalidateResetTokens(userId);
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  await db.query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL ? MINUTE)',
    [userId, hashToken(token), EXPIRY_MINUTES]
  );
  return token;
}

// The reset row plus the account it belongs to, or null when the token is
// malformed, unknown, already used, or expired. Expiry is judged by the
// database clock, the same clock that set it.
async function findValidReset(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const rows = await db.query(
    'SELECT r.id, r.user_id AS userId, u.username, u.status FROM password_resets r ' +
      'JOIN users u ON u.id = r.user_id ' +
      'WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()',
    [hashToken(token)]
  );
  return rows[0] || null;
}

// Marks a token used. Returns false if another request spent it first, so two
// simultaneous submits cannot both succeed.
async function consumeReset(id) {
  const result = await db.query(
    'UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL AND expires_at > NOW()',
    [id]
  );
  return result.affectedRows > 0;
}

module.exports = {
  createResetToken, findValidReset, consumeReset, hashToken, invalidateResetTokens,
  requestsExhausted, recentRequestCount, requestPolicy,
  TOKEN_PATTERN, EXPIRY_MINUTES,
};
