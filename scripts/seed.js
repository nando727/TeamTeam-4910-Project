// Inserts one demo user per role for local development.
// Usage: npm run db:seed
// Passwords are hashed through the shared helper — never stored in plaintext.
require('dotenv').config();
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');

const DEMO_USERS = [
  { username: 'driver1', password: 'DriverPass1!', role: 'driver' },
  { username: 'sponsor1', password: 'SponsorPass1!', role: 'sponsor' },
  { username: 'admin1', password: 'AdminPass1!', role: 'admin' },
];

async function main() {
  for (const u of DEMO_USERS) {
    const hash = await hashPassword(u.password);
    await db.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)',
      [u.username, hash, u.role]
    );
    console.log(`Seeded ${u.role}: ${u.username} / ${u.password}`);
  }
  await db.query(
    'INSERT INTO sponsors (name, contact_email, address) ' +
      'SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sponsors WHERE name = ? OR contact_email = ?)',
    ['Demo Sponsor', 'demo-sponsor@example.com', 'Demo address', 'Demo Sponsor', 'demo-sponsor@example.com']
  );
  console.log('Seeded Demo Sponsor');
  await db.pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
