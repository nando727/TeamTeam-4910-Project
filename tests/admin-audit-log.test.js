// aa-55 the audit log page: every audited event in one list
// an admin sees all of it, a sponsor its own drivers
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const ADMIN = { id: 3, username: 'admin1', role: 'admin', status: 'active', name: 'Ada', email: 'ada@example.com', sponsor_id: null };
const DRIVER = { id: 1, username: 'driver1', role: 'driver', status: 'active', name: 'Theo', email: 'theo@example.com', sponsor_id: null };
const SPONSOR = { id: 2, username: 'sponsor1', role: 'sponsor', status: 'active', name: 'Sam', email: 'sam@example.com', sponsor_id: 7 };
const USERS = [ADMIN, DRIVER, SPONSOR];

let hash;
let rows;
let total;
let queries;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

// one event from each of the four tables the log reads
const event = (over = {}) => ({
  type: 'role.changed', detail: 'driver to sponsor', occurred_at_ms: Date.UTC(2026, 10, 10, 12, 0),
  actor_username: 'admin1', subject_user_id: 1, subject_username: 'driver1', subject_role: 'sponsor',
  sponsor_name: null, ...over,
});

beforeEach(() => {
  queries = [];
  rows = [
    event(),
    event({ type: 'points.changed', detail: '+50 points: safe driving', actor_username: 'sponsor1', sponsor_name: 'Acme' }),
    event({ type: 'account.unlocked', detail: null }),
    event({ type: 'login.failed', detail: 'from 203.0.113.7', actor_username: null, subject_user_id: null, subject_username: 'nobody', subject_role: null }),
  ];
  total = rows.length;
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    queries.push([sql, params]);
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = USERS.find(u => u.username === params[0]);
      return user ? [{ ...user, password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const user = USERS.find(u => u.id === params[0]);
      return user ? [user] : [];
    }
    if (sql.includes('FROM audit_events ae')) return sql.includes('COUNT(*)') ? [{ total }] : rows;
    if (sql.includes('FROM sponsors ORDER BY')) return [{ id: 4, name: 'Acme', contactEmail: 'a@acme.example', status: 'active' }];
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function signIn(username = 'admin1') {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}

const listQuery = () => queries.filter(([sql]) => sql.includes('FROM audit_events ae') && !sql.includes('COUNT(*)')).pop();

describe('who can see it', () => {
  test('an admin can, from a link on the home page', async () => {
    const agent = await signIn();
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('href="/admin/audit-log"');
    await agent.get('/admin/audit-log').expect(200);
  });

  test('a signed-out visitor is sent to log in, and a driver is refused', async () => {
    await request(app).get('/admin/audit-log').expect(302);
    const driver = await signIn('driver1');
    await driver.get('/admin/audit-log').expect(403);
  });
});

describe('what it shows', () => {
  test('events from every source in one table: what, to whom, by whom, when', async () => {
    const page = await (await signIn()).get('/admin/audit-log').expect(200);

    for (const label of ['Role changed', 'Points changed', 'Sign-in unlocked', 'Failed sign-in']) {
      expect(page.text).toContain(label);
    }
    expect(page.text).toContain('+50 points: safe driving');
    expect(page.text).toContain('2026-11-10 12:00');
    expect(page.text).toContain('Showing 1 to 4 of 4 events.');
    expect(page.text).toContain('href="/admin/audit-log?user=1"');
  });

  test('a failed sign-in for a username that is not an account still appears', async () => {
    const page = await (await signIn()).get('/admin/audit-log').expect(200);

    expect(page.text).toContain('nobody');
    expect(page.text).toContain('(no such account)');
  });

  test('says plainly when there is nothing to show', async () => {
    rows = [];
    total = 0;
    const agent = await signIn();

    expect((await agent.get('/admin/audit-log').expect(200)).text).toContain('Nothing has been recorded yet.');
    expect((await agent.get('/admin/audit-log?category=points').expect(200)).text).toContain('Nothing matches these filters.');
  });
});

describe('filtering and paging', () => {
  test('by category and by account', async () => {
    const page = await (await signIn()).get('/admin/audit-log?category=sign-ins&user=1').expect(200);

    expect(page.text).toContain('<option value="sign-ins" selected>');
    expect(page.text).toContain('Filtered to <strong>driver1</strong>');
    expect(listQuery()[1].slice(0, 3)).toEqual(['login.succeeded', 'login.failed', 1]);
  });

  test('a category that does not exist is ignored rather than an error', async () => {
    await (await signIn()).get('/admin/audit-log?category=nonsense').expect(200);

    expect(listQuery()[0]).not.toContain('e.type IN');
  });

  test('pages keep the filters in their links', async () => {
    total = 60;
    const page = await (await signIn()).get('/admin/audit-log?category=accounts&page=2').expect(200);

    expect(page.text).toContain('Page 2 of 3');
    expect(page.text).toContain('href="/admin/audit-log?category=accounts&amp;page=3"');
    expect(listQuery()[1].slice(-2)).toEqual(['25', '25']);
  });
});

describe('the report filters the spec asks for', () => {
  test('one sponsor and a date range reach the query, and the count says the range', async () => {
    const page = await (await signIn()).get('/admin/audit-log?sponsor=4&from=2026-11-01&to=2026-11-09').expect(200);

    expect(page.text).toContain('<option value="4" selected>Acme</option>');
    expect(page.text).toContain('from 2026-11-01 to 2026-11-09');
    expect(listQuery()[1].slice(0, 4)).toEqual([4, 4, '2026-11-01', '2026-11-09']);
  });

  test('a sponsor that does not exist is ignored', async () => {
    await (await signIn()).get('/admin/audit-log?sponsor=999').expect(200);

    expect(listQuery()[0]).not.toContain('e.sponsor_id = ?');
  });

  test('a date that is not a date is refused with a message', async () => {
    const page = await (await signIn()).get('/admin/audit-log?from=yesterday').expect(400);

    expect(page.text).toContain('Enter the start date as YYYY-MM-DD.');
  });
});

describe('the CSV download', () => {
  test('has every row for the same filters, as a file', async () => {
    const agent = await signIn();
    const page = await agent.get('/admin/audit-log?category=points&from=2026-11-01').expect(200);
    expect(page.text).toContain('href="/admin/audit-log.csv?category=points&amp;from=2026-11-01"');

    const csv = await agent.get('/admin/audit-log.csv?category=points&from=2026-11-01').expect(200);

    expect(csv.headers['content-disposition']).toContain('audit-log-from-2026-11-01.csv');
    expect(csv.text).toContain('"Date (UTC)","Category","Event","Account","By","Sponsor","Detail"');
    expect(csv.text).toContain('"2026-11-10 12:00","Point changes","Points changed","driver1","sponsor1","Acme","\'+50 points: safe driving"');
    // not paged: one query, with the filters and no offset
    expect(listQuery()[1]).toEqual(['points.changed', '2026-11-01', '10000', '0']);
  });

  test('refuses a bad date instead of downloading everything', async () => {
    const res = await (await signIn()).get('/admin/audit-log.csv?to=nope').expect(400);

    expect(res.text).toContain('Enter the end date as YYYY-MM-DD.');
  });

  test('is admin only', async () => {
    await request(app).get('/admin/audit-log.csv').expect(302);
    await (await signIn('driver1')).get('/admin/audit-log.csv').expect(403);
  });
});

describe("a sponsor's audit log", () => {
  test('is pinned to its own organization, whatever the form asks for', async () => {
    const agent = await signIn('sponsor1');
    const page = await agent.get('/reports/audit-log?sponsor=4&user=1&category=points').expect(200);

    expect(listQuery()[1]).toEqual(['points.changed', 7, 7, '25', '0']);
    expect(page.text).not.toContain('name="sponsor"');
    expect(page.text).not.toContain('?user=');
    expect(page.text).toContain('href="/reports/audit-log.csv?category=points"');
    await agent.get('/admin/audit-log').expect(403);
  });

  test('shows that a driver signed in, not where from, on the page and in the CSV', async () => {
    const agent = await signIn('sponsor1');
    const page = await agent.get('/reports/audit-log').expect(200);
    const csv = await agent.get('/reports/audit-log.csv').expect(200);

    for (const text of [page.text, csv.text]) {
      expect(text).toContain('Failed sign-in');
      expect(text).not.toContain('203.0.113.7');
      expect(text).toContain('+50 points: safe driving');
    }
    expect(listQuery()[1]).toEqual([7, 7, '10000', '0']);
  });

  test('a signed-out visitor is sent to log in, and a driver is refused', async () => {
    await request(app).get('/reports/audit-log').expect(302);
    await (await signIn('driver1')).get('/reports/audit-log.csv').expect(403);
  });
});
