// Story 22255: single-use, expiring links that let a newly created user set
// their own password. The admin never chooses or sees it.
//
// The raw token lives only in the link. The database stores its SHA-256 hash,
// so a database dump can't be used to claim an account — the same reasoning
// behind hashing passwords.

const { randomBytes, createHash } = require('crypto');
const db = require('../db');

const DEFAULT_LINK_HOURS = 48;

function linkLifetimeHours() {
  const hours = Number.parseFloat(process.env.SETUP_LINK_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LINK_HOURS;
}

function hashToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex');
}

// Returns the raw token; the caller puts it in the link and then forgets it.
async function issueSetupToken(userId) {
  const rawToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + linkLifetimeHours() * 60 * 60 * 1000);

  await db.query(
    'INSERT INTO setup_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, hashToken(rawToken), expiresAt]
  );

  return rawToken;
}

// Absolute URL, built from the request, so the link works on localhost now and
// from the deployed host later without any configuration.
function setupLinkFor(req, rawToken) {
  return `${req.protocol}://${req.get('host')}/setup/${rawToken}`;
}

// Returns the token row only when it is real, unused, and unexpired.
async function findValidToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;

  const rows = await db.query(
    'SELECT id, user_id, token_hash, expires_at, used_at FROM setup_tokens WHERE token_hash = ?',
    [hashToken(rawToken)]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

// Marks a link as spent. Returns false when it was already used, so a double
// submit can't set a password twice.
async function consumeToken(tokenId) {
  const result = await db.query(
    'UPDATE setup_tokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
    [tokenId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  issueSetupToken, setupLinkFor, findValidToken, consumeToken,
  hashToken, linkLifetimeHours,
};
