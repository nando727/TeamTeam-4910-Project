// Story AA-20 (22222): the reset form sends real email now, so it is also a
// way to put mail in somebody else's inbox. Anyone can post a username to it
// as often as they like.
//
// A few in a row are legitimate -- the first went to spam -- so a handful are
// allowed and then nothing is sent. What the visitor is told never changes,
// because the page must not become a way to find out which accounts exist.
import { createRequire } from 'node:module';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');

const users = [
  { id: 1, username: 'driver1', role: 'driver', status: 'active', email: 'driver1@example.com' },
  { id: 2, username: 'driver2', role: 'driver', status: 'active', email: 'driver2@example.com' },
];

const originalEnv = { ...process.env };

let resets;   // fake password_resets rows
let logs;

beforeEach(() => {
  resets = [];
  logs = [];
  clearOutbox();
  process.env.MAIL_TRANSPORT = 'silent';

  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM users WHERE username')) {
      const user = users.find(u => u.username === params[0]);
      return user ? [user] : [];
    }
    if (sql.includes('COUNT(*) AS requests FROM password_resets')) {
      const [userId, minutes] = params;
      const since = Date.now() - minutes * 60 * 1000;
      return [{ requests: resets.filter(r => r.user_id === userId && r.created_at > since).length }];
    }
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO password_resets')) {
      const [user_id, token_hash] = params;
      resets.push({ id: resets.length + 1, user_id, token_hash, created_at: Date.now() });
      return { insertId: resets.length };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  for (const key of ['MAIL_TRANSPORT', 'RESET_LINK_MAX_REQUESTS', 'RESET_LINK_WINDOW_MINUTES']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const ask = (username) => request(app).post('/forgot-password').type('form').send({ username });
const mailCount = () => sentMessages().length;

describe('how many links one account can be sent', () => {
  test('a few in a row are fine: the first went to spam', async () => {
    await ask('driver1').expect(200);
    await ask('driver1').expect(200);
    await ask('driver1').expect(200);

    expect(mailCount()).toBe(3);
  });

  test('and then nothing more is sent', async () => {
    for (let i = 0; i < 3; i += 1) await ask('driver1');

    await ask('driver1').expect(200);
    await ask('driver1').expect(200);

    expect(mailCount()).toBe(3);
  });

  test('no token is issued for a request that is not sent', async () => {
    for (let i = 0; i < 5; i += 1) await ask('driver1');

    // A link that exists but was never delivered is a loose end nobody can
    // see; the row count is also what the limit is counted from.
    expect(resets).toHaveLength(3);
  });

  test('the limit is per account: one person cannot use up another', async () => {
    for (let i = 0; i < 3; i += 1) await ask('driver1');

    await ask('driver2').expect(200);

    expect(mailCount()).toBe(4);
    expect(resets.filter(r => r.user_id === 2)).toHaveLength(1);
  });

  test('once the window has passed, they can ask again', async () => {
    for (let i = 0; i < 3; i += 1) await ask('driver1');
    expect(mailCount()).toBe(3);

    // The three requests are now older than the window.
    resets.forEach(r => { r.created_at = Date.now() - 16 * 60 * 1000; });

    await ask('driver1').expect(200);
    expect(mailCount()).toBe(4);
  });

  test('both the count and the window can be tuned', async () => {
    process.env.RESET_LINK_MAX_REQUESTS = '1';

    await ask('driver1');
    await ask('driver1');

    expect(mailCount()).toBe(1);
  });
});

describe('what the visitor is told', () => {
  const body = res => res.text.replace(/name="token" value="[^"]+"/g, '');

  test('a refused request looks exactly like an accepted one', async () => {
    const accepted = await ask('driver1').expect(200);
    for (let i = 0; i < 3; i += 1) await ask('driver1');
    const refused = await ask('driver1').expect(200);

    // Saying "too many requests" here would answer the question this page
    // spends all its effort refusing to answer: whether the account exists.
    expect(body(refused)).toBe(body(accepted));
  });

  test('and so does a username that was never real', async () => {
    for (let i = 0; i < 3; i += 1) await ask('driver1');
    const refused = await ask('driver1').expect(200);
    const invented = await ask('nobody-at-all').expect(200);

    expect(body(invented)).toBe(body(refused));
    expect(mailCount()).toBe(3);
  });

  test('the refusal is visible in the log, where an admin can see it', async () => {
    for (let i = 0; i < 4; i += 1) await ask('driver1');

    expect(logs.join(' ')).toMatch(/driver1 has reached the request limit/);
  });
});
