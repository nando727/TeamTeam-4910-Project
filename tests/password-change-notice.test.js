// Story AA-25 (22227): the owner of an account is told when its password
// changes, so a reset they did not perform is something they find out about
// rather than something they discover when their password stops working.
//
// The notice hangs off updateUserPassword, so these drive that function
// directly for the method matrix and drive the real profile page once, to show
// the whole path is wired together.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { updateUserPassword } = require('../src/users/store');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');

const PASSWORD = 'DriverPass1!';
const NEW_PASSWORD = 'FreshStart9#';
const USER = {
  id: 1, name: 'Dee Driver', email: 'dee@example.com', username: 'driver1',
  role: 'driver', status: 'active', sponsor_id: null,
};

let passwordHash;
let account;        // what findUserById answers with
let writeSucceeds;  // whether the password UPDATE matches a row

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

beforeEach(() => {
  account = { ...USER };
  writeSucceeds = true;
  clearOutbox();
  // The default transport writes the mail to the log; the outbox is what these
  // assert against, so the log itself is just noise here.
  vi.spyOn(console, 'log').mockImplementation(() => {});

  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    // Story 22214: every sign-in checks the lockout first. No failures here.
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};

    if (sql.includes('FROM users WHERE username')) {
      return params[0] === account.username ? [{ ...account, password_hash: passwordHash }] : [];
    }
    if (sql.startsWith('SELECT id, username, password_hash FROM users WHERE id')) {
      return params[0] === account.id ? [{ id: account.id, username: account.username, password_hash: passwordHash }] : [];
    }
    // findUserById: the row the notice is addressed from.
    if (sql.includes('FROM users WHERE id')) {
      return params[0] === account.id ? [{ ...account }] : [];
    }

    if (sql.startsWith('UPDATE users SET password_hash')) return { affectedRows: writeSucceeds ? 1 : 0 };
    // Story 22225: setting a password spends any unused setup link. Nothing
    // here was sent one.
    if (sql.startsWith('UPDATE setup_tokens SET used_at')) return { affectedRows: 0 };
    // Story AA-27: setting a password also voids any pending reset link.
    if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) return { affectedRows: 0 };
    // Audit log requirement: every password change is recorded.
    if (sql.startsWith('INSERT INTO password_changes')) return { insertId: 1 };
    // Story AA-79: the hash now in force is remembered so it cannot be
    // reused. No rows here, so there is never anything to prune.
    if (sql.startsWith('INSERT INTO password_history')) return { insertId: 1 };
    if (sql.startsWith('SELECT id FROM password_history')) return [];
    if (sql.startsWith('SELECT password_hash FROM password_history')) return [];
    // Backlog AA-14: a password change signs the account out elsewhere.
    if (sql.startsWith('UPDATE users SET sessions_valid_from')) return { affectedRows: 1 };
    if (sql.startsWith('SELECT UNIX_TIMESTAMP(sessions_valid_from)')) return [{ cutoff_ms: Date.now() }];
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];

    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  delete process.env.APP_BASE_URL;
});

function notices() {
  return sentMessages().filter(m => /your password was changed/i.test(m.subject));
}

async function changeVia(method) {
  await updateUserPassword(account.id, NEW_PASSWORD, { method });
  return notices();
}

describe('a password change the owner should hear about', () => {
  test('the profile page sends one notice to the address on file', async () => {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: USER.username, password: PASSWORD }).expect(302);
    const page = await agent.get('/profile/password').expect(200);
    const token = page.text.match(/name="token" value="([^"]+)"/)[1];

    await agent.post('/profile/password').type('form').send({
      token, currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    }).expect(200);

    const sent = notices();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(USER.email);
    expect(sent[0].subject).toMatch(/your password was changed/i);
  });

  test.each([
    ['profile', /from your profile page/i],
    ['admin-reset', /by an administrator/i],
    ['reset-link', /using a password reset link/i],
  ])('a %s change says so, so the owner can tell whether it was theirs', async (method, wording) => {
    const sent = await changeVia(method);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(wording);
  });

  test('a method nobody recognises is still announced', async () => {
    const sent = await changeVia('something-made-up');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/not recorded/i);
  });

  test('the notice names the account and says when', async () => {
    const sent = await changeVia('reset-link');
    expect(sent[0].text).toContain(USER.username);
    expect(sent[0].text).toMatch(/GMT/);
  });

  test('it says the other devices were signed out', async () => {
    const sent = await changeVia('reset-link');
    expect(sent[0].text).toMatch(/signed out/i);
  });
});

describe('what to do if it was not you', () => {
  test('a configured site offers the reset page as a link', async () => {
    process.env.APP_BASE_URL = 'https://points.example.com/';
    const sent = await changeVia('admin-reset');
    expect(sent[0].text).toContain('https://points.example.com/forgot-password');
    expect(sent[0].text).toMatch(/tell an administrator/i);
  });

  test('with no site configured it names the link on the sign-in page instead', async () => {
    const sent = await changeVia('admin-reset');
    expect(sent[0].text).not.toMatch(/https?:\/\//);
    expect(sent[0].text).toMatch(/forgot password/i);
  });
});

describe('what the notice never contains', () => {
  test('neither the new password nor its hash', async () => {
    const sent = await changeVia('profile');
    expect(sent[0].text).not.toContain(NEW_PASSWORD);
    expect(sent[0].text).not.toContain('$2');   // the start of a bcrypt hash
    expect(sent[0].text).not.toContain(PASSWORD);
  });
});

describe('changes that send nothing', () => {
  test('a first password set through a setup link', async () => {
    // Whoever used the link is the person choosing the password, and they are
    // still in front of the form.
    expect(await changeVia('setup-link')).toHaveLength(0);
  });

  test('an account with no email on file', async () => {
    account.email = null;
    const sent = await changeVia('reset-link');
    expect(sent).toHaveLength(0);
  });

  test('an account with no email still has its password changed', async () => {
    account.email = null;
    expect(await updateUserPassword(account.id, NEW_PASSWORD, { method: 'reset-link' })).toBe(true);
  });

  test('a write that matched no row', async () => {
    writeSucceeds = false;
    expect(await updateUserPassword(account.id, NEW_PASSWORD, { method: 'reset-link' })).toBe(false);
    expect(notices()).toHaveLength(0);
  });
});

describe('when the mail cannot go out', () => {
  test('the password change still succeeds', async () => {
    // The console transport is what writes the mail, so making it throw is a
    // mail server that cannot be reached.
    console.log.mockImplementation(() => { throw new Error('mail server unreachable'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await updateUserPassword(account.id, NEW_PASSWORD, { method: 'reset-link' })).toBe(true);
  });

  test('the failure is reported in the log, not to the user', async () => {
    console.log.mockImplementation(() => { throw new Error('mail server unreachable'); });
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    await updateUserPassword(account.id, NEW_PASSWORD, { method: 'reset-link' });
    expect(errors.join('\n')).toMatch(/could not send mail/i);
  });
});
