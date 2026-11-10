// Story AA-57 (22265): audit records are kept when no sponsor applies.
//
// The table has allowed a NULL sponsor, actor and subject since story AA-55,
// so there is nothing left to "keep" at write time -- the records already go
// in. What this story is really about is the read, because every natural way
// to write the query throws those rows away and says nothing:
//
//   WHERE sponsor_id = ?   NULL is not equal to anything, so a password change
//                          or a login attempt vanishes from a filtered report
//   JOIN users ON ...      an inner join drops the whole row when the actor is
//                          NULL, not just the actor's name
//   event_type IN (...)    a category list that forgot a type hides it forever
//
// Two of those three live in SQL that a mocked database cannot evaluate
// honestly -- a fake that reproduced MySQL's NULL rules would only be testing
// itself -- so the statement itself is asserted here. The JS either side of it
// (what is filtered out after the query, how a row is mapped) is tested on
// rows, the way everything else in this suite is.
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const {
  findEvents, categoryOf,
  EVENT_TYPES, EVENT_CATEGORIES, DEFAULT_LIMIT,
  UnknownCategoryError, BadDateError,
} = require('../src/audit/log');

let reads;   // every [sql, params] findEvents sent
let rows;    // what the database hands back

beforeEach(() => {
  reads = [];
  rows = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    reads.push({ sql, params });
    return rows;
  });
});

afterEach(() => vi.restoreAllMocks());

const sql = () => reads[0].sql;
const params = () => reads[0].params;
// Collapses the whitespace the statement is built with, so an assertion reads
// like the SQL rather than like the concatenation.
const flat = () => sql().replace(/\s+/g, ' ');

// A row shaped the way mysql2 hands one back from this statement.
const dbRow = (over = {}) => ({
  id: 1,
  event_type: 'password.changed',
  detail: 'method=profile',
  occurred_at_ms: 1762700000000,
  actor_username: 'admin1',
  subject_username: 'driver1',
  sponsor_name: 'Acme Freight',
  ...over,
});

describe('a record with nothing in its nullable columns survives the read', () => {
  test('no sponsor, no actor, no subject: still returned', async () => {
    // A failed login for a username that does not exist is all three at once,
    // and is exactly the record an audit log is read for.
    rows = [dbRow({ sponsor_name: null, actor_username: null, subject_username: null })];

    const events = await findEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sponsor: null, actor: null, subject: null });
  });

  test('the nulls come back as null, not dropped keys or empty strings', async () => {
    rows = [dbRow({ sponsor_name: null, actor_username: null, subject_username: null })];

    const [event] = await findEvents();

    expect(Object.keys(event).sort()).toEqual(
      ['actor', 'category', 'detail', 'id', 'occurredAtMs', 'sponsor', 'subject', 'type'],
    );
    expect(event.detail).toBe('method=profile');
  });

  test('a mix of complete and sponsor-less rows returns both', async () => {
    rows = [dbRow({ id: 2, sponsor_name: null }), dbRow({ id: 1 })];

    const events = await findEvents();

    expect(events.map(e => e.id)).toEqual([2, 1]);
  });
});

describe('the statement itself', () => {
  test('an admin reading everything filters on nothing at all', async () => {
    // Not "matches any sponsor" -- no WHERE clause exists. A filter that is
    // never applied cannot drop the rows with nothing in the column. The
    // column still appears in the LEFT JOIN that fetches the sponsor's name,
    // which is the one mention of it that keeps rows rather than losing them.
    await findEvents();

    expect(flat()).not.toContain('WHERE');
    expect(flat()).not.toContain('ae.sponsor_id = ?');
    expect(flat()).toContain('LEFT JOIN sponsors sponsor ON sponsor.id = ae.sponsor_id');
  });

  test('one sponsor is matched through its drivers as well as the column', async () => {
    await findEvents({ sponsorId: 7 });

    // The bug this story exists to prevent is this line without the OR.
    expect(flat()).toContain('ae.sponsor_id = ? OR EXISTS');
    expect(flat()).toContain('ds.driver_id = ae.subject_user_id AND ds.sponsor_id = ?');
    expect(params().slice(0, 2)).toEqual([7, 7]);
  });

  test('every join to a nullable column is a LEFT join', async () => {
    await findEvents();

    const joins = flat().match(/(LEFT )?JOIN \w+/g) || [];
    expect(joins).toHaveLength(3);
    expect(joins.every(j => j.startsWith('LEFT JOIN'))).toBe(true);
  });

  test('the date range ends inclusively, by the day and not by its midnight', async () => {
    await findEvents({ from: '2026-11-01', to: '2026-11-09' });

    expect(flat()).toContain('ae.occurred_at >= ?');
    // `<= '2026-11-09'` would hide everything that happened today.
    expect(flat()).toContain('ae.occurred_at < ? + INTERVAL 1 DAY');
    expect(flat()).not.toContain('occurred_at <=');
    expect(params()).toEqual(['2026-11-01', '2026-11-09', DEFAULT_LIMIT]);
  });

  test('the time crosses as a number, computed by the database', async () => {
    // Story AA-59: a DATETIME handed to the driver comes back as a Date at
    // local midnight, so the conversion happens in SQL or not at all.
    await findEvents();

    expect(flat()).toContain('UNIX_TIMESTAMP(ae.occurred_at) * 1000');
    expect(params().some(p => p instanceof Date)).toBe(false);
  });

  test('the time is a number by the time a caller sees it', async () => {
    // UNIX_TIMESTAMP(...) * 1000 is a DECIMAL, and mysql2 hands DECIMALs back
    // as strings -- checked against the real server, which returns
    // "1794182400000.000000" for this. A string would sort and compare wrongly
    // everywhere downstream without ever looking wrong.
    rows = [dbRow({ occurred_at_ms: '1794182400000.000000' })];

    const [event] = await findEvents();

    expect(event.occurredAtMs).toBe(1794182400000);
    expect(typeof event.occurredAtMs).toBe('number');
  });

  test('newest first, and ties broken so the order is stable', async () => {
    await findEvents();

    expect(flat()).toContain('ORDER BY ae.occurred_at DESC, ae.id DESC');
  });

  test('every value is bound, and the counts match', async () => {
    await findEvents({ sponsorId: 7, category: 'login-attempts', from: '2026-11-01', to: '2026-11-09' });

    expect((sql().match(/\?/g) || []).length).toBe(params().length);
    expect(sql()).not.toContain("'");
  });

  test('a category becomes placeholders, never the type names inline', async () => {
    await findEvents({ category: 'login-attempts' });

    expect(flat()).toContain('ae.event_type IN (?, ?)');
    expect(flat()).not.toContain('login.failed');
    expect(params()).toEqual(['login.succeeded', 'login.failed', DEFAULT_LIMIT]);
  });

  test('the row ceiling is bound too, and a junk limit falls back', async () => {
    await findEvents({ limit: 10 });
    expect(params().at(-1)).toBe(10);

    reads = [];
    await findEvents({ limit: 'all of them' });
    expect(params().at(-1)).toBe(DEFAULT_LIMIT);
  });
});

describe('categories cover the log, so no filter can hide a row', () => {
  test('every type a writer may use belongs to exactly one category', async () => {
    for (const type of EVENT_TYPES) {
      const owners = Object.keys(EVENT_CATEGORIES).filter(c => EVENT_CATEGORIES[c].includes(type));
      expect(owners, type).toHaveLength(1);
    }
  });

  test('the four categories the spec names are all there, and all non-empty', async () => {
    // The project description's audit log report is filtered "by audit log
    // category" and names these four. Some have no writer yet; an empty list
    // would make that category a report that says nothing happened.
    for (const name of ['driver-applications', 'point-changes', 'password-changes', 'login-attempts']) {
      expect(EVENT_CATEGORIES[name], name).toBeTruthy();
      expect(EVENT_CATEGORIES[name].length, name).toBeGreaterThan(0);
    }
  });

  test("the writer's fallback type is reachable through a category", async () => {
    // recordEvent stores an unrecognised type as 'unknown' rather than
    // dropping it. If no category held it, a filtered report never would.
    expect(EVENT_TYPES).toContain('unknown');
    expect(categoryOf('unknown')).toBe('other');
  });

  test('a type that predates its category reads as other, rather than nothing', async () => {
    rows = [dbRow({ event_type: 'something.from.an.older.deploy' })];

    const [event] = await findEvents();

    expect(event.category).toBe('other');
    expect(event.type).toBe('something.from.an.older.deploy');
  });
});

describe('what the reader refuses', () => {
  test('a category nobody recognises, rather than an empty report', async () => {
    // An empty report and a misspelled filter look identical on screen, and
    // only one of them means nothing happened.
    await expect(findEvents({ category: 'passwords' })).rejects.toThrow(UnknownCategoryError);
    expect(reads).toEqual([]);
  });

  test('a date that is not a date', async () => {
    await expect(findEvents({ from: 'last tuesday' })).rejects.toThrow(BadDateError);
    await expect(findEvents({ to: "2026-11-09'; DROP TABLE audit_events; --" })).rejects.toThrow(BadDateError);
    expect(reads).toEqual([]);
  });

  test('nothing is read when an argument is refused', async () => {
    // A refusal that had already run the query would be a report shown and an
    // error raised at once.
    await expect(findEvents({ sponsorId: 7, category: 'nope' })).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('what the reader does not do', () => {
  test('an empty log reads as an empty list, not an error', async () => {
    rows = [];
    await expect(findEvents({ sponsorId: 7 })).resolves.toEqual([]);
  });

  test('neither a password nor a hash can appear in what is read back', async () => {
    // The columns selected are fixed here, so this asserts the statement never
    // reaches for one it should not.
    await findEvents();

    expect(sql()).not.toContain('password');
  });
});
