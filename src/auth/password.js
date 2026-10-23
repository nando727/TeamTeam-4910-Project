const bcrypt = require('bcryptjs');

// Shared hashing helper: login (22199) and admin user creation must both use
// this module so there is exactly one hashing implementation in the app.
const ROUNDS = 12;

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, ROUNDS);
}

// Stored for accounts that have no usable password yet (created by bulk upload,
// claimed through a setup link). It is not a bcrypt hash, so nothing verifies
// against it, and skipping the hash keeps a large upload fast.
const NO_PASSWORD = '!no-password-set';

async function verifyPassword(plaintext, hash) {
  if (typeof hash !== 'string' || !hash.startsWith('$2')) return false;
  return bcrypt.compare(plaintext, hash);
}

module.exports = { hashPassword, verifyPassword, NO_PASSWORD };
