// Story 22217: the password field can be shown while typing.
//
// The button itself is created in the browser, so these tests cover what the
// server sends: the field is a normal password input, it opts in to the
// enhancement, and the script is delivered. Clicking is verified in a browser.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { app } = require('../src/app');

const script = fs.readFileSync(new URL('../public/password-toggle.js', import.meta.url), 'utf8');

describe('the login page', () => {
  test('marks the password field for the Show/Hide control', async () => {
    const res = await request(app).get('/login');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/id="password"[^>]*data-toggle-visibility|data-toggle-visibility[^>]*id="password"/s);
  });

  test('still sends a normal password field, so it is hidden without JavaScript', async () => {
    const res = await request(app).get('/login');

    expect(res.text).toMatch(/<input[^>]*id="password"[^>]*type="password"/);
    // The button is not in the HTML: no dead control for a visitor without JS.
    expect(res.text).not.toContain('password-toggle"');
  });

  test('includes the toggle script', async () => {
    const res = await request(app).get('/login');
    expect(res.text).toContain('/password-toggle.js');
  });

  test('serves the script as a static file', async () => {
    const res = await request(app).get('/password-toggle.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});

describe('the toggle script itself', () => {
  test('uses a non-submit button, so it cannot submit the login form', () => {
    expect(script).toMatch(/button\.type\s*=\s*'button'/);
  });

  test('keeps an accessible name and a pressed state in step with the field', () => {
    expect(script).toContain("'Show password'");
    expect(script).toContain("'Hide password'");
    expect(script).toContain('aria-pressed');
    expect(script).toContain('aria-controls');
  });

  test('only enhances fields that ask for it', () => {
    expect(script).toContain('input[type="password"][data-toggle-visibility]');
  });

  test('binds no key or submit handlers', () => {
    // Story 22220 (Enter submits the form) depends on this staying true.
    expect(script).not.toMatch(/addEventListener\('(keydown|keypress|keyup|submit)'/);
  });
});
