// Story AA-55 (22263): one structure for every audit record, and one function
// that writes it. The four things the audit requirement names were kept in
// four shapes, and an application decision was not kept at all, so "what
// happened to this account" could not be asked as one question.
//
// This file is about the door itself -- src/audit/log.js. What each writer
// records as it moves over belongs with that writer's own tests;
// tests/password-change-audit.test.js is the first of them.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { recordEvent, MAX_DETAIL } = require('../src/audit/log');

let inserts;

beforeEach(() => {
  inserts = [];
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    inserts.push({ sql, params });
    return { insertId: 7 };
  });
});

afterEach(() => vi.restoreAllMocks());

const only = () => {
  expect(inserts).toHaveLength(1);
  return inserts[0];
};
const columns = () => {
  const [, type, actor, subject, sponsor, detail] = [null, ...only().params];
  return { type, actor, subject, sponsor, detail };
};

describe('one event, one row', () => {
  test('the five things an event is, and the id it was given', async () => {
    const id = await recordEvent({
      type: 'password.changed', actorId: 3, subjectId: 1, sponsorId: 2, detail: 'method=admin-reset',
    });

    expect(id).toBe(7);
    expect(only().sql).toMatch(/^INSERT INTO audit_events /);
    expect(columns()).toEqual({
      type: 'password.changed', actor: 3, subject: 1, sponsor: 2, detail: 'method=admin-reset',
    });
  });

  test('an event about nobody in particular is still a row', async () => {
    // A sign-in attempt on a username that does not exist has no subject, and
    // most events have no sponsor at all (story AA-57).
    await recordEvent({ type: 'password.changed' });

    expect(columns()).toEqual({
      type: 'password.changed', actor: null, subject: null, sponsor: null, detail: null,
    });
  });

  test('the row is timed by the database and not by the app', async () => {
    // Story AA-59: occurred_at is absent from the statement on purpose, so the
    // column default sets it. One clock for every row in the table, and no way
    // for a caller to write a time of its own choosing.
    await recordEvent({ type: 'password.changed', subjectId: 1 });

    expect(only().sql).not.toContain('occurred_at');
    expect(only().params.some(p => p instanceof Date)).toBe(false);
  });
});

describe('an event the app does not recognise', () => {
  test('is recorded as unknown, with what the caller said kept', async () => {
    // Never dropped: an event nobody can account for is the thing an audit log
    // exists to show. Never stored as given either, or the column stops
    // meaning what it says.
    await recordEvent({ type: 'points.invented', subjectId: 1, detail: 'points=50' });

    expect(columns()).toMatchObject({ type: 'unknown', detail: 'type=points.invented points=50' });
  });

  test('with nothing else to say, the type is the detail', async () => {
    await recordEvent({ type: 'nonsense' });

    expect(columns()).toMatchObject({ type: 'unknown', detail: 'type=nonsense' });
  });

  test('a call with no type at all is still recorded', async () => {
    await recordEvent();

    expect(columns()).toMatchObject({ type: 'unknown', detail: 'type=undefined' });
  });
});

describe('a detail longer than the column', () => {
  test('is cut to fit, and says that it was cut', async () => {
    const reason = 'r'.repeat(400);

    await recordEvent({ type: 'password.changed', detail: reason });

    const { detail } = columns();
    expect(detail).toHaveLength(MAX_DETAIL);
    expect(detail.endsWith('...')).toBe(true);
    expect(detail.startsWith('rrr')).toBe(true);
  });

  test('a detail that just fits is left alone', async () => {
    const reason = 'r'.repeat(MAX_DETAIL);

    await recordEvent({ type: 'password.changed', detail: reason });

    expect(columns().detail).toBe(reason);
  });
});

describe('a write that fails', () => {
  test('is not swallowed', async () => {
    // The caller finding out is the point. A request that errors is visible; a
    // log with a hole in it is not.
    db.query.mockRejectedValueOnce(new Error('table is gone'));

    await expect(recordEvent({ type: 'password.changed', subjectId: 1 })).rejects.toThrow('table is gone');
  });
});

describe('the migration', () => {
  const migration = readFileSync(new URL('../db/migrations/022_audit_events.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  // The definition, without the prose: the two files explain the table to
  // different readers, so only the columns, indexes and keys have to match.
  const definition = text => text
    .match(/CREATE TABLE IF NOT EXISTS audit_events \([\s\S]*?\n\);/)[0]
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .map(line => line.trim())
    .join(' ');

  test('and the schema file define the same table', () => {
    expect(definition(schema)).toBe(definition(migration));
  });

  test('carries the old rows across with the times they happened', () => {
    // Switching the writer must not leave the log starting from empty, and a
    // copied event happened when it happened, not when it was copied.
    expect(migration).toMatch(/INSERT INTO audit_events[\s\S]*FROM password_changes/);
    expect(migration).toContain('pc.changed_at');
  });

  test('copies all of them or none, so a rerun cannot duplicate or drop one', () => {
    // db:migrate reapplies every file on every run. Row-by-row skipping would
    // drop a second change to the same account in the same second.
    expect(migration).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM audit_events ae WHERE ae\.event_type = 'password\.changed'/);
  });
});
