// Sample data for the Sales by Sponsor report (stories AD-25 to AD-29).
// Usage: npm run db:seed:sales
//
// Adds a second sponsor organization (Northstar Freight) with a sponsor user
// and a driver who is an approved member, then purchases for both sponsors so
// the sponsor filter, the summary version, and pagination all have something
// to show. Inserts only; safe to rerun because every step checks first.
// Run `npm run db:seed`, `db:seed:points`, and `db:seed:purchases` before this.
require('dotenv').config();
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');

const NORTHSTAR = { name: 'Northstar Freight', email: 'billing@northstar-freight.example', phone: '864-555-0142', address: '1200 Harbor Way, Charleston, SC' };
const SPONSOR_USER = { username: 'sponsor2', password: 'SponsorPass2!', name: 'Nora Northstar', email: 'nora@northstar-freight.example' };
const DRIVER3 = { username: 'driver3', password: 'DriverPass3!', name: 'Theo Trucker', email: 'driver3@example.com' };

// [driver username, days ago, description, dollars, points spent]
const NORTHSTAR_PURCHASES = [
  ['driver3', 1, 'Rain-X wiper blades', 32.0, 320],
  ['driver3', 4, 'Noise-cancelling headset', 129.99, 1300],
  ['driver3', 11, 'Insulated lunch box', 26.5, 265],
  ['driver3', 19, 'Portable tire inflator', 54.95, 550],
  ['driver3', 24, 'Hi-vis safety vest, 2 pack', 19.98, 200],
  ['driver3', 35, 'Jump starter power bank', 79.0, 790],
  ['driver3', 42, 'Seat organizer', 23.49, 235],
  ['driver3', 53, 'Cab curtain set', 44.0, 440],
  ['driver3', 61, 'Travel pillow', 17.25, 173],
  ['driver3', 74, 'Floor mat set', 61.0, 610],
];
const DEMO_EXTRA_PURCHASES = [
  ['driver1', 1, 'Tire pressure gauge', 12.99, 130],
  ['driver2', 3, 'Phone charger, 3 pack', 21.0, 210],
  ['driver1', 7, 'Steering wheel cover', 16.5, 165],
  ['driver2', 13, 'First aid kit', 28.75, 288],
  ['driver1', 26, 'Rechargeable work light', 34.99, 350],
  ['driver2', 44, 'Windshield sun shade', 14.0, 140],
  ['driver1', 52, 'Logbook cover', 11.5, 115],
  ['driver2', 69, 'Cooler, 20 quart', 49.99, 500],
];

async function one(sql, params) { const rows = await db.query(sql, params); return rows[0] || null; }

async function ensureSponsor() {
  const found = await one('SELECT id FROM sponsors WHERE name = ? OR contact_email = ?', [NORTHSTAR.name, NORTHSTAR.email]);
  if (found) { console.log(`${NORTHSTAR.name} already exists`); return found.id; }
  const result = await db.query(
    'INSERT INTO sponsors (name, contact_email, contact_phone, address) VALUES (?, ?, ?, ?)',
    [NORTHSTAR.name, NORTHSTAR.email, NORTHSTAR.phone, NORTHSTAR.address]
  );
  console.log(`Created sponsor: ${NORTHSTAR.name}`);
  return result.insertId;
}

async function ensureUser({ username, password, name, email }, role, sponsorId = null) {
  const found = await one('SELECT id FROM users WHERE username = ?', [username]);
  if (found) { console.log(`${username} already exists`); return found.id; }
  const hash = await hashPassword(password);
  const result = await db.query(
    'INSERT INTO users (username, password_hash, role, name, email, sponsor_id) VALUES (?, ?, ?, ?, ?, ?)',
    [username, hash, role, name, email, sponsorId]
  );
  console.log(`Created ${role}: ${username} / ${password}`);
  return result.insertId;
}

async function ensureMembership(driverId, sponsorId, fullName, email) {
  await db.query(
    "INSERT INTO sponsor_applications (driver_id, sponsor_id, full_name, contact_email, reason, status) " +
      "SELECT ?, ?, ?, ?, 'Seeded demo application', 'approved' WHERE NOT EXISTS " +
      '(SELECT 1 FROM sponsor_applications WHERE driver_id = ? AND sponsor_id = ?)',
    [driverId, sponsorId, fullName, email, driverId, sponsorId]
  );
  await db.query(
    'INSERT INTO driver_sponsors (driver_id, sponsor_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE driver_id = driver_id',
    [driverId, sponsorId]
  );
}

async function seedPurchases(label, sponsorId, list) {
  const marker = list[0][2];
  if (await one('SELECT id FROM purchases WHERE sponsor_id = ? AND description = ?', [sponsorId, marker])) {
    console.log(`${label}: sample purchases already present, skipped`);
    return;
  }
  const ids = {};
  for (const username of new Set(list.map(p => p[0]))) {
    const row = await one('SELECT id FROM users WHERE username = ?', [username]);
    if (!row) throw new Error(`${username} is missing. Run the earlier seeds first.`);
    ids[username] = row.id;
  }
  let cents = 0;
  for (const [username, daysAgo, description, dollars, points] of list) {
    const amount = Math.round(dollars * 100);
    await db.query(
      'INSERT INTO purchases (driver_id, sponsor_id, description, amount_cents, points_spent, purchased_at) ' +
        'VALUES (?, ?, ?, ?, ?, NOW() - INTERVAL ? DAY)',
      [ids[username], sponsorId, description, amount, points, daysAgo]
    );
    cents += amount;
  }
  console.log(`${label}: ${list.length} purchases, $${(cents / 100).toFixed(2)}`);
}

async function main() {
  const demo = await one('SELECT id FROM sponsors WHERE name = ?', ['Demo Sponsor']);
  if (!demo) throw new Error('Demo Sponsor is missing. Run npm run db:seed first.');

  const northstarId = await ensureSponsor();
  await ensureUser(SPONSOR_USER, 'sponsor', northstarId);
  const driver3 = await ensureUser(DRIVER3, 'driver');
  await ensureMembership(driver3, northstarId, DRIVER3.name, DRIVER3.email);
  console.log(`${DRIVER3.username} is an approved member of ${NORTHSTAR.name}`);

  await seedPurchases(NORTHSTAR.name, northstarId, NORTHSTAR_PURCHASES);
  await seedPurchases('Demo Sponsor (extra)', demo.id, DEMO_EXTRA_PURCHASES);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
