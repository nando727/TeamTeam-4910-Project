const db = require('../db');

// Shared by GET /api/about and the About page. Returns null until seeded.
async function getAbout() {
  const rows = await db.query(
    'SELECT team_name, app_version, release_date, description FROM about ORDER BY id LIMIT 1'
  );
  return rows[0] || null;
}

module.exports = { getAbout };
