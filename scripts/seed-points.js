// Sample point activity for the Driver Point Tracking report.
// Usage: npm run db:seed:points
//
// Creates a second demo driver (driver2) with an approved membership under
// Demo Sponsor, then inserts point changes for both demo drivers spread over the
// last 60 days, made by sponsor1 and admin1. Each driver's point_balance is set
// to the sum of their changes so the report total matches what the driver sees.
// Safe to rerun: a driver who already has point history is skipped.
require('dotenv').config();
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');

const SPONSOR_NAME = 'Demo Sponsor';
const DRIVER2 = { username: 'driver2', password: 'DriverPass2!', name: 'Dana Driver', email: 'driver2@example.com' };

// [days ago, points, reason, made by username]
const HISTORY = {
  driver1: [
    [58, 100, 'Welcome bonus for joining the program', 'sponsor1'],
    [45, 50, 'On-time delivery streak, week 1', 'sponsor1'],
    [38, 50, 'On-time delivery streak, week 2', 'sponsor1'],
    [30, -25, 'Hard braking event reported by telematics', 'sponsor1'],
    [21, 75, 'Clean safety inspection', 'sponsor1'],
    [14, 20, 'Fuel efficiency above fleet average', 'admin1'],
    [6, -40, 'Late delivery, customer complaint', 'sponsor1'],
    [2, 30, 'Completed defensive driving course', 'admin1'],
  ],
  driver2: [
    [40, 100, 'Welcome bonus for joining the program', 'sponsor1'],
    [27, 50, 'On-time delivery streak, week 1', 'sponsor1'],
    [12, -15, 'Speeding alert, 5 mph over limit', 'sponsor1'],
    [3, 60, 'Referred a new driver to the program', 'sponsor1'],
  ],
};

async function userId(username) {
  const rows = await db.query('SELECT id FROM users WHERE username = ?', [username]);
  if (!rows.length) throw new Error(`Seed users first (npm run db:seed): ${username} is missing.`);
  return rows[0].id;
}

async function ensureDriver2(sponsorId) {
  let rows = await db.query('SELECT id FROM users WHERE username = ?', [DRIVER2.username]);
  if (!rows.length) {
    const hash = await hashPassword(DRIVER2.password);
    const result = await db.query(
      "INSERT INTO users (username, password_hash, role, name, email) VALUES (?, ?, 'driver', ?, ?)",
      [DRIVER2.username, hash, DRIVER2.name, DRIVER2.email]
    );
    rows = [{ id: result.insertId }];
    console.log(`Created driver: ${DRIVER2.username} / ${DRIVER2.password}`);
  } else {
    console.log(`${DRIVER2.username} already exists`);
  }
  const driverId = rows[0].id;

  // An approved application plus a membership, the same pair the sponsor
  // approval flow creates.
  await db.query(
    "INSERT INTO sponsor_applications (driver_id, sponsor_id, full_name, contact_email, reason, status) " +
      "SELECT ?, ?, ?, ?, ?, 'approved' WHERE NOT EXISTS " +
      '(SELECT 1 FROM sponsor_applications WHERE driver_id = ? AND sponsor_id = ?)',
    [driverId, sponsorId, DRIVER2.name, DRIVER2.email, 'Seeded demo application', driverId, sponsorId]
  );
  await db.query(
    'INSERT INTO driver_sponsors (driver_id, sponsor_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE driver_id = driver_id',
    [driverId, sponsorId]
  );
  console.log(`${DRIVER2.username} is an approved member of ${SPONSOR_NAME}`);
  return driverId;
}

async function seedHistory(username, driverId, sponsorId) {
  const existing = await db.query('SELECT COUNT(*) AS n FROM point_transactions WHERE driver_id = ?', [driverId]);
  if (existing[0].n > 0) {
    console.log(`${username} already has ${existing[0].n} point changes, skipped`);
    return;
  }
  let total = 0;
  for (const [daysAgo, points, reason, byUsername] of HISTORY[username]) {
    await db.query(
      'INSERT INTO point_transactions (driver_id, sponsor_id, changed_by_user_id, points_change, reason, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, NOW() - INTERVAL ? DAY)',
      [driverId, sponsorId, await userId(byUsername), points, reason, daysAgo]
    );
    total += points;
  }
  await db.query('UPDATE driver_sponsors SET point_balance = ? WHERE driver_id = ? AND sponsor_id = ?', [total, driverId, sponsorId]);
  console.log(`${username}: ${HISTORY[username].length} point changes, balance set to ${total}`);
}

async function main() {
  const sponsors = await db.query('SELECT id FROM sponsors WHERE name = ?', [SPONSOR_NAME]);
  if (!sponsors.length) throw new Error(`Seed first (npm run db:seed): ${SPONSOR_NAME} is missing.`);
  const sponsorId = sponsors[0].id;

  const driver1 = await userId('driver1');
  const driver2 = await ensureDriver2(sponsorId);
  await seedHistory('driver1', driver1, sponsorId);
  await seedHistory('driver2', driver2, sponsorId);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
