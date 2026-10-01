// Story 22255: the pages where a new user claims their account.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { verifyPassword } = require('../src/auth/password');
const { hashToken } = require('../src/auth/setup-tokens');
const { app } = require('../src/app');

const VALID_TOKEN = 'a'.repeat(64);
const UNKNOWN_TOKEN = 'b'.repeat(64);

let tokenRow;
let passwordUpdates;

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

beforeEach(() => {
  tokenRow = {
    id: 1,
    user_id: 42,
    token_hash: hashToken(VALID_TOKEN),
    expires_at: hoursFromNow(24),
    used_at: null,
  };
  passwordUpdates = [];

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in now checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];

    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      const [tokenHash] = params;
      return tokenHash === tokenRow.token_hash ? [tokenRow] : [];
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) {
      if (tokenRow.used_at) return { affectedRows: 0 };
      tokenRow.used_at = new Date();
      return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const [hash, userId] = params;
      passwordUpdates.push({ hash, userId });
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The setup form carries a CSRF token like the other forms in the app.
async function openSetupPage(agent, token = VALID_TOKEN) {
  const page = await agent.get(`/setup/${token}`);
  const match = page.text.match(/name="token" value="([^"]+)"/);
  return { page, formToken: match ? match[1] : null };
}

describe('opening a setup link', () => {
  test('a valid link shows the set-password form', async () => {
    const agent = request.agent(app);
    const { page } = await openSetupPage(agent);

    expect(page.status).toBe(200);
    expect(page.text).toContain('Set your password');
    expect(page.text).toContain('name="password"');
    expect(page.text).toContain('name="confirmPassword"');
  });

  test('an unknown link is refused', async () => {
    const res = await request(app).get(`/setup/${UNKNOWN_TOKEN}`);
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer works');
  });

  test('an expired link is refused', async () => {
    tokenRow.expires_at = hoursFromNow(-1);
    const res = await request(app).get(`/setup/${VALID_TOKEN}`);
    expect(res.status).toBe(410);
  });

  test('an already used link is refused', async () => {
    tokenRow.used_at = new Date();
    const res = await request(app).get(`/setup/${VALID_TOKEN}`);
    expect(res.status).toBe(410);
  });

  test('no login is needed to use the link', async () => {
    const res = await request(app).get(`/setup/${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('setting a password', () => {
  test('saves a hashed password and sends the user to log in', async () => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password: 'ChosenPass1!', confirmPassword: 'ChosenPass1!',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?setup=1');
    expect(passwordUpdates).toHaveLength(1);
    expect(passwordUpdates[0].userId).toBe(42);
    expect(passwordUpdates[0].hash).not.toBe('ChosenPass1!');
    expect(await verifyPassword('ChosenPass1!', passwordUpdates[0].hash)).toBe(true);
  });

  test('the link is spent afterwards, so it works only once', async () => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);
    await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password: 'ChosenPass1!', confirmPassword: 'ChosenPass1!',
    });

    const again = await agent.get(`/setup/${VALID_TOKEN}`);
    expect(again.status).toBe(410);
  });

  test('a short password is refused and the link is not spent', async () => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password: 'short', confirmPassword: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.text).toContain('at least 8 characters');
    expect(passwordUpdates).toHaveLength(0);
    expect(tokenRow.used_at).toBeNull();
  });

  test.each([
    ['nouppercase1!', 'uppercase letter'],
    ['NOLOWERCASE1!', 'lowercase letter'],
    ['NoNumbersHere!', 'include a number'],
    ['NoSpecial123', 'special character'],
  ])('%s is refused with the failed rule named and the link is not spent', async (password, wording) => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password, confirmPassword: password,
    });

    expect(res.status).toBe(400);
    expect(res.text).toContain(wording);
    expect(passwordUpdates).toHaveLength(0);
    expect(tokenRow.used_at).toBeNull();
  });

  test('the form shows the rules checklist', async () => {
    const { page } = await openSetupPage(request.agent(app));
    expect(page.text).toContain('data-for="password"');
    expect(page.text).toContain('src="/password-rules.js"');
  });

  test('mismatched passwords are refused and the link is not spent', async () => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password: 'ChosenPass1!', confirmPassword: 'DifferentPass1!',
    });

    expect(res.status).toBe(400);
    expect(res.text).toContain('must match');
    expect(passwordUpdates).toHaveLength(0);
    expect(tokenRow.used_at).toBeNull();
  });

  test('a submission without the form token is refused', async () => {
    const agent = request.agent(app);
    await openSetupPage(agent);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      password: 'ChosenPass1!', confirmPassword: 'ChosenPass1!',
    });

    expect(res.status).toBe(403);
    expect(passwordUpdates).toHaveLength(0);
  });

  test('an expired link cannot be used even with a form already open', async () => {
    const agent = request.agent(app);
    const { formToken } = await openSetupPage(agent);
    tokenRow.expires_at = hoursFromNow(-1);

    const res = await agent.post(`/setup/${VALID_TOKEN}`).type('form').send({
      token: formToken, password: 'ChosenPass1!', confirmPassword: 'ChosenPass1!',
    });

    expect(res.status).toBe(410);
    expect(passwordUpdates).toHaveLength(0);
  });
});

describe('the login page after setup', () => {
  test('confirms the password was set', async () => {
    const res = await request(app).get('/login?setup=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Your password is set. Please log in.');
  });

  test('a plain visit shows no notice', async () => {
    const res = await request(app).get('/login');
    expect(res.text).not.toContain('Your password is set');
  });
});
