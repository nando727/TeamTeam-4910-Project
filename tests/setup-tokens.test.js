// Story 22255: setup token helpers — issuing, validating, and consuming
// single-use links. No routes involved yet.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const {
  issueSetupToken, findValidToken, consumeToken, hashToken, linkLifetimeHours,
} = require('../src/auth/setup-tokens');

const originalHours = process.env.SETUP_LINK_HOURS;

// Stand-in for the setup_tokens table.
let rows;
let nextId;

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

beforeEach(() => {
  rows = [];
  nextId = 1;

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO setup_tokens')) {
      const [userId, tokenHash, expiresAt] = params;
      rows.push({ id: nextId, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
      return { insertId: nextId++ };
    }
    if (sql.startsWith('SELECT id, user_id, token_hash')) {
      const [tokenHash] = params;
      return rows.filter((row) => row.token_hash === tokenHash);
    }
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) {
      const [id] = params;
      const row = rows.find((r) => r.id === id && r.used_at === null);
      if (!row) return { affectedRows: 0 };
      row.used_at = new Date();
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHours === undefined) delete process.env.SETUP_LINK_HOURS;
  else process.env.SETUP_LINK_HOURS = originalHours;
});

describe('issuing a setup token', () => {
  test('returns a long random token and stores a row for the user', async () => {
    const token = await issueSetupToken(7);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(7);
  });

  test('stores only the hash, never the token from the link', async () => {
    const token = await issueSetupToken(7);

    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toBe(hashToken(token));
  });

  test('two tokens are never the same', async () => {
    const first = await issueSetupToken(7);
    const second = await issueSetupToken(8);
    expect(first).not.toBe(second);
  });

  test('the link lifetime honours SETUP_LINK_HOURS', async () => {
    process.env.SETUP_LINK_HOURS = '1';
    expect(linkLifetimeHours()).toBe(1);

    await issueSetupToken(7);
    const expiresIn = new Date(rows[0].expires_at).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('defaults to 48 hours when unset', async () => {
    delete process.env.SETUP_LINK_HOURS;
    expect(linkLifetimeHours()).toBe(48);
  });
});

describe('validating a setup token', () => {
  test('a fresh token is accepted and names its user', async () => {
    const token = await issueSetupToken(7);

    const found = await findValidToken(token);
    expect(found).not.toBeNull();
    expect(found.user_id).toBe(7);
  });

  test('an unknown token is refused', async () => {
    await issueSetupToken(7);
    expect(await findValidToken('not-a-real-token')).toBeNull();
  });

  test('an empty or missing token is refused without a lookup', async () => {
    expect(await findValidToken('')).toBeNull();
    expect(await findValidToken(undefined)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('an expired token is refused', async () => {
    const token = await issueSetupToken(7);
    rows[0].expires_at = hoursFromNow(-1);

    expect(await findValidToken(token)).toBeNull();
  });

  test('an already used token is refused', async () => {
    const token = await issueSetupToken(7);
    await consumeToken(rows[0].id);

    expect(await findValidToken(token)).toBeNull();
  });
});

describe('consuming a setup token', () => {
  test('marks the token used the first time', async () => {
    await issueSetupToken(7);

    expect(await consumeToken(1)).toBe(true);
    expect(rows[0].used_at).not.toBeNull();
  });

  test('refuses a second use, so a link works exactly once', async () => {
    await issueSetupToken(7);
    await consumeToken(1);

    expect(await consumeToken(1)).toBe(false);
  });
});
