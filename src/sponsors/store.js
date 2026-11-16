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

// Read-only list for the admin "Sponsor status" page.
async function listSponsors() {
  return db.query(
    'SELECT id, name, contact_email AS contactEmail, status FROM sponsors ORDER BY name, id'
  );
}

// One organization in full, or null. Read-only, for the admin organization
// page (sprint 9), which shows an organization's details beside the people
// who belong to it.
async function findSponsorById(id) {
  const rows = await db.query(
    'SELECT id, name, contact_email AS contactEmail, contact_phone AS contactPhone, address, status, created_at AS createdAt FROM sponsors WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

module.exports = { createSponsor, listSponsors, findSponsorById };
