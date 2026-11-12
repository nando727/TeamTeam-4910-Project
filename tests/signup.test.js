// Sprint 9: drivers can create their own account from the login page. The
// account is always a driver, the shared password rules and duplicate checks
// apply, and the form is throttled per source address.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const signup = require('../src/auth/signup');
const { createRateLimiter } = require('../src/auth/rate-limit');

let inserted;
let takenEmails;
const originalMax = process.env.SIGNUP_MAX_PER_WINDOW;

beforeEach(() => {
  inserted = [];
  takenEmails = [];
  signup._resetLimiter();
  delete process.env.SIGNUP_MAX_PER_WINDOW;
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM users WHERE email')) return takenEmails.includes(params[0]) ? [{ id: 5 }] : [];
    if (sql.startsWith('INSERT INTO users')) {
      const [name, email, username, passwordHash, role, sponsorId] = params;
      if (username === 'taken') { const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err; }
      inserted.push({ name, email, username, passwordHash, role, sponsorId });
      return { insertId: 77 };
    }
    if (sql.startsWith('INSERT INTO password_history')) return { insertId: 1 };
    if (sql.startsWith('SELECT id FROM password_history')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  signup._resetLimiter();
  if (originalMax === undefined) delete process.env.SIGNUP_MAX_PER_WINDOW; else process.env.SIGNUP_MAX_PER_WINDOW = originalMax;
});

// The form token lives in the visitor's session, so a sign-up is two requests
// on one agent, exactly as a browser would make them.
async function openForm() {
  const agent = request.agent(app);
  const page = await agent.get('/signup').expect(200);
  const token = page.text.match(/name="token" value="([a-f0-9]+)"/)[1];
  return { agent, token, page };
}

const GOOD = { name: 'Dana Driver', email: 'dana@example.com', username: 'dana.d', password: 'Password1!', confirmPassword: 'Password1!' };

describe('the sign-up page', () => {
  test('is linked from the login page and shows the password rules', async () => {
    const login = await request(app).get('/login').expect(200);
    expect(login.text).toContain('href="/signup"');
    expect(login.text).toContain('Create a driver account');
    const { page } = await openForm();
    expect(page.text).toContain('data-password-rules');
    expect(page.text).toContain('name="confirmPassword"');
    // The role is not a field: there is nothing to tamper with.
    expect(page.text).not.toMatch(/name="role"/);
  });

  test('creates a driver, never any other role, and sends them to log in', async () => {
    const { agent, token } = await openForm();
    const res = await agent.post('/signup').type('form').send({ ...GOOD, role: 'admin', token }).expect(303);
    expect(res.headers.location).toBe('/login?created=1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ name: 'Dana Driver', email: 'dana@example.com', username: 'dana.d', role: 'driver', sponsorId: null });
    expect(inserted[0].passwordHash).toMatch(/^\$2[aby]\$/);
    const login = await request(app).get('/login?created=1').expect(200);
    expect(login.text).toContain('Your driver account is ready');
  });

  test('refuses a password that breaks the shared rules, and a mismatched confirmation', async () => {
    const { agent, token } = await openForm();
    const weak = await agent.post('/signup').type('form').send({ ...GOOD, password: 'password', confirmPassword: 'password', token }).expect(400);
    expect(weak.text).toContain('Password must include an uppercase letter.');
    const mismatch = await agent.post('/signup').type('form').send({ ...GOOD, confirmPassword: 'Password2!', token }).expect(400);
    expect(mismatch.text).toContain('do not match');
    expect(inserted).toHaveLength(0);
  });

  test('refuses a bad username, a bad email, and a missing name, keeping what was typed', async () => {
    const { agent, token } = await openForm();
    const res = await agent.post('/signup').type('form').send({ ...GOOD, name: '', email: 'not-an-email', username: 'a b', token }).expect(400);
    expect(res.text).toContain('Enter your name');
    expect(res.text).toContain('valid email');
    expect(res.text).toContain('3 to 64 letters');
    expect(res.text).toContain('value="not-an-email"');
    expect(inserted).toHaveLength(0);
  });

  test('blocks a duplicate email and a duplicate username', async () => {
    takenEmails = ['dana@example.com'];
    const { agent, token } = await openForm();
    const email = await agent.post('/signup').type('form').send({ ...GOOD, token }).expect(409);
    expect(email.text).toContain('A user with that email already exists.');
    takenEmails = [];
    const username = await agent.post('/signup').type('form').send({ ...GOOD, username: 'taken', token }).expect(409);
    expect(username.text).toContain('A user with that username already exists.');
    expect(inserted).toHaveLength(0);
  });

  test('needs the form token and turns a signed-in visitor away', async () => {
    const { agent } = await openForm();
    await agent.post('/signup').type('form').send({ ...GOOD, token: 'nope' }).expect(403);
    expect(inserted).toHaveLength(0);
  });

  test('is throttled per source address after the configured number of posts', async () => {
    process.env.SIGNUP_MAX_PER_WINDOW = '2';
    const { agent, token } = await openForm();
    // Invalid posts count too, so a script cannot probe usernames for free.
    await agent.post('/signup').type('form').send({ ...GOOD, username: 'x', token }).expect(400);
    await agent.post('/signup').type('form').send({ ...GOOD, username: 'y', token }).expect(400);
    const blocked = await agent.post('/signup').type('form').send({ ...GOOD, token }).expect(429);
    expect(blocked.text).toContain('Too many sign-ups from this connection');
    expect(inserted).toHaveLength(0);
  });
});

describe('the rate limiter', () => {
  test('allows up to the limit in a window and recovers when the window passes', () => {
    let clock = 1000;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => clock });
    expect(limiter.check('a')).toMatchObject({ allowed: true, remaining: 2 });
    limiter.hit('a'); limiter.hit('a');
    expect(limiter.check('a')).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    // Another key is unaffected.
    expect(limiter.check('b').allowed).toBe(true);
    clock = 2001;
    expect(limiter.check('a').allowed).toBe(true);
    // Keys with no recent hits are forgotten, so the map does not grow forever.
    expect(limiter.size()).toBe(0);
  });

  test('an unknown source shares one bucket rather than getting a free pass', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => 5 });
    limiter.hit(null);
    expect(limiter.check(null).allowed).toBe(false);
  });
});
