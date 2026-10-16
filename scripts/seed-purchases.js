// Sample purchases for the admin "Sponsor fees" report (story AD-11).
// Usage: npm run db:seed:purchases
//
// Inserts purchases for the demo drivers under Demo Sponsor, spread over this
// month and the previous two months, so the fee report has a few months to
// pick from. Run `npm run db:seed:points` first so driver2 exists.
// Safe to rerun: a sponsor that already has purchases is skipped.
require('dotenv').config();
const db = require('../src/db');

const SPONSOR_NAME = 'Demo Sponsor';

// [driver username, days ago, description, dollars, points spent]
const PURCHASES = [
  ['driver1', 2, 'Insulated travel mug', 24.99, 250],
  ['driver2', 5, 'Wireless earbuds', 59.0, 590],
  ['driver1', 9, 'LED flashlight', 18.5, 185],
  ['driver1', 16, 'Seat cushion', 39.95, 400],
  ['driver2', 21, 'Phone mount', 15.0, 150],
  ['driver1', 33, 'Bluetooth speaker', 45.0, 450],
  ['driver2', 38, 'Work gloves, 3 pack', 22.75, 228],
  ['driver1', 47, 'Cooler bag', 31.2, 312],
  ['driver2', 58, 'Dash camera', 89.99, 900],
  ['driver1', 66, 'Sunglasses', 27.0, 270],
  ['driver2', 71, 'Thermos', 21.5, 215],
];

async function main() {
  const sponsors = await db.query('SELECT id FROM sponsors WHERE name = ?', [SPONSOR_NAME]);
  if (!sponsors.length) throw new Error(`Seed first (npm run db:seed): ${SPONSOR_NAME} is missing.`);
  const sponsorId = sponsors[0].id;

  const existing = await db.query('SELECT COUNT(*) AS n FROM purchases WHERE sponsor_id = ?', [sponsorId]);
  if (existing[0].n > 0) {
    console.log(`${SPONSOR_NAME} already has ${existing[0].n} purchases, skipped`);
    await db.pool.end();
    return;
  }

  const ids = {};
  for (const username of new Set(PURCHASES.map(p => p[0]))) {
    const rows = await db.query('SELECT id FROM users WHERE username = ?', [username]);
    if (!rows.length) throw new Error(`${username} is missing. Run npm run db:seed and npm run db:seed:points first.`);
    ids[username] = rows[0].id;
  }

  let total = 0;
  for (const [username, daysAgo, description, dollars, points] of PURCHASES) {
    const cents = Math.round(dollars * 100);
    await db.query(
      'INSERT INTO purchases (driver_id, sponsor_id, description, amount_cents, points_spent, purchased_at) ' +
        'VALUES (?, ?, ?, ?, ?, NOW() - INTERVAL ? DAY)',
      [ids[username], sponsorId, description, cents, points, daysAgo]
    );
    total += cents;
  }
  console.log(`${SPONSOR_NAME}: ${PURCHASES.length} purchases, $${(total / 100).toFixed(2)} total`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
