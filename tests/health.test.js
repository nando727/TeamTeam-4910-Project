// Story INF-10: a public health check for the web service and its database.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HEALTH_DB_TIMEOUT_MS;
});

describe('GET /health', () => {
  test('is public and answers 200 in JSON when the database responds', async () => {
    vi.spyOn(db, 'query').mockResolvedValue([{ 1: 1 }]);
    const res = await request(app).get('/health').expect(200).expect('Content-Type', /json/);
    expect(res.body).toEqual({ status: 'ok', app: 'ok', database: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
  });

  test('needs no session: it sets no cookie, ignores one, and asks the database nothing else', async () => {
    vi.spyOn(db, 'query').mockResolvedValue([{ 1: 1 }]);
    const res = await request(app).get('/health').set('Cookie', 'connect.sid=not-a-real-session').expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('answers 503 when the database is down, and never says why', async () => {
    const secret = 'connect ECONNREFUSED cpsc4910.example.rds.amazonaws.com:3306 for user Team13 using password hunter2';
    vi.spyOn(db, 'query').mockRejectedValue(new Error(secret));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/health').expect(503).expect('Content-Type', /json/);
    expect(res.body).toEqual({ status: 'unavailable', app: 'ok', database: 'unavailable' });
    for (const leak of ['ECONNREFUSED', 'rds', 'Team13', 'hunter2', 'stack']) expect(res.text).not.toContain(leak);
    // The reason goes to the server log, where the team can read it.
    expect(log.mock.calls.flat().join(' ')).toContain('ECONNREFUSED');
  });

  test('answers 503 instead of hanging when the database never responds', async () => {
    process.env.HEALTH_DB_TIMEOUT_MS = '20';
    vi.spyOn(db, 'query').mockReturnValue(new Promise(() => {}));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/health').expect(503);
    expect(res.body.database).toBe('unavailable');
  });
});

test('the deploy smoke test checks /health', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('"http://$CNAME/health"');
  expect(workflow).not.toContain('$CNAME/about');
});
