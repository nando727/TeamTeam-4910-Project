// Behaviour the login form gets from HTML and the database rather than from
// our own code: pressing Enter submits, usernames ignore capitalisation, and
// blank fields are refused.
//
// These are regression guards. Each one passes today because of a decision
// made elsewhere — form semantics, or the column's case-insensitive collation
// — so a future change could silently undo it. A failing test here means one
// of those assumptions changed.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let passwordHash;
let lookedUpUsernames;

beforeAll(async () => {
  passwordHash = await hashPassword('DriverPass1!');
});

beforeEach(() => {
  lookedUpUsernames = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      lookedUpUsernames.push(username);
      // MySQL's collation on users.username is case-insensitive, so the real
      // database matches regardless of case. The stub mirrors that.
      if (username.toLowerCase() !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active' }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pressing Enter submits the login form', () => {
  test('the form is a plain POST form with a submit button', async () => {
    const res = await request(app).get('/login');

    // A browser submits a form on Enter when it has a submit button. These
    // three facts are what make that work.
    expect(res.text).toMatch(/<form[^>]*method="POST"/i);
    expect(res.text).toMatch(/<form[^>]*action="\/login"/i);
    expect(res.text).toMatch(/<button[^>]*type="submit"/i);
  });

  test('no script on the page can intercept the keypress', async () => {
    const res = await request(app).get('/login');

    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/onkeydown|onkeypress|onsubmit/i);
  });

  test('both fields sit inside that form, so Enter works from either one', async () => {
    const res = await request(app).get('/login');
    const form = res.text.match(/<form[\s\S]*?<\/form>/i)[0];

    expect(form).toContain('name="username"');
    expect(form).toContain('name="password"');
  });
});

describe('usernames ignore capitalisation', () => {
  const spellings = ['driver1', 'Driver1', 'DRIVER1', 'dRiVeR1'];

  test.each(spellings)('%s can log in', async (username) => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username, password: 'DriverPass1!' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('the username is passed to the database as typed, not lower-cased here', async () => {
    await request(app).post('/login').type('form')
      .send({ username: 'DRIVER1', password: 'DriverPass1!' });

    // Matching is the database's job (collation utf8mb4_0900_ai_ci). If this
    // ever needs to change, do it in the query, not by mangling input.
    expect(lookedUpUsernames).toEqual(['DRIVER1']);
  });

  test('a wrong password is still refused whatever the capitalisation', async () => {
    const res = await request(app).post('/login').type('form')
      .send({ username: 'DRIVER1', password: 'wrong-password' });

    expect(res.status).toBe(401);
  });
});

describe('blank fields are refused', () => {
  test.each([
    ['both blank', { username: '', password: '' }],
    ['no username', { username: '', password: 'DriverPass1!' }],
    ['no password', { username: 'driver1', password: '' }],
    ['spaces only', { username: '   ', password: '   ' }],
  ])('%s', async (_label, body) => {
    const res = await request(app).post('/login').type('form').send(body);

    expect(res.status).toBe(400);
    expect(res.text).toContain('Please enter both a username and a password.');
    // Refused before any database work.
    expect(lookedUpUsernames).toEqual([]);
  });

  test('the fields are marked required, so browsers catch it first', async () => {
    const res = await request(app).get('/login');
    const form = res.text.match(/<form[\s\S]*?<\/form>/i)[0];

    expect(form).toMatch(/name="username"[^>]*required|required[^>]*name="username"/);
    expect(form).toMatch(/name="password"[^>]*required|required[^>]*name="password"/);
  });
});
