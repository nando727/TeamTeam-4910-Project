// Sprint one: select a sponsor, enter information, review, and submit.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';

// The application uses CommonJS, so load the same modules it uses.
const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const details = {
  fullName: 'Alex Driver',
  contactEmail: 'alex@example.com',
  reason: 'I drive safely.',
};
const sponsors = [
  { id: 7, name: 'Safe Driving' },
  { id: 8, name: 'Second Sponsor' },
];
let passwordHash;
let savedApplication;

beforeAll(async () => {
  passwordHash = await hashPassword('Password1!');
});

// Fake database responses let tests run without a MySQL server.
// Reset them before each test so tests do not affect one another.
beforeEach(() => {
  savedApplication = null;
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM users')) {
      return [{ id: 1, username: 'driver', role: 'driver', password_hash: passwordHash }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT s.id')) return sponsors;
    if (sql.startsWith('SELECT id, name FROM sponsors')) {
      return sponsors.filter(sponsor => sponsor.id === params[0]);
    }
    if (sql.startsWith('INSERT INTO sponsor_applications')) {
      savedApplication = params;
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// An agent keeps login cookies, like a browser.
async function login() {
  const agent = request.agent(app);
  await agent.post('/login').type('form')
    .send({ username: 'driver', password: 'Password1!' }).expect(302);
  return agent;
}

// Read the hidden form values that a browser would send automatically.
function hiddenValue(page, name) {
  return page.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
}

async function reviewApplication(agent, values = details) {
  const form = await agent.get('/sponsors/8/apply').expect(200);
  const token = hiddenValue(form, 'token');
  await agent.post('/sponsors/8/review').type('form')
    .send({ token, ...values }).expect(303);
  const page = await agent.get('/sponsors/8/review').expect(200);
  return { page, token, reviewId: hiddenValue(page, 'reviewId') };
}

test('drivers must log in before applying', async () => {
  await request(app).get('/sponsors').expect(302).expect('Location', '/login');
});

test('driver can select a sponsor from the list', async () => {
  const agent = await login();
  const page = await agent.get('/sponsors').expect(200);
  expect(page.text).toContain('href="/sponsors/7/apply"');
  expect(page.text).toContain('href="/sponsors/8/apply"');
  const form = await agent.get('/sponsors/8/apply').expect(200);
  expect(form.text).toContain('Apply to Second Sponsor');
});

test('application requires a name, email, and reason', async () => {
  const agent = await login();
  const form = await agent.get('/sponsors/8/apply');
  const token = hiddenValue(form, 'token');
  for (const field of ['fullName', 'contactEmail', 'reason']) {
    await agent.post('/sponsors/8/review').type('form')
      .send({ token, ...details, [field]: '' }).expect(400);
  }
  expect(savedApplication).toBeNull();
});

test('review displays the sponsor and entered information without submitting', async () => {
  const agent = await login();
  const { page } = await reviewApplication(agent);
  expect(page.text).toContain('Second Sponsor');
  for (const value of Object.values(details)) expect(page.text).toContain(value);
  expect(savedApplication).toBeNull();
});

test('driver can return to the form and edit before submitting', async () => {
  const agent = await login();
  await reviewApplication(agent);
  const form = await agent.get('/sponsors/8/apply').expect(200);
  expect(form.text).toContain(details.reason);
  const { page } = await reviewApplication(agent, { ...details, reason: 'Updated reason' });
  expect(page.text).toContain('Updated reason');
  expect(savedApplication).toBeNull();
});

test('submission saves the reviewed information for the selected sponsor', async () => {
  const agent = await login();
  const { token, reviewId } = await reviewApplication(agent);
  await agent.post('/sponsors/8/apply').type('form')
    .send({ token, reviewId }).expect(303).expect('Location', '/sponsors');
  expect(savedApplication).toEqual([1, 8, details.fullName, details.contactEmail, details.reason]);
  const page = await agent.get('/sponsors');
  expect(page.text).toContain('Your application to Second Sponsor was submitted.');
});

test('driver must review the application before submitting', async () => {
  const agent = await login();
  const form = await agent.get('/sponsors/8/apply');
  const token = hiddenValue(form, 'token');
  await agent.post('/sponsors/8/apply').type('form').send({ token, ...details }).expect(400);
  expect(savedApplication).toBeNull();
});
