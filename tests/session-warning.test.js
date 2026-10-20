// Story AA-12: the browser-side expiry warning. The dialog itself is built by
// public/session-warning.js, so these cover what the server sends it and the
// script's own guarantees; the countdown is checked in a browser.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

const script = fs.readFileSync(new URL('../public/session-warning.js', import.meta.url), 'utf8');
const PASSWORD = 'DriverPass1!';
let passwordHash;
const originalIdle = process.env.SESSION_IDLE_MINUTES;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT id, username, password_hash')) {
      const [username] = params;
      if (username !== 'driver1') return [];
      return [{ id: 1, username: 'driver1', password_hash: passwordHash, role: 'driver', status: 'active', sponsor_id: null }];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIdle === undefined) delete process.env.SESSION_IDLE_MINUTES;
  else process.env.SESSION_IDLE_MINUTES = originalIdle;
});

async function signIn() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'driver1', password: PASSWORD }).expect(302);
  return agent;
}

describe('what a signed-in page carries', () => {
  test('the timings the countdown needs', async () => {
    const agent = await signIn();
    const res = await agent.get('/');

    expect(res.text).toMatch(/data-session-remaining="\d+"/);
    expect(res.text).toMatch(/data-session-warning="\d+"/);
  });

  test('the remaining time is close to the full window just after signing in', async () => {
    process.env.SESSION_IDLE_MINUTES = '30';
    const agent = await signIn();
    const res = await agent.get('/');

    const remaining = Number(res.text.match(/data-session-remaining="(\d+)"/)[1]);
    expect(remaining).toBeGreaterThan(29 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  test('the script is included on signed-in pages', async () => {
    const agent = await signIn();
    const res = await agent.get('/');

    expect(res.text).toContain('/session-warning.js');
  });

  test('it is served as a static file', async () => {
    const res = await request(app).get('/session-warning.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});

describe('signed-out pages are untouched', () => {
  test('the login page carries no session timings and no warning script', async () => {
    const res = await request(app).get('/login');

    expect(res.text).not.toContain('data-session-remaining');
    expect(res.text).not.toContain('/session-warning.js');
  });
});

describe('the script itself', () => {
  test('takes its timings from the page, never hardcodes them', () => {
    expect(script).toContain('data-session-remaining');
    expect(script).toContain('data-session-warning');
    expect(script).not.toMatch(/\b(5|30)\s*\*\s*60\s*\*\s*1000\b/);
  });

  test('asks the server to extend the session rather than deciding itself', () => {
    expect(script).toContain('/session/keep-alive');
    expect(script).toContain("method: 'POST'");
  });

  test('sends the session cookie with the keep-alive', () => {
    expect(script).toContain("credentials: 'same-origin'");
  });

  test('does nothing when the page carries no timings', () => {
    // A signed-out page has no attributes, so the script must bail out.
    expect(script).toMatch(/if \(!Number\.isFinite\(remainingMs\)/);
  });

  test('the dialog is announced to screen readers and takes focus', () => {
    expect(script).toContain("'alertdialog'");
    expect(script).toContain("aria-live");
    expect(script).toContain('.focus()');
  });

  test('its button cannot submit a surrounding form', () => {
    // Inside a form a button with no type defaults to submit.
    expect(script).toMatch(/<button type="button"/);
  });
});
