// `npm run db:migrate` runs every file every time, so the membership backfill in
// migration 008 must not run again: it would bring back removed sponsorships.
import { createRequire } from 'node:module';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { applyMigrations } = require('../scripts/db-migrate');

function fakeConnection({ membershipTable, conflicts = [] }) {
  return {
    query: vi.fn(async sql => {
      if (sql.includes('information_schema.TABLES')) return [[{ count: membershipTable ? 1 : 0 }]];
      if (sql.includes('FROM sponsor_applications WHERE status')) return [conflicts];
      return [[]];
    }),
  };
}
const sqlRun = conn => conn.query.mock.calls.map(([sql]) => sql);
const backfilled = conn => sqlRun(conn).some(sql => sql.includes('INSERT INTO driver_sponsors'));
const checkedConflicts = conn => sqlRun(conn).some(sql => sql.includes('FROM sponsor_applications WHERE status'));

let log;
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('rerunning on a database that has memberships', () => {
  test('skips 008, so removed sponsorships stay removed and two approved sponsors do not stop the run', async () => {
    const conn = fakeConnection({ membershipTable: true, conflicts: [{ driver_id: 1 }] });
    await applyMigrations(conn);
    expect(backfilled(conn)).toBe(false);
    expect(checkedConflicts(conn)).toBe(false);
    expect(log.mock.calls.flat()).toContain('Skipped migration: 008_driver_sponsors.sql (memberships already exist)');
  });

  test('still applies every other migration, in order, through the newest', async () => {
    const conn = fakeConnection({ membershipTable: true });
    await applyMigrations(conn);
    const applied = log.mock.calls.flat().filter(line => line.startsWith('Applied migration: '));
    expect(applied[0]).toBe('Applied migration: 001_sponsors_about_user_contact.sql');
    expect(applied).toContain('Applied migration: 014_driver_sponsors_multiple.sql');
    expect(applied).toContain('Applied migration: 018_sponsor_monthly_fees.sql');
    expect(applied.pop()).toBe('Applied migration: 021_password_history.sql');
    expect(sqlRun(conn).some(sql => sql.includes('CREATE PROCEDURE sponsor_monthly_fees'))).toBe(true);
  });
});

describe('a database that has never had memberships', () => {
  test('runs the conflict check and 008, and 014 widens the key afterward', async () => {
    const conn = fakeConnection({ membershipTable: false });
    await applyMigrations(conn);
    const sql = sqlRun(conn);
    const backfill = sql.findIndex(text => text.includes('INSERT INTO driver_sponsors'));
    const check = sql.findIndex(text => text.includes('FROM sponsor_applications WHERE status'));
    const widen = sql.findIndex(text => text.includes('ADD PRIMARY KEY (driver_id, sponsor_id)'));
    expect(check).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(check);
    expect(widen).toBeGreaterThan(backfill);
  });

  test('stops before 008 if a driver has two approved sponsors, because its one-column key would drop one', async () => {
    const conn = fakeConnection({ membershipTable: false, conflicts: [{ driver_id: 1 }] });
    await expect(applyMigrations(conn)).rejects.toThrow('multiple approved sponsors');
    expect(backfilled(conn)).toBe(false);
  });
});
