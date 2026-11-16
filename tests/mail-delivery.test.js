// Sprint 8: email on the live site. A sent message leaves a line in the log, an
// account with no address is never handed to Gmail, and whoever creates an
// account is told whether its setup email really went out.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');
const db = require('../src/db');
const { hashPassword } = require('../src/auth/password');
const { sendMail, clearOutbox, resetTransport, maskAddress } = require('../src/mail/mailer');
const { setupMailNotice } = require('../src/mail/outcome');
const { app } = require('../src/app');

const MAIL_VARS = ['MAIL_TRANSPORT', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASSWORD', 'MAIL_FROM'];
const originalEnv = { ...process.env };
let sent;
let failNext;
let logged;
let hash;

function useGmail() {
  Object.assign(process.env, {
    MAIL_TRANSPORT: 'smtp', MAIL_HOST: 'smtp.gmail.com', MAIL_PORT: '587',
    MAIL_USER: 'gooddriver.team@gmail.com', MAIL_PASSWORD: 'abcd efgh ijkl mnop', MAIL_FROM: 'gooddriver.team@gmail.com',
  });
}

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  sent = [];
  failNext = null;
  clearOutbox();
  resetTransport();
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({
    sendMail: async message => {
      if (failNext) { const error = failNext; failNext = null; throw error; }
      sent.push(message);
      return { messageId: '<abc123@gmail.com>' };
    },
  }));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of MAIL_VARS) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  resetTransport();
  clearOutbox();
});

describe('the mailer', () => {
  test('a successful Gmail send logs one line, with the address masked and the message id', async () => {
    useGmail();
    const message = await sendMail({ to: 'rhpatel@clemson.edu', subject: 'Set up your account', text: 'link' });
    expect(message).toMatchObject({ delivered: true, transport: 'smtp' });
    expect(sent).toHaveLength(1);
    expect(logged).toContain('[mail] Sent "Set up your account" to r***@clemson.edu <abc123@gmail.com>');
    expect(logged.join(' ')).not.toContain('rhpatel@');
  });

  test('an account with no address is never handed to Gmail, and the log says so', async () => {
    useGmail();
    for (const to of ['(no email on file)', 'not an address']) {
      const message = await sendMail({ to, subject: 'Reset your password', text: 'link' });
      expect(message).toMatchObject({ delivered: false, skipped: true, transport: 'smtp', error: 'No email address on file.' });
    }
    expect(sent).toEqual([]);
    expect(logged).toContain('[mail] "Reset your password" was not sent: no email address on file.');
  });

  test('without an email service the placeholder still prints, so development keeps showing the link', async () => {
    delete process.env.MAIL_TRANSPORT;
    const message = await sendMail({ to: '(no email on file)', subject: 'Reset your password', text: 'the link' });
    expect(message).toMatchObject({ delivered: true, transport: 'console' });
    expect(logged.join('\n')).toContain('the link');
  });

  test('a Gmail refusal is logged with the full address so it can be chased', async () => {
    useGmail();
    failNext = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
    const message = await sendMail({ to: 'driver1@gmail.com', subject: 'Set up your account', text: 'x' });
    expect(message).toMatchObject({ delivered: false, transport: 'smtp' });
    expect(logged.join(' ')).toContain('Could not send mail to driver1@gmail.com: Invalid login: 535-5.7.8');
  });

  test('masking keeps the first letter and the domain', () => {
    expect(maskAddress('rhpatel@clemson.edu')).toBe('r***@clemson.edu');
    expect(maskAddress('nonsense')).toBe('***');
  });

  test('the setup email notice says what actually happened', () => {
    expect(setupMailNotice({ transport: 'smtp', delivered: true, to: 'a@b.co' })).toEqual({ kind: 'sent', text: 'The setup link was emailed to a@b.co.' });
    expect(setupMailNotice({ transport: 'smtp', delivered: false, to: 'a@b.co' }).kind).toBe('failed');
    expect(setupMailNotice({ transport: 'console', delivered: true, to: 'a@b.co' }).kind).toBe('logged');
    expect(setupMailNotice(null)).toBeNull();
  });
});

describe('pages', () => {
  let resetUser;
  beforeEach(() => {
    resetUser = { id: 3, username: 'admin1', email: null, status: 'active' };
    vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
      if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
      if (sql.startsWith('INSERT INTO login_attempts')) return {};
      if (sql.startsWith('SELECT id, username, password_hash')) {
        const role = { admin1: 'admin', sponsor1: 'sponsor' }[params[0]];
        return role ? [{ id: role === 'admin' ? 3 : 2, username: params[0], password_hash: hash, role, status: 'active', sponsor_id: role === 'sponsor' ? 1 : null }] : [];
      }
      if (sql.includes('FROM users WHERE id')) return [{ id: params[0], username: params[0] === 3 ? 'admin1' : 'sponsor1', role: params[0] === 3 ? 'admin' : 'sponsor', status: 'active', name: null, email: null, sponsor_id: params[0] === 3 ? null : 1 }];
      if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
      if (sql.startsWith('SELECT id FROM users WHERE email')) return [];
      if (sql.startsWith('INSERT INTO password_history')) return { insertId: 1 };
      if (sql.startsWith('SELECT id FROM password_history')) return [];
      if (sql.startsWith('INSERT INTO users')) return { insertId: 42 };
      if (sql.startsWith('INSERT INTO setup_tokens')) return { insertId: 1 };
      // Forgot password.
      if (sql.startsWith('SELECT id, username, email, status FROM users WHERE username')) return params[0] === 'admin1' ? [resetUser] : [];
      if (sql.includes('COUNT(*) AS requests FROM password_resets')) return [{ requests: 0 }];
      if (sql.startsWith('UPDATE password_resets SET used_at = NOW() WHERE user_id')) return { affectedRows: 0 };
      if (sql.startsWith('INSERT INTO password_resets')) return { insertId: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  async function login(username) {
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
    return agent;
  }
  const tokenOf = page => page.text.match(/name="token" value="([^"]+)"/)[1];

  test.each([
    ['smtp', null, 'mail-outcome--sent', 'The setup link was emailed to new.person@clemson.edu.'],
    ['smtp', new Error('Connection timeout'), 'mail-outcome--failed', 'The setup email to new.person@clemson.edu could not be sent. Copy the link below and pass it on yourself.'],
    ['console', null, 'mail-outcome--logged', 'No email service is connected here, so the setup email was written to the server log.'],
  ])('admin create-user says whether the setup email went out (%s)', async (transport, failure, cls, text) => {
    if (transport === 'smtp') useGmail(); else delete process.env.MAIL_TRANSPORT;
    failNext = failure;
    const agent = await login('admin1');
    const token = tokenOf(await agent.get('/admin/create-user'));
    const page = await agent.post('/admin/create-user').type('form')
      .send({ token, name: 'New Person', email: 'new.person@clemson.edu', username: 'newperson', role: 'driver', password: '' }).expect(200);
    expect(page.text).toContain(`<p class="mail-outcome ${cls}">${text}`);
    expect(page.text).toContain('class="setup-link"');
    expect(page.text).toContain('data-select-on-focus');
    expect(page.text).not.toContain('onfocus=');
  });

  test('sponsor create-user says the same', async () => {
    useGmail();
    const agent = await login('sponsor1');
    const token = tokenOf(await agent.get('/sponsor-users/create'));
    const page = await agent.post('/sponsor-users/create').type('form')
      .send({ token, name: 'Second Sponsor', email: 'second@clemson.edu', username: 'second', password: '' }).expect(200);
    expect(page.text).toContain('<p class="mail-outcome mail-outcome--sent">The setup link was emailed to second@clemson.edu.');
  });

  test('a reset for an account with no email sends nothing, logs why, and the page still answers the same', async () => {
    useGmail();
    const res = await request(app).post('/forgot-password').type('form').send({ username: 'admin1' }).expect(200);
    expect(sent).toEqual([]);
    expect(logged).toContain('[mail] "Good Driver Incentive Program: reset your password" was not sent: no email address on file.');
    const unknown = await request(app).post('/forgot-password').type('form').send({ username: 'nobody-here' }).expect(200);
    const hint = text => text.match(/<p class="hint">[^<]+/)[0];
    expect(hint(res.text)).toBe(hint(unknown.text));
  });

  test('a reset for an account with an email goes to Gmail and is logged', async () => {
    useGmail();
    resetUser.email = 'rhpatel@clemson.edu';
    await request(app).post('/forgot-password').type('form').send({ username: 'admin1' }).expect(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('rhpatel@clemson.edu');
    expect(logged.some(line => line.startsWith('[mail] Sent "Good Driver Incentive Program: reset your password" to r***@clemson.edu'))).toBe(true);
  });
});
