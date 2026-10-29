import { createRequire } from 'node:module';
import { afterEach, test, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const db = require('../src/db');
const { removeDriverSponsor } = require('../src/memberships/store');
afterEach(() => vi.restoreAllMocks());

test('missing membership does not create a removal alert', async () => {
  const conn = { beginTransaction: vi.fn(), execute: vi.fn().mockResolvedValue([[]]), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  expect(await removeDriverSponsor(1, 7)).toBe(false);
  expect(conn.execute).toHaveBeenCalledTimes(1);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [1, 7]);
  expect(conn.release).toHaveBeenCalledOnce();
});

test('failed notification rolls back the membership removal', async () => {
  const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn(async sql => {
      if (sql.startsWith('INSERT')) throw new Error('write failed');
      return sql.startsWith('SELECT') ? [[{ name: 'Sponsor' }]] : [{ affectedRows: 1 }];
    }) };
  vi.spyOn(db.pool, 'getConnection').mockResolvedValue(conn);
  await expect(removeDriverSponsor(1, 7)).rejects.toThrow('write failed');
  expect(conn.rollback).toHaveBeenCalledOnce();
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledOnce();
});
