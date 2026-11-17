// aa-55 the audit writer: one function, one row in audit_events
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { recordEvent, MAX_DETAIL } = require('../src/audit/log');

let inserts;

beforeEach(() => {
  inserts = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    inserts.push({ sql, params });
    return { insertId: 7 };
  });
});

afterEach(() => vi.restoreAllMocks());

// [event_type, actor, subject, sponsor, detail]
const row = () => inserts[0].params;

describe('recording an event', () => {
  test('writes the type, who did it, whose account, the sponsor and the detail', async () => {
    const id = await recordEvent({ type: 'role.changed', actorId: 3, subjectId: 1, sponsorId: 4, detail: 'driver to sponsor' });

    expect(id).toBe(7);
    expect(inserts).toHaveLength(1);
    expect(row()).toEqual(['role.changed', 3, 1, 4, 'driver to sponsor']);
  });

  test('aa-57 an event with no actor, account or sponsor is still written', async () => {
    await recordEvent({ type: 'password.changed' });

    expect(row()).toEqual(['password.changed', null, null, null, null]);
  });

  test('aa-59 leaves the time to the database', async () => {
    await recordEvent({ type: 'password.changed', subjectId: 1 });

    expect(inserts[0].sql).not.toContain('occurred_at');
    expect(row().some(value => value instanceof Date)).toBe(false);
  });

  test('a type it does not write is kept as unknown, never dropped', async () => {
    await recordEvent({ type: 'something-new', detail: 'what happened' });
    // sign-ins live in login_attempts, so recordEvent does not write them either
    await recordEvent({ type: 'login.failed' });

    expect(inserts[0].params).toEqual(['unknown', null, null, null, 'type=something-new what happened']);
    expect(inserts[1].params).toEqual(['unknown', null, null, null, 'type=login.failed']);
  });
});

describe('the detail', () => {
  test('a rejection reason the size of its own column fits whole', async () => {
    const detail = `rejected: ${'r'.repeat(2000)}`;

    await recordEvent({ type: 'application.decided', detail });

    expect(row()[4]).toBe(detail);
  });

  test('anything longer is cut to the column and marked', async () => {
    await recordEvent({ type: 'application.decided', detail: 'r'.repeat(MAX_DETAIL + 100) });

    expect(row()[4]).toHaveLength(MAX_DETAIL);
    expect(row()[4].endsWith('...')).toBe(true);
  });
});

describe('aa-60 a write that fails', () => {
  test('is reported and returns null, so the action it describes still completes', async () => {
    db.query.mockRejectedValueOnce(new Error('table is gone'));

    await expect(recordEvent({ type: 'status.changed', subjectId: 1 })).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not record "status.changed"'));
  });

  test('inside a transaction too, leaving the caller free to commit', async () => {
    const conn = { execute: vi.fn().mockRejectedValue(new Error('deadlock')) };

    await expect(recordEvent({ type: 'application.decided' }, conn)).resolves.toBeNull();
  });
});

describe("inside a caller's transaction", () => {
  test('the event goes on that connection, not the pool', async () => {
    const conn = { execute: vi.fn(async () => [{ insertId: 31 }]) };

    const id = await recordEvent({ type: 'application.decided', actorId: 9, subjectId: 12, sponsorId: 7, detail: 'approved' }, conn);

    expect(id).toBe(31);
    expect(conn.execute.mock.calls[0][1]).toEqual(['application.decided', 9, 12, 7, 'approved']);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the migration', () => {
  const migration = readFileSync(new URL('../db/migrations/024_audit_events.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  // the table definition with comments stripped
  const definition = text => text
    .match(/CREATE TABLE IF NOT EXISTS audit_events \([\s\S]*?\n\);/)[0]
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .map(line => line.trim())
    .join(' ');

  test('and the schema file define the same table', () => {
    expect(definition(schema)).toBe(definition(migration));
  });

  test('carries the old password_changes rows across with their original times', () => {
    expect(migration).toMatch(/INSERT INTO audit_events[\s\S]*FROM password_changes/);
    expect(migration).toContain('pc.changed_at');
  });

  test('copies all of them or none, so a rerun cannot duplicate or drop one', () => {
    expect(migration).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM audit_events ae WHERE ae\.event_type = 'password\.changed'/);
  });

  test('leaves one audit table, not two', () => {
    expect(migration).toContain('DROP TABLE IF EXISTS admin_actions');
    expect(schema).not.toContain('admin_actions');
  });
});
