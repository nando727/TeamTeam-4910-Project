// RC#1: the admin bulk upload page and the shared loader.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { BulkLoader } = require('../src/bulk/loader');
const { parseText } = require('../src/bulk/parser');
const { clearOutbox, sentMessages } = require('../src/mail/mailer');

const PASSWORD = 'Password1!';
const SAMPLE = readFileSync(new URL('../docs/bulk-upload-sample.txt', import.meta.url), 'utf8');
const originalTransport = process.env.MAIL_TRANSPORT;

const accounts = {
  admin1: { id: 3, role: 'admin', status: 'active', sponsor_id: null },
  sponsor1: { id: 2, role: 'sponsor', status: 'active', sponsor_id: 1 },
  driver1: { id: 1, role: 'driver', status: 'active', sponsor_id: null },
};
let passwordHash;
let sponsors, users, memberships, tokens, conn;

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  process.env.MAIL_TRANSPORT = 'silent';
  clearOutbox();
  sponsors = [{ id: 1, name: 'Demo Sponsor', contactEmail: 'demo@example.com', status: 'active' }];
  users = [{ id: 1, username: 'driver1', email: 'driver1@example.com' }, { id: 9, username: 'pat.driver', email: 'taken@example.com' }];
  memberships = [];
  tokens = [];
  conn = {
    execute: vi.fn(async sql => {
      if (sql.includes('FOR UPDATE')) return [[{ point_balance: 0 }]];
      if (sql.includes('INSERT INTO point_transactions')) return [{ insertId: 77 }];
      return [{}];
    }),
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
  };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.includes('FROM login_attempts') && sql.includes('COUNT(*)')) return [{ failures: 0, latest_failure: null }];
    if (sql.includes('FROM users WHERE username = ?') && sql.includes('password_hash')) {
      const a = accounts[params[0]];
      return a ? [{ ...a, username: params[0], password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const [name, a] = Object.entries(accounts).find(([, u]) => u.id === params[0]) || [];
      return a ? [{ ...a, username: name, name: null, email: null }] : [];
    }
    if (sql === 'SELECT id FROM users WHERE username = ?') return users.filter(u => u.username === params[0]);
    if (sql.startsWith('SELECT id FROM users WHERE email')) return users.filter(u => u.email === params[0]);
    if (sql.startsWith('INSERT INTO users')) {
      const [name, email, username, , role, sponsorId] = params;
      const id = 100 + users.length;
      users.push({ id, name, email, username, role, sponsorId });
      return { insertId: id };
    }
    if (sql.includes('FROM sponsors ORDER BY')) return sponsors;
    if (sql.startsWith('INSERT INTO sponsors')) {
      const [name, contactEmail, , address] = params;
      const id = 10 + sponsors.length;
      sponsors.push({ id, name, contactEmail, address, status: 'active' });
      return { insertId: id };
    }
    if (sql.startsWith('INSERT INTO setup_tokens')) { tokens.push(params); return { insertId: tokens.length }; }
    if (sql.startsWith('INSERT INTO driver_sponsors')) { memberships.push(params); return { affectedRows: 1 }; }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  if (originalTransport === undefined) delete process.env.MAIL_TRANSPORT; else process.env.MAIL_TRANSPORT = originalTransport;
});

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: PASSWORD }).expect(302);
  return agent;
}
async function tokenFor(agent) {
  const page = await agent.get('/admin/bulk-upload').expect(200);
  return page.text.match(/name="token" value="([^"]+)"/)[1];
}
// The token field must precede the file, as the form does.
const upload = (agent, token, content, name = 'load.txt') =>
  agent.post('/admin/bulk-upload').field('token', token).attach('file', Buffer.from(content), name);

describe('the page', () => {
  test('admins only, and it documents the format from the single definition', async () => {
    await request(app).get('/admin/bulk-upload').expect(302).expect('Location', '/login');
    const sponsor = await login('sponsor1');
    await sponsor.get('/admin/bulk-upload').expect(403);
    const driver = await login('driver1');
    await driver.get('/admin/bulk-upload').expect(403);
    const admin = await login('admin1');
    const page = await admin.get('/admin/bulk-upload').expect(200);
    expect(page.text).toContain('O|organization name');
    expect(page.text).toContain('D|organization name|first name|last name|email|[points]|[reason]');
    expect(page.text).toContain('enctype="multipart/form-data"');
    expect(page.text).toContain('href="/admin/bulk-upload/sample.txt"');
    expect(page.text).toContain('There is no row type for admin users.');
    const home = await admin.get('/').expect(200);
    expect(home.text).toContain('href="/admin/bulk-upload"');
  });

  test('the sample file downloads and matches the repo copy', async () => {
    const admin = await login('admin1');
    const res = await admin.get('/admin/bulk-upload/sample.txt').expect(200);
    expect(res.headers['content-disposition']).toContain('bulk-upload-sample.txt');
    expect(res.text).toBe(SAMPLE);
  });

  test('a missing or wrong form token is refused before any row is processed', async () => {
    const admin = await login('admin1');
    await admin.post('/admin/bulk-upload').attach('file', Buffer.from('O|Nope\n'), 'x.txt').expect(403);
    await admin.post('/admin/bulk-upload').field('token', 'wrong').attach('file', Buffer.from('O|Nope\n'), 'x.txt').expect(403);
    expect(sponsors).toHaveLength(1);
  });

  test('no file is a 400 with a message', async () => {
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await admin.post('/admin/bulk-upload').field('token', token).expect(400);
    expect(res.text).toContain('Choose a file to upload.');
  });
});

describe('processing the sample file', () => {
  test('every rule in the stories is exercised and reported by line', async () => {
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await upload(admin, token, SAMPLE, 'bulk-upload-sample.txt').expect(200);
    const t = res.text;

    // Story 2: the O row creates the organization and later rows use it.
    expect(sponsors.map(s => s.name)).toContain('Coastal Carriers');
    expect(t).toContain('Created organization &#34;Coastal Carriers&#34;');
    // S and D rows created with setup links; usernames derive from the email.
    expect(users.map(u => u.username)).toEqual(expect.arrayContaining(['casey', 'pat.driver2', 'robin.rider', 'alex.able']));
    expect(users.find(u => u.username === 'casey')).toMatchObject({ role: 'sponsor', sponsorId: 11 });
    expect(users.find(u => u.username === 'robin.rider')).toMatchObject({ role: 'driver', sponsorId: null });
    expect(tokens).toHaveLength(4);
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO users')).every(([, p]) => p[3] === '!no-password-set')).toBe(true);
    expect((t.match(/class="setup-link"/g) || []).length).toBe(4);
    expect(t).toContain('/setup/');
    // Story 4 contract: memberships for each driver.
    expect(memberships).toEqual([[103, 11], [104, 11], [105, 11]]);
    // Points through the shared transaction, with the admin as the actor.
    expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO point_transactions'), [104, 11, 3, 150, 'Welcome bonus']);
    expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO point_transactions'), [105, 11, 3, -20, 'Late paperwork']);
    expect(conn.commit).toHaveBeenCalledTimes(2);
    // Errors, each skipped, processing continued to line 10.
    expect(t).toContain('Points were given without a reason.');
    expect(t).toContain('Organization &#34;No Such Org&#34; does not exist and was not created earlier in this file.');
    expect(t).toContain('Admin users cannot be created by upload.');
    expect(t).toContain('A user with that email already exists.');
    expect(t).toContain('&#34;not-an-email&#34; is not a valid email address.');
    expect(t).toContain('with -20 points (balance -20)');
    // Summary numbers.
    for (const [label, n] of [['Rows read', 10], ['Organizations created', 1], ['Sponsor users created', 1], ['Driver users created', 3], ['Point changes', 2], ['Rows with errors', 5]]) {
      expect(t).toMatch(new RegExp(`${label}</span><span class="total__value[^"]*">${n}<`));
    }
    expect(t).toContain('5 rows were skipped.');
    // Setup emails went through the mail seam.
    expect(sentMessages()).toHaveLength(4);
    expect(sentMessages()[0].subject).toContain('Set up your');
  });

  test('an existing organization can be used without an O row, and a repeated O row is skipped not failed', async () => {
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await upload(admin, token, 'D|Demo Sponsor|New|Person|new.person@example.com\nO|demo sponsor\n').expect(200);
    expect(res.text).toContain('Created driver new.person in Demo Sponsor.');
    expect(res.text).toContain('already exists; rows below can still use it');
    expect(res.text).toMatch(/Rows with errors<\/span><span class="total__value[^"]*">0</);
    expect(sponsors).toHaveLength(1);
  });

  test('a row whose points fail still reports the created user and the reason', async () => {
    conn.execute.mockImplementation(async sql => {
      if (sql.includes('FOR UPDATE')) return [[]];
      return [{}];
    });
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await upload(admin, token, 'D|Demo Sponsor|Q|R|qr@example.com|10|Bonus\n').expect(200);
    expect(res.text).toContain('but the points were not applied');
    expect(res.text).toMatch(/Rows with errors<\/span><span class="total__value[^"]*">1</);
  });

  test('an empty file is handled', async () => {
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await upload(admin, token, '\n\n').expect(200);
    expect(res.text).toContain('The file had no rows.');
  });

  test('a large file streams through without a size limit', async () => {
    const lines = ['O|Big Org'];
    for (let i = 0; i < 3000; i++) lines.push(`D|Big Org|First${i}|Last${i}|big${i}@example.com`);
    const admin = await login('admin1');
    const token = await tokenFor(admin);
    const res = await upload(admin, token, lines.join('\n') + '\n', 'big.txt').expect(200);
    expect(res.text).toMatch(/Driver users created<\/span><span class="total__value[^"]*">3000</);
    expect(memberships).toHaveLength(3000);
  }, 60000);
});

describe('the shared loader with a sponsor-scoped actor (sponsor-side upload)', () => {
  const run = async (actor, text) => {
    const loader = new BulkLoader({ actor, linkFor: raw => `http://x/setup/${raw}` });
    await loader.start();
    for (const item of parseText(text)) await loader.apply(item);
    return loader;
  };

  test('refuses O rows and other organizations, loads its own', async () => {
    sponsors.push({ id: 2, name: 'Other Freight', contactEmail: 'o@example.com', status: 'active' });
    const loader = await run({ id: 2, role: 'sponsor', sponsorId: 1 }, [
      'O|Brand New Org',
      'S|Other Freight|A|B|ab@example.com',
      'D|Demo Sponsor|Own|Driver|own.driver@example.com|25|Signing bonus',
    ].join('\n'));
    expect(loader.results.map(r => r.status)).toEqual(['error', 'error', 'created']);
    expect(loader.results[0].message).toBe('Only administrators can create organizations.');
    expect(loader.results[1].message).toBe('You can only add users to your own organization.');
    expect(memberships).toEqual([[102, 1]]);
    // The sponsor user is the actor on the point change.
    expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO point_transactions'), [102, 1, 2, 25, 'Signing bonus']);
    expect(sponsors).toHaveLength(2);
  });
});
