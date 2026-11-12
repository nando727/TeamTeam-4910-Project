// Sprint 9 follow-up: an item added to the cart could vanish. The session is
// saved whole at the end of every request, so a slow request that began
// before the add finished after it and wrote back the cart it had loaded --
// most often the alerts fetch every driver page fires on load. Two fixes,
// each tested here: background requests no longer write the session at all,
// and every cart change re-reads the stored session immediately before
// changing and saving it.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { app } = require('../src/app');
const { withFreshSession } = require('../src/driver/cart-session');
const { isBackgroundRequest, BACKGROUND_PATHS } = require('../src/auth/session-timeout');

describe('withFreshSession', () => {
  function fakeReq({ failReload = false, failSave = false, stored = {} } = {}) {
    const order = [];
    const req = {
      session: {
        user: { id: 21 },
        lastActivity: 1,
        reload(cb) {
          order.push('reload');
          if (failReload) return cb(new Error('no such session'));
          // What reload really does: replace the contents with the store's copy.
          Object.assign(req.session, stored);
          cb();
        },
        save(cb) {
          order.push('save');
          cb(failSave ? new Error('store is down') : null);
        },
      },
    };
    return { req, order };
  }

  test('re-reads the stored session, mutates it, and saves, in that order', async () => {
    const { req, order } = fakeReq({ stored: { cart: { sponsorId: 7, items: [{ id: 31, quantity: 2 }] } } });
    const result = await withFreshSession(req, session => {
      order.push('mutate');
      // The mutation sees what the store holds, not what this request loaded.
      expect(session.cart.items[0].quantity).toBe(2);
      session.cart.items[0].quantity = 3;
      return 'done';
    });
    expect(order).toEqual(['reload', 'mutate', 'save']);
    expect(result).toBe('done');
    expect(req.session.cart.items[0].quantity).toBe(3);
  });

  test('moves the idle clock again, because reload pulled back the stored one', async () => {
    const { req } = fakeReq({ stored: { lastActivity: 1 } });
    const before = Date.now();
    await withFreshSession(req, () => {});
    expect(req.session.lastActivity).toBeGreaterThanOrEqual(before);
  });

  test('a failed reload or save is the caller\'s error, not a silent half-write', async () => {
    const broken = fakeReq({ failReload: true });
    await expect(withFreshSession(broken.req, () => {})).rejects.toThrow('no such session');
    expect(broken.order).toEqual(['reload']);
    const stuck = fakeReq({ failSave: true });
    await expect(withFreshSession(stuck.req, () => {})).rejects.toThrow('store is down');
  });
});

describe('background requests and the session', () => {
  let hash;
  const originalIdle = process.env.SESSION_IDLE_MINUTES;
  // 0.002 minutes = 120ms, the same demo-sized window the timeout tests use.
  const SHORT_MS = 120;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  beforeAll(async () => { hash = await hashPassword('Password1!'); });
  beforeEach(() => {
    vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
      if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
      if (sql.startsWith('INSERT INTO login_attempts')) return {};
      if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
      if (sql.includes('FROM users WHERE username')) {
        return params[0] === 'driver21' ? [{ id: 21, username: 'driver21', role: 'driver', status: 'active', sponsor_id: null, password_hash: hash }] : [];
      }
      // The alerts the background fetch reads.
      if (sql.includes('FROM driver_alert_preferences')) return [];
      if (sql.includes('FROM point_alerts')) return [];
      if (sql.includes('FROM sponsor_removal_alerts')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIdle === undefined) delete process.env.SESSION_IDLE_MINUTES;
    else process.env.SESSION_IDLE_MINUTES = originalIdle;
  });

  async function driver() {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver21', password: 'Password1!' }).expect(302);
    return agent;
  }

  test('the alerts fetch is recognised; a page, a POST to the same path, or the keep-alive is not', () => {
    expect(BACKGROUND_PATHS).toContain('/points/alerts');
    expect(isBackgroundRequest({ method: 'GET', path: '/points/alerts' })).toBe(true);
    expect(isBackgroundRequest({ method: 'POST', path: '/points/alerts' })).toBe(false);
    expect(isBackgroundRequest({ method: 'GET', path: '/driver/catalog' })).toBe(false);
    expect(isBackgroundRequest({ method: 'GET', path: '/session/keep-alive' })).toBe(false);
  });

  test('the alerts fetch does not count as activity, so it cannot keep a session alive either', async () => {
    process.env.SESSION_IDLE_MINUTES = String(SHORT_MS / 60000);
    const agent = await driver();
    await wait(SHORT_MS * 0.6);
    // Inside the window, so it answers -- but it must not slide the window.
    await agent.get('/points/alerts').expect(200);
    await wait(SHORT_MS * 0.7);
    // Past the window since sign-in. If the alerts fetch had counted as
    // activity, this would still be signed in.
    await agent.get('/driver/cart').expect(302).expect('Location', '/login?expired=1');
  });

  test('a real page inside the same timings does keep the session alive', async () => {
    process.env.SESSION_IDLE_MINUTES = String(SHORT_MS / 60000);
    const agent = await driver();
    await wait(SHORT_MS * 0.6);
    await agent.get('/points/settings').expect(200);
    await wait(SHORT_MS * 0.7);
    await agent.get('/points/settings').expect(200);
  });
});
