// aa-58 audit rows can't be changed or deleted: triggers on the four audited tables
import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'vitest';

const migration = readFileSync(new URL('../db/migrations/025_audit_immutable.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const TABLES = ['audit_events', 'login_attempts', 'point_transactions', 'login_unlocks'];
const triggers = text => text.slice(text.indexOf('DROP TRIGGER IF EXISTS'));

describe('the migration', () => {
  test.each(TABLES)('%s refuses an update and a delete', table => {
    for (const event of ['UPDATE', 'DELETE']) {
      expect(migration).toMatch(new RegExp(`BEFORE ${event} ON ${table} FOR EACH ROW\\s+SIGNAL SQLSTATE '45000'`));
    }
  });

  test('leaves inserts alone, so events can still be recorded', () => {
    expect(migration).not.toMatch(/BEFORE INSERT|AFTER INSERT/);
  });

  test('can be rerun, and a fresh database gets the same triggers from the schema file', () => {
    const created = migration.match(/CREATE TRIGGER (\w+)/g).map(line => line.split(' ')[2]);

    expect(created).toHaveLength(TABLES.length * 2);
    for (const name of created) expect(migration).toContain(`DROP TRIGGER IF EXISTS ${name};\nCREATE TRIGGER ${name} `);
    expect(triggers(schema)).toBe(triggers(migration));
  });
});
