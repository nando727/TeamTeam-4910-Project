// Sprint 9: a missing page and a failed request get real pages in the style
// of the 403 page, while the JSON API keeps answering in JSON.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');

let hash;
beforeAll(async () => { hash = await hashPassword('Password1!'); });
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.startsWith('INSERT INTO login_attempts')) return [];
    if (sql.includes('FROM users WHERE username')) return [{ id: 1, username: params[0], role: 'driver', status: 'active', password_hash: hash, sponsor_id: null }];
    throw new Error('database is down');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('404', () => {
  test('an unknown page gets a page, with the path and a way back', async () => {
    const res = await request(app).get('/nothing/here?x=1').expect(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('That page does not exist');
    expect(res.text).toContain('/nothing/here?x=1');
    expect(res.text).toContain('href="/login"');
  });

  test('a signed-in visitor is offered their home page instead', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver1', password: 'Password1!' }).expect(302);
    const res = await agent.get('/nothing/here').expect(404);
    expect(res.text).toContain('Back to your home page');
  });

  test('the path is escaped, so a crafted link cannot put markup on the page', async () => {
    // An HTTP client percent-encodes the brackets before they reach the app,
    // so the view is rendered directly to check the escaping itself.
    const ejs = require('ejs');
    const view = fileURLToPath(new URL('../src/views/404.ejs', import.meta.url));
    const html = await ejs.renderFile(view, { attemptedPath: '/x"><script>alert(1)</script>', currentUser: null, currentPath: '/x' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('<code class="path">/x&#34;&gt;&lt;script&gt;');
    // And through the app, whatever arrives is shown as text, never as markup.
    const res = await request(app).get('/x"><script>alert(1)</script>').expect(404);
    expect(res.text).not.toContain('<script>alert');
  });

  test('an unknown API endpoint answers in JSON', async () => {
    const res = await request(app).get('/api/nothing').expect(404);
    expect(res.body).toEqual({ error: 'No such endpoint.' });
  });
});

describe('500', () => {
  test('a failed page request gets a page that says so', async () => {
    // /about reads the database, and the mock above refuses it.
    const res = await request(app).get('/about').expect(500);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Something went wrong.');
    expect(res.text).toContain('href="/login"');
    expect(console.error).toHaveBeenCalled();
  });

  test('a failed API request answers in JSON', async () => {
    const res = await request(app).get('/api/about').expect(500);
    expect(res.body).toEqual({ error: 'Something went wrong.' });
  });
});
