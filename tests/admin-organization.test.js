// Sprint 9: one page per sponsor organization showing its details and the
// people who belong to it, linked from Sponsor status; the sponsor's own
// Organization page gets the same People section; and the sponsor Drivers
// page reads each driver's points from their membership with that sponsor
// rather than from the users.balance column, which no migration creates.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { listDriversForSponsor } = require('../src/sponsors/accounts');

const ORG = {
  id: 7, name: 'Northstar Freight', contactEmail: 'ops@northstar.test',
  contactPhone: '555-0100', address: '1 Depot Rd', status: 'active', createdAt: new Date('2026-09-01T00:00:00Z'),
};
const ADMIN = { id: 3, username: 'admin1', role: 'admin', status: 'active', sponsor_id: null };
const SPONSOR = { id: 70, username: 'sponsor7', role: 'sponsor', status: 'active', sponsor_id: 7 };

let hash;
let sponsorUsers;
let drivers;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  queries = [];
  sponsorUsers = [{ id: 70, name: 'Sam Sponsor', email: 'sam@northstar.test', username: 'sponsor7', status: 'active' }];
  drivers = [
    { id: 1, name: 'Theo Trucker', email: 'theo@example.com', username: 'driver1', status: 'active', balance: 1200 },
    { id: 2, name: 'Pat Driver', email: 'pat@example.com', username: 'driver2', status: 'disabled', balance: 300 },
  ];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = [ADMIN, SPONSOR].find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) return params[0] === 3 ? [ADMIN] : [SPONSOR];
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail, contact_phone')) return params[0] === 7 ? [ORG] : [];
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail')) return [{ id: 7, name: ORG.name, contactEmail: ORG.contactEmail, status: 'active' }];
    if (sql.includes("WHERE role = 'sponsor' AND sponsor_id = ?")) return sponsorUsers;
    if (sql.includes('JOIN driver_sponsors ds ON ds.driver_id = u.id')) return drivers;
    // The sponsor's own organization page also reads its details and rules.
    if (sql.startsWith('SELECT id, name, contact_email, contact_phone, address, status FROM sponsors')) {
      return [{ id: 7, name: ORG.name, contact_email: ORG.contactEmail, contact_phone: ORG.contactPhone, address: ORG.address, status: 'active' }];
    }
    if (sql.startsWith('SELECT id, title, description FROM rules')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

describe('the admin organization page', () => {
  test('is admin only, and Sponsor status links to it', async () => {
    await request(app).get('/admin/sponsors/7').expect(302);
    const sponsor = await login('sponsor7');
    await sponsor.get('/admin/sponsors/7').expect(403);
    const admin = await login('admin1');
    const status = await admin.get('/admin/sponsor-status').expect(200);
    expect(status.text).toContain('href="/admin/sponsors/7"');
    expect(status.text).toContain('View organization');
  });

  test('shows the organization details, its sponsor users, and its drivers with their points', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/admin/sponsors/7').expect(200);
    expect(page.text).toContain('<h1>Northstar Freight</h1>');
    expect(page.text).toContain('ops@northstar.test');
    expect(page.text).toContain('555-0100');
    expect(page.text).toContain('1 Depot Rd');
    // Sponsor users.
    expect(page.text).toContain('Sam Sponsor');
    expect(page.text).toContain('sponsor7');
    // Drivers, with the points each holds here and the total.
    expect(page.text).toContain('Theo Trucker');
    expect(page.text).toContain('1,200');
    expect(page.text).toContain('Pat Driver');
    expect(page.text).toContain('1,500');
    expect(page.text).toContain('Points held with Northstar Freight');
    // Counts at a glance, including how many drivers can sign in.
    expect(page.text).toContain('2 (1 active)');
    // Both lists are scoped to this organization by its id.
    const [, sponsorParams] = queries.find(([sql]) => sql.includes("WHERE role = 'sponsor' AND sponsor_id = ?"));
    expect(sponsorParams).toEqual([7]);
    const [, driverParams] = queries.find(([sql]) => sql.includes('JOIN driver_sponsors ds ON ds.driver_id = u.id'));
    expect(driverParams).toEqual([7]);
  });

  test('says so when an organization has nobody in it', async () => {
    sponsorUsers = [];
    drivers = [];
    const admin = await login('admin1');
    const page = await admin.get('/admin/sponsors/7').expect(200);
    expect(page.text).toContain('No sponsor user acts for this organization yet');
    expect(page.text).toContain('No drivers belong to this organization yet');
  });

  test('an organization that does not exist, or a bad id, is refused', async () => {
    const admin = await login('admin1');
    await admin.get('/admin/sponsors/99').expect(404);
    await admin.get('/admin/sponsors/abc').expect(400);
    await admin.get('/admin/sponsors/0').expect(400);
  });
});

describe('the sponsor\'s own organization page', () => {
  test('gains a People section with its sponsor users and drivers', async () => {
    const sponsor = await login('sponsor7');
    const page = await sponsor.get('/organization').expect(200);
    expect(page.text).toContain('People in Northstar Freight');
    expect(page.text).toContain('Sam Sponsor');
    expect(page.text).toContain('Theo Trucker');
    expect(page.text).toContain('Points with us');
    expect(page.text).toContain('1,200');
    expect(page.text).toContain('1,500');
    // Scoped to the signed-in sponsor's own organization, from the session.
    const [, driverParams] = queries.find(([sql]) => sql.includes('JOIN driver_sponsors ds ON ds.driver_id = u.id'));
    expect(driverParams).toEqual([7]);
  });
});

describe('the sponsor Drivers page balance (Ford\'s page)', () => {
  test('reads the points from the membership, never from a users.balance column', async () => {
    await listDriversForSponsor(7);
    const [sql] = queries.find(([q]) => q.includes('JOIN driver_sponsors ds ON ds.driver_id = u.id'));
    expect(sql).toContain('ds.point_balance AS balance');
    expect(sql).not.toContain('u.balance');
  });

  test('the balance filters compare the membership balance too', async () => {
    await listDriversForSponsor(7, { name: 'theo', minBalance: 100, maxBalance: 2000 });
    const [sql, params] = queries.filter(([q]) => q.includes('JOIN driver_sponsors ds ON ds.driver_id = u.id')).pop();
    expect(sql).toContain('ds.point_balance >= ?');
    expect(sql).toContain('ds.point_balance <= ?');
    expect(sql).not.toContain('u.balance');
    expect(params).toEqual([7, '%theo%', 100, 2000]);
  });

  test('the Drivers page shows those points', async () => {
    const sponsor = await login('sponsor7');
    const page = await sponsor.get('/drivers').expect(200);
    expect(page.text).toContain('Theo Trucker');
    expect(page.text).toContain('1200');
  });
});
