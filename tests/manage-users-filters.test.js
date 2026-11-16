// Sprint 9: Manage users can be searched and filtered, pages at 25 accounts,
// keeps the filters through paging and through an action taken from a row,
// and says plainly when nothing matches.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const SPONSORS = [
  { id: 7, name: 'Northstar Freight', contactEmail: 'ops@northstar.test', status: 'active' },
  { id: 8, name: 'Southstar Haulage', contactEmail: 'ops@southstar.test', status: 'inactive' },
];
const ADMIN = { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada Admin', email: 'ada@example.com' };

let hash;
let listed;
let total;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  queries = [];
  total = 2;
  listed = [
    { id: 1, name: 'Theo Trucker', email: 'theo@example.com', username: 'driver1', role: 'driver', status: 'active', sponsorId: null, sponsorNames: 'Northstar Freight' },
    { id: 2, name: 'Sam Sponsor', email: 'sam@northstar.test', username: 'sponsor1', role: 'sponsor', status: 'disabled', sponsorId: 7, sponsorNames: 'Northstar Freight' },
  ];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) return params[0] === 'admin1' ? [{ ...ADMIN, password_hash: hash }] : [];
    if (sql.includes('FROM users WHERE id')) return [ADMIN];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM users u')) return [{ total }];
    if (sql.startsWith('SELECT u.id, u.name, u.email, u.username, u.role, u.status')) return listed;
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail')) return SPONSORS;
    if (sql.startsWith('SELECT user_id FROM setup_tokens')) return [];
    if (sql.startsWith('UPDATE users SET status')) return { affectedRows: 1 };
    if (sql.startsWith('INSERT INTO admin_actions')) return { insertId: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function admin() {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: 'admin1', password: 'Password1!' }).expect(302);
  return agent;
}
const listQuery = () => queries.find(([sql]) => sql.startsWith('SELECT u.id, u.name, u.email'));
const countQuery = () => queries.find(([sql]) => sql.startsWith('SELECT COUNT(*) AS total FROM users u'));

describe('the list', () => {
  test('shows each account\'s name, email, and organization, and offers the filters', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users').expect(200);
    expect(page.text).toContain('Theo Trucker');
    expect(page.text).toContain('theo@example.com');
    expect(page.text).toContain('Northstar Freight');
    expect(page.text).toContain('name="q"');
    expect(page.text).toContain('<option value="driver" >driver</option>');
    expect(page.text).toContain('<option value="revoked" >revoked</option>');
    expect(page.text).toContain('>Southstar Haulage</option>');
    expect(page.text).toContain('Showing 1 to 2 of 2 accounts.');
    // No filters, so no WHERE clause on the list itself (the organization
    // column's subqueries have their own).
    expect(listQuery()[0]).toContain('FROM users u ORDER BY');
    expect(listQuery()[1]).toEqual([]);
    expect(listQuery()[0]).toContain('LIMIT 25 OFFSET 0');
  });

  test('searches name, username, and email together, with wildcards escaped', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?q=100%25_theo').expect(200);
    const [sql, params] = listQuery();
    expect(sql).toContain('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
    expect(params).toEqual(['%100\\%\\_theo%', '%100\\%\\_theo%', '%100\\%\\_theo%']);
    // The box keeps what was typed, escaped for the page.
    expect(page.text).toContain('value="100%_theo"');
    // The count asks the same question as the page.
    expect(countQuery()[1]).toEqual(params);
  });

  test('filters by role, status, and sponsor, together', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?role=driver&status=active&sponsor=7').expect(200);
    const [sql, params] = listQuery();
    expect(sql).toContain('u.role = ?');
    expect(sql).toContain('u.status = ?');
    expect(sql).toContain('u.sponsor_id = ?');
    expect(sql).toContain('FROM driver_sponsors ds WHERE ds.driver_id = u.id AND ds.sponsor_id = ?');
    expect(params).toEqual(['driver', 'active', 7, 7]);
    expect(page.text).toContain('<option value="driver" selected>');
    expect(page.text).toContain('<option value="7" selected>');
  });

  test('a sponsor that does not exist is refused rather than quietly matching nothing', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?sponsor=99').expect(400);
    expect(page.text).toContain('Choose a sponsor organization from the list.');
    expect(listQuery()[1]).toEqual([]);
  });

  test('pages at 25 and keeps the filters in the page links', async () => {
    total = 60;
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?q=a&role=driver&page=2').expect(200);
    expect(listQuery()[0]).toContain('LIMIT 25 OFFSET 25');
    expect(page.text).toContain('Showing 26 to 50 of 60 accounts');
    expect(page.text).toContain('Page 2 of 3');
    expect(page.text).toContain('href="/admin/manage-users?q=a&amp;role=driver"');
    expect(page.text).toContain('href="/admin/manage-users?q=a&amp;role=driver&amp;page=3"');
  });

  test('a page past the end shows the last page rather than an empty one', async () => {
    total = 30;
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?page=99').expect(200);
    expect(page.text).toContain('Page 2 of 2');
    expect(listQuery()[0]).toContain('OFFSET 25');
  });

  test('says what did not match, naming the filters, and offers to clear them', async () => {
    listed = [];
    total = 0;
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?q=nobody&role=sponsor&status=revoked&sponsor=8').expect(200);
    expect(page.text).toContain('No accounts match these filters.');
    expect(page.text).toContain('a search for "nobody"');
    expect(page.text).toContain('the sponsor role');
    expect(page.text).toContain('the revoked status');
    expect(page.text).toContain('Southstar Haulage');
    expect(page.text).toContain('clear the filters');
  });

  test('an empty database says something different from an empty search', async () => {
    listed = [];
    total = 0;
    const agent = await admin();
    const page = await agent.get('/admin/manage-users').expect(200);
    expect(page.text).toContain('No users have been created yet.');
    expect(page.text).not.toContain('No accounts match these filters.');
  });
});

describe('keeping the filters through an action', () => {
  test('every row carries the filters as hidden fields, escaped', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?q=%22%3Cb%3E&role=driver&sponsor=7&page=2').expect(200);
    expect(page.text).toContain('name="fq" value="&#34;&lt;b&gt;"');
    expect(page.text).toContain('name="frole" value="driver"');
    expect(page.text).toContain('name="fsponsor" value="7"');
    expect(page.text).not.toContain('value=""><b>');
  });

  test('a status change returns to the filtered list', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users?q=theo&role=driver').expect(200);
    const token = page.text.match(/name="token" value="([a-f0-9]+)"/)[1];
    const res = await agent.post('/admin/manage-users/1/status').type('form')
      .send({ token, status: 'active', from: 'manage-users', fq: 'theo', frole: 'driver', fstatus: '', fsponsor: '', fpage: '2' })
      .expect(303);
    // The filters come back; the page does not, because the row may have moved.
    expect(res.headers.location).toBe('/admin/manage-users?q=theo&role=driver');
  });

  test('a forged filter field cannot inject anything into the return path', async () => {
    const agent = await admin();
    const page = await agent.get('/admin/manage-users').expect(200);
    const token = page.text.match(/name="token" value="([a-f0-9]+)"/)[1];
    const res = await agent.post('/admin/manage-users/1/status').type('form')
      .send({ token, status: 'active', from: 'manage-users', frole: 'wizard', fstatus: 'melted', fsponsor: 'abc', fq: 'ok' })
      .expect(303);
    // Only values the page itself would offer survive.
    expect(res.headers.location).toBe('/admin/manage-users?q=ok');
  });
});
