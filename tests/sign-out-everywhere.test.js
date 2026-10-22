// Backlog AA-13: the control that ends every session for an account.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const PASSWORD = 'DriverPass1!';
let passwordHash;
let cutoff;
let revocations;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  cutoff = null;
  revocations = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) {
      revocations.push(params[0]);
      cutoff = new Date();
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT sessions_valid_from')) {
      const [issuedAtMs] = params;
      return [{ revoked: cutoff && cutoff.getTime() > issuedAtMs ? 1 : 0 }];
    }
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('SELECT id, name, email, username')) {
      return [{ id: 1, name: 'Dee Driver', email: 'd@example.com', username: 'driver1', role: 'driver', status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD }).expect(302);
  return agent;
}

async function tokenFrom(agent) {
  const page = await agent.get('/profile').expect(200);
  return page.text.match(/name="token" value="([^"]+)"/)[1];
}

describe('the control on the profile page', () => {
  test('is offered, with an explanation of what it does', async () => {
    const agent = await signIn();
    const page = await agent.get('/profile').expect(200);

    expect(page.text).toContain('Sign out of all sessions');
    expect(page.text).toMatch(/ends your session everywhere/i);
  });

  test('is a form, not a link, so a prefetch cannot trigger it', async () => {
    const agent = await signIn();
    const page = await agent.get('/profile');

    expect(page.text).toContain('action="/profile/sign-out-everywhere"');
    expect(page.text).not.toContain('href="/profile/sign-out-everywhere"');
  });

  test('a GET does not sign anyone out', async () => {
    const agent = await signIn();
    const res = await agent.get('/profile/sign-out-everywhere');

    expect(res.status).toBe(404);
    expect(revocations).toEqual([]);
  });
});

describe('using it', () => {
  test('revokes this account and lands on the login page with the reason', async () => {
    const agent = await signIn();
    const token = await tokenFrom(agent);

    const res = await agent.post('/profile/sign-out-everywhere').type('form').send({ token });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?reason=everywhere');
    expect(revocations).toEqual([1]);
  });

  test('the device that asked is signed out too', async () => {
    const agent = await signIn();
    const token = await tokenFrom(agent);
    await agent.post('/profile/sign-out-everywhere').type('form').send({ token }).expect(302);

    const after = await agent.get('/');
    expect(after.status).toBe(302);
    expect(after.headers.location).toMatch(/^\/login/);
  });

  test('every other device is signed out as well', async () => {
    const laptop = await signIn();
    const phone = await signIn();
    await phone.get('/').expect(200);

    const token = await tokenFrom(laptop);
    await laptop.post('/profile/sign-out-everywhere').type('form').send({ token }).expect(302);

    const onPhone = await phone.get('/');
    expect(onPhone.status).toBe(302);
    expect(onPhone.headers.location).toBe('/login?reason=everywhere');
  });

  test('a request without the form token changes nothing', async () => {
    const agent = await signIn();

    const res = await agent.post('/profile/sign-out-everywhere').type('form').send({});

    expect(res.status).toBe(403);
    expect(revocations).toEqual([]);
  });

  test('a signed-out visitor cannot revoke anyone', async () => {
    const res = await request(app).post('/profile/sign-out-everywhere').type('form').send({ token: 'x' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login/);
    expect(revocations).toEqual([]);
  });
});
