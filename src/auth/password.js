const bcrypt = require('bcryptjs');

// Shared hashing helper: login (22199) and admin user creation must both use
// this module so there is exactly one hashing implementation in the app.
const ROUNDS = 12;

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, ROUNDS);
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

module.exports = { hashPassword, verifyPassword };
