// Story AA-25 (22227): changing the email address on an account tells the
// address being replaced.
//
// The password notice from the first commit is only worth something if the
// address it goes to cannot be swapped quietly beforehand: otherwise someone
// with a session points the account at their own inbox, uses "forgot
// password", and receives both the link and the warning about it.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { updateUserContact } = require('../src/users/store');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');

const PASSWORD = 'DriverPass1!';
const OLD_EMAIL = 'dee@example.com';
const NEW_EMAIL = 'dee.driver@elsewhere.example';
const USER = {
  id: 1, name: 'Dee Driver', email: OLD_EMAIL, username: 'driver1',
  role: 'driver', status: 'active', sponsor_id: null,
};

let passwordHash;
let account;        // the stored row, updated in place by the mock
let emailTaken;     // whether the uniqueness check finds a clash

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  account = { ...USER };
  emailTaken = false;
  clearOutbox();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};

    if (sql.includes('FROM users WHERE username')) {
      return params[0] === account.username ? [{ ...account, password_hash: passwordHash }] : [];
    }
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return params[0] === account.id ? [{ id: account.id, username: account.username, password_hash: passwordHash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      return params[0] === account.id ? [{ ...account }] : [];
    }

    // The uniqueness check updateUserContact runs when the address changes.
    if (sql.startsWith('SELECT id FROM users WHERE email')) return emailTaken ? [{ id: 99 }] : [];
    if (sql.startsWith('UPDATE users SET name')) {
      const [name, email] = params;
      account = { ...account, name, email };
      return { affectedRows: 1 };
    }

    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
});

function notices() {
  return sentMessages().filter(m => /email address on your account was changed/i.test(m.subject));
}

describe('changing the address on an account', () => {
  test('the profile page tells the address being replaced', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: USER.username, password: PASSWORD }).expect(302);
    const page = await agent.get('/profile/edit').expect(200);
    const token = page.text.match(/name="token" value="([^"]+)"/)[1];

    await agent.post('/profile').type('form')
      .send({ token, name: USER.name, email: NEW_EMAIL }).expect(200);

    const sent = notices();
    expect(sent).toHaveLength(1);
    // The old address, not the new one: the new inbox may be the attacker's.
    expect(sent[0].to).toBe(OLD_EMAIL);
  });

  test('the notice shows both addresses, so the owner can see where mail went', async () => {
    await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    const [sent] = notices();
    expect(sent.text).toContain(OLD_EMAIL);
    expect(sent.text).toContain(NEW_EMAIL);
  });

  test('it says to tell an administrator, and why it matters', async () => {
    await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    const [sent] = notices();
    expect(sent.text).toMatch(/tell an administrator/i);
    expect(sent.text).toMatch(/reset the password/i);
  });

  test('it names the account and says when', async () => {
    await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    const [sent] = notices();
    expect(sent.text).toContain(USER.username);
    expect(sent.text).toMatch(/GMT/);
  });

  test('one notice per change, not one per lookup', async () => {
    await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    expect(notices()).toHaveLength(1);
  });
});

describe('changes that send nothing', () => {
  test('a new name with the same address', async () => {
    await updateUserContact(USER.id, { name: 'Dee D. Driver', email: OLD_EMAIL });
    expect(notices()).toHaveLength(0);
    expect(account.name).toBe('Dee D. Driver');
  });

  test('the same address submitted again', async () => {
    await updateUserContact(USER.id, { name: USER.name, email: OLD_EMAIL });
    expect(notices()).toHaveLength(0);
  });

  test('an account that had no address to begin with', async () => {
    // Filling one in for the first time takes nothing away from anybody.
    account.email = null;
    await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    expect(notices()).toHaveLength(0);
  });

  test('an address already taken by another account', async () => {
    emailTaken = true;
    await expect(updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL })).rejects.toThrow(/already exists/i);
    expect(notices()).toHaveLength(0);
    expect(account.email).toBe(OLD_EMAIL);
  });

  test('an account that cannot be found', async () => {
    expect(await updateUserContact(404, { name: USER.name, email: NEW_EMAIL })).toBeNull();
    expect(notices()).toHaveLength(0);
  });
});

describe('when the mail cannot go out', () => {
  test('the address is still changed', async () => {
    console.log.mockImplementation(() => { throw new Error('mail server unreachable'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const updated = await updateUserContact(USER.id, { name: USER.name, email: NEW_EMAIL });
    expect(updated.email).toBe(NEW_EMAIL);
  });
});
