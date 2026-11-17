// aa-55, aa-57 reading the audit log: four tables as one list, nothing dropped
// the statement itself was run against the real database... a mock cannot check
// SQL, so these tests pin its shape and the JavaScript around it
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { findEvents, countEvents, EVENT_TYPES, CATEGORIES, DEFAULT_LIMIT } = require('../src/audit/log');

let reads;
let rows;

beforeEach(() => {
  reads = [];
  rows = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    reads.push({ sql, params });
    return sql.includes('COUNT(*)') ? [{ total: 42 }] : rows;
  });
});

afterEach(() => vi.restoreAllMocks());

const sql = () => reads[0].sql.replace(/\s+/g, ' ');
const params = () => reads[0].params;

const dbRow = (over = {}) => ({
  type: 'password.changed', detail: 'method=profile', occurred_at_ms: '1794182400000.000000',
  actor_username: 'admin1', subject_user_id: 1, subject_username: 'driver1', subject_role: 'driver',
  sponsor_name: 'Acme Freight', ...over,
});

describe('one list from four tables', () => {
  test('reads audit_events, sign-ins, point changes and unlocks together', async () => {
    await findEvents();

    for (const table of ['audit_events ae', 'login_attempts la', 'point_transactions pt', 'login_unlocks lu']) {
      expect(sql()).toContain(`FROM ${table}`);
    }
    expect(sql().match(/UNION ALL/g)).toHaveLength(3);
    expect(sql()).toContain('ORDER BY e.occurred_at DESC, e.id DESC');
  });

  test('gives each event a label, names instead of ids, and a real time', async () => {
    rows = [dbRow()];

    const [event] = await findEvents();

    expect(event).toEqual({
      type: 'password.changed', label: 'Password changed', occurredAt: new Date(1794182400000),
      actor: 'admin1', subject: 'driver1', subjectId: 1, subjectRole: 'driver',
      sponsor: 'Acme Freight', detail: 'method=profile',
    });
  });

  test('aa-57 an event with no actor, account or sponsor is still listed', async () => {
    rows = [dbRow({ actor_username: null, subject_user_id: null, subject_username: null, subject_role: null, sponsor_name: null })];

    const events = await findEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: null, subject: null, sponsor: null });
    // an inner join would drop the whole row, not just the missing name
    expect(sql().match(/(LEFT )?JOIN (users|sponsors)/g).every(join => join.startsWith('LEFT'))).toBe(true);
  });

  test('a failed sign-in for a username that was never real keeps the username', async () => {
    rows = [dbRow({ type: 'login.failed', subject_user_id: null, subject_username: 'nobody', subject_role: null })];

    const [event] = await findEvents();

    expect(event).toMatchObject({ label: 'Failed sign-in', subject: 'nobody', subjectId: null });
  });

  test('a type from an older deploy reads as Other rather than breaking the page', async () => {
    rows = [dbRow({ type: 'something.old' })];

    expect((await findEvents())[0].label).toBe('Other');
  });
});

describe('filters', () => {
  test('no filter means no WHERE, so nothing can be filtered out', async () => {
    await findEvents();

    expect(sql()).not.toContain('WHERE e.');
    expect(params()).toEqual([String(DEFAULT_LIMIT), '0']);
  });

  test('a category becomes its event types, bound as values', async () => {
    await findEvents({ category: 'sign-ins' });

    expect(sql()).toContain('WHERE e.type IN (?, ?)');
    expect(params().slice(0, 2)).toEqual(['login.succeeded', 'login.failed']);
  });

  test('one account', async () => {
    await findEvents({ userId: 5 });

    expect(sql()).toContain('WHERE e.subject_user_id = ?');
    expect(params()[0]).toBe(5);
  });

  test("aa-57 a sponsor sees its drivers' events even though they carry no sponsor", async () => {
    await findEvents({ sponsorId: 7 });

    // ...but not an event that names another sponsor, for a driver they share
    expect(sql()).toContain('e.sponsor_id = ? OR (e.sponsor_id IS NULL AND EXISTS');
    expect(sql()).toContain('ds.driver_id = e.subject_user_id AND ds.sponsor_id = ?');
    expect(params().slice(0, 2)).toEqual([7, 7]);
  });

  test('aa-59 a date range is compared in SQL and includes the whole last day', async () => {
    await findEvents({ from: '2026-11-01', to: '2026-11-09' });

    expect(sql()).toContain('e.occurred_at >= ? AND e.occurred_at < ? + INTERVAL 1 DAY');
    expect(params().slice(0, 2)).toEqual(['2026-11-01', '2026-11-09']);
  });

  test("aa-76 an admin's changes to someone else's account, not their own", async () => {
    await findEvents({ userId: 5, byAdmin: true });

    expect(sql()).toContain("e.subject_user_id = ? AND e.actor_user_id <> e.subject_user_id AND EXISTS (SELECT 1 FROM users a WHERE a.id = e.actor_user_id AND a.role = 'admin')");
    expect(params()[0]).toBe(5);
  });

  test('every value is bound: as many placeholders as parameters', async () => {
    await findEvents({ category: 'accounts', userId: 5, sponsorId: 7, from: '2026-11-01', to: '2026-11-09' }, { limit: 10, offset: 20 });

    expect(reads[0].sql.match(/\?/g)).toHaveLength(params().length);
    expect(params().slice(-2)).toEqual(['10', '20']);
  });

  test('counting uses the same filters as listing', async () => {
    expect(await countEvents({ category: 'points', userId: 5 })).toBe(42);

    expect(sql()).toContain('WHERE e.type IN (?) AND e.subject_user_id = ?');
    expect(params()).toEqual(['points.changed', 5]);
  });
});

describe('what the reader refuses', () => {
  test('a category it does not know, rather than showing an empty log', async () => {
    await expect(findEvents({ category: 'nope' })).rejects.toThrow('Unknown audit log category');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a date that is not a date', async () => {
    await expect(findEvents({ to: "2026-11-09'; DROP TABLE audit_events; --" })).rejects.toThrow('YYYY-MM-DD');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a junk page size falls back to the default', async () => {
    await findEvents({}, { limit: 'all of them', offset: -5 });

    expect(params()).toEqual([String(DEFAULT_LIMIT), '0']);
  });
});

describe('categories', () => {
  test('every event type belongs to a category the page can filter by', () => {
    for (const [type, { category }] of Object.entries(EVENT_TYPES)) {
      expect(CATEGORIES[category], type).toBeTruthy();
    }
  });

  test('the four the project description names all have events', () => {
    for (const category of ['sign-ins', 'passwords', 'points', 'applications']) {
      expect(Object.values(EVENT_TYPES).some(type => type.category === category), category).toBe(true);
    }
  });
});
