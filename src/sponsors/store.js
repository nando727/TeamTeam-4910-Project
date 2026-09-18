const db = require('../db');
const { DuplicateError } = require('../users/store');

// Shared by POST /api/sponsors and the admin "Create sponsor" page.
async function createSponsor({ name, contactEmail, contactPhone, address }) {
  try {
    const result = await db.query(
      'INSERT INTO sponsors (name, contact_email, contact_phone, address) VALUES (?, ?, ?, ?)',
      [name, contactEmail, contactPhone || null, address]
    );
    return {
      id: result.insertId,
      name,
      contactEmail,
      contactPhone: contactPhone || null,
      address,
    };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new DuplicateError('A sponsor with that contact email already exists.');
    }
    throw err;
  }
}

module.exports = { createSponsor };
