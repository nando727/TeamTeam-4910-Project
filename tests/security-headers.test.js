import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { app } = require('../src/app');
const { POLICY } = require('../src/security-headers');

const directive = name => POLICY.split('; ').find(part => part.startsWith(`${name} `));

function expectHeaders(res) {
  expect(res.headers['content-security-policy']).toBe(POLICY);
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
}

describe('the headers are on every kind of response', () => {
  test('a rendered page', async () => expectHeaders(await request(app).get('/login').expect(200)));

  test('a redirect, where a framed page would otherwise land', async () => {
    const res = await request(app).get('/').expect(302);
    expect(res.headers.location).toBe('/login');
    expectHeaders(res);
  });

  // Express answers an unmatched route itself, and its own handler replaces
  // our policy with a stricter one of its own ("default-src 'none'"). That
  // policy has no frame-ancestors, so framing of a 404 is refused by the
  // X-Frame-Options header below, which Express leaves alone.
  test('a page that does not exist is still refused a frame', async () => {
    const res = await request(app).get('/no-such-page').expect(404);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  test('a file served out of public/', async () => expectHeaders(await request(app).get('/styles.css').expect(200)));

  test('the script that replaced the inline one is served and allowed', async () => {
    const res = await request(app).get('/js-flag.js').expect(200);
    expect(res.text).toContain("classList.add('js')");
    expectHeaders(res);
  });
});

describe('what the policy says', () => {
  test('nobody can frame us, by the new rule and the old one', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  test('scripts come from this app only, with no inline exception', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('script-src')).not.toContain('unsafe-inline');
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
  });

  test('forms post back here, and no <base> can redirect a relative link', () => {
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });

  test('the tab icon still loads, since it is a data URI', () => {
    expect(directive('img-src')).toContain("'self' data:");
  });

  test('catalog images may come from the product service, and from nowhere else outside', () => {
    expect(directive('img-src')).toBe("img-src 'self' data: https://fakestoreapi.com");
    expect(directive('img-src')).not.toMatch(/(^|\s)(https:|\*)(\s|$)/);
  });
});

describe('injected markup is shown, not run', () => {
  // Over 64 characters, so the form rejects it and echoes it back into the
  // field -- the one place an unescaped value would reach the browser.
  const ATTEMPT = `<script>alert("xss")</script>${'a'.repeat(50)}`;

  test('a script tag typed into the username comes back escaped', async () => {
    const res = await request(app).post('/forgot-password').type('form').send({ username: ATTEMPT }).expect(400);
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('<script>alert');
  });

  test('no page carries an inline script for an injected one to hide among', async () => {
    const page = await request(app).get('/login').expect(200);
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});
