// Admin-only, read-only list of sponsor organizations and their status.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const users = {
  admin1: { id: 3, username: 'admin1', role: 'admin', status: 'active' },
  driver1: { id: 1, username: 'driver1', role: 'driver', status: 'active' },
};
const sponsors = [
  { id: 4, name: 'clemson', contactEmail: 'clemsonsponser@clemson.edu', status: 'active' },
  { id: 1, name: 'Demo Sponsor', contactEmail: 'demo-sponsor@example.com', status: 'inactive' },
];
let passwordHash;

beforeAll(async () => {
  passwordHash = await hashPassword('Password1!');
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM users WHERE id')) {
      const user = Object.values(users).find(u => u.id === params[0]);
      return user ? [{ ...user, name: null, email: null }] : [];
    }
    if (sql.includes('FROM users')) {
      const user = users[params[0]];
      return user ? [{ ...user, password_hash: passwordHash }] : [];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM sponsors')) return sponsors;
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

test('logged-out visitors are sent to the login page', async () => {
  await request(app).get('/admin/sponsor-status').expect(302).expect('Location', '/login');
});

test('non-admins cannot view sponsor status', async () => {
  const agent = await login('driver1');
  await agent.get('/admin/sponsor-status').expect(403);
});

test('admins see every sponsor with name, contact email, and status', async () => {
  const agent = await login('admin1');
  const page = await agent.get('/admin/sponsor-status').expect(200);
  for (const sponsor of sponsors) {
    expect(page.text).toContain(sponsor.name);
    expect(page.text).toContain(sponsor.contactEmail);
    expect(page.text).toContain(`status-${sponsor.status}`);
  }
  // Read-only: the only form on the page is the header's logout button.
  const forms = page.text.match(/<form[^>]*>/gi) || [];
  expect(forms).toHaveLength(1);
  expect(forms[0]).toContain('action="/logout"');
});

test('the admin homepage links to the sponsor status page', async () => {
  const agent = await login('admin1');
  const home = await agent.get('/').expect(200);
  expect(home.text).toContain('href="/admin/sponsor-status"');
});
