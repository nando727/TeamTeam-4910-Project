// Story AA-20 (22222): a password reset link has to reach the person's inbox,
// so sendMail() has a real transport behind it now.
//
// Nothing here sends anything: nodemailer's own sending is its business, and
// what matters is that we hand it the right message, choose the right
// transport, and fail in a way somebody can act on.
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');
const { sendMail, sentMessages, clearOutbox, resetTransport, missingSmtpSettings } = require('../src/mail/mailer');

const MAIL_VARS = ['MAIL_TRANSPORT', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASSWORD', 'MAIL_FROM'];
const originalEnv = { ...process.env };

const PASSWORD = 'abcd efgh ijkl mnop-should-never-be-logged';

let sent;        // what nodemailer was asked to send
let created;     // the options each transporter was built with

function configureSmtp(overrides = {}) {
  const settings = {
    MAIL_TRANSPORT: 'smtp',
    MAIL_HOST: 'smtp.gmail.com',
    MAIL_PORT: '587',
    MAIL_USER: 'gooddriver.team@gmail.com',
    MAIL_PASSWORD: PASSWORD,
    MAIL_FROM: 'gooddriver.team@gmail.com',
    ...overrides,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  sent = [];
  created = [];
  clearOutbox();
  resetTransport();

  vi.spyOn(nodemailer, 'createTransport').mockImplementation((options) => {
    created.push(options);
    return { sendMail: async (message) => { sent.push(message); return { messageId: 'test' }; } };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of MAIL_VARS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  resetTransport();
  clearOutbox();
});

const send = () => sendMail({ to: 'driver1@example.com', subject: 'Reset your password', text: 'Here is your link.' });

describe('choosing a transport', () => {
  test('the log is still the default, so a fresh checkout needs no mail settings', async () => {
    delete process.env.MAIL_TRANSPORT;

    const message = await send();

    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(message.delivered).toBe(true);
  });

  test('MAIL_TRANSPORT=smtp sends for real', async () => {
    configureSmtp();

    const message = await send();

    expect(message.delivered).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('an unknown transport name falls back to the log rather than failing', async () => {
    configureSmtp({ MAIL_TRANSPORT: 'carrier-pigeon' });

    const message = await send();

    expect(message.delivered).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('the message nodemailer is given', () => {
  test('carries the sender, recipient, subject and body', async () => {
    configureSmtp();

    await send();

    expect(sent[0]).toEqual({
      from: 'gooddriver.team@gmail.com',
      to: 'driver1@example.com',
      subject: 'Reset your password',
      text: 'Here is your link.',
    });
  });

  test('port 587 starts plain and upgrades; 465 is TLS from the first byte', async () => {
    configureSmtp({ MAIL_PORT: '587' });
    await send();
    expect(created[0]).toMatchObject({ port: 587, secure: false });

    resetTransport();
    configureSmtp({ MAIL_PORT: '465' });
    await send();
    expect(created[1]).toMatchObject({ port: 465, secure: true });
  });

  test('a missing or nonsense port falls back to 587', async () => {
    configureSmtp({ MAIL_PORT: 'the usual one' });

    await send();

    expect(created[0]).toMatchObject({ port: 587 });
  });

  test('the connection cannot hang a page open indefinitely', async () => {
    // A page the visitor is waiting on triggers this, so a server that accepts
    // the connection and then says nothing has to give up on its own.
    configureSmtp();

    await send();

    expect(created[0].connectionTimeout).toBeLessThanOrEqual(15000);
    expect(created[0].greetingTimeout).toBeLessThanOrEqual(15000);
    expect(created[0].socketTimeout).toBeLessThanOrEqual(20000);
  });

  test('the transporter is reused rather than rebuilt per message', async () => {
    configureSmtp();

    await send();
    await send();
    await send();

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(3);
  });
});

describe('when the settings are incomplete', () => {
  test('it says which ones, and writes the mail to the log instead', async () => {
    configureSmtp({ MAIL_HOST: null, MAIL_FROM: null });

    const message = await send();

    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    // Still "delivered", because the console transport did its job: the link
    // is readable in the log rather than lost.
    expect(message.delivered).toBe(true);
    const complaint = console.error.mock.calls.flat().join(' ');
    expect(complaint).toContain('MAIL_HOST');
    expect(complaint).toContain('MAIL_FROM');
  });

  test('the password is named, never printed', async () => {
    configureSmtp({ MAIL_PASSWORD: null });
    process.env.MAIL_PASSWORD = '';

    await send();

    const complaint = console.error.mock.calls.flat().join(' ');
    expect(complaint).toContain('MAIL_PASSWORD');
    expect(complaint).not.toContain(PASSWORD);
  });

  test('missingSmtpSettings reports exactly what is absent', () => {
    configureSmtp({ MAIL_USER: null, MAIL_PASSWORD: null });

    expect(missingSmtpSettings()).toEqual(['MAIL_USER', 'MAIL_PASSWORD']);
  });
});

describe('when the mail server refuses', () => {
  test('the failure is recorded and the caller is not broken', async () => {
    // Creating a user or asking for a reset link must not fail because mail
    // did: the account exists either way and the admin can resend.
    configureSmtp();
    nodemailer.createTransport.mockImplementation(() => ({
      sendMail: async () => { throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted'); },
    }));

    const message = await send();

    expect(message.delivered).toBe(false);
    expect(message.error).toMatch(/Username and Password not accepted/);
    expect(sentMessages().at(-1).delivered).toBe(false);
  });

  test('the recipient and the reason are logged so it can be chased', async () => {
    configureSmtp();
    nodemailer.createTransport.mockImplementation(() => ({
      sendMail: async () => { throw new Error('Connection timeout'); },
    }));

    await send();

    const logged = console.error.mock.calls.flat().join(' ');
    expect(logged).toContain('driver1@example.com');
    expect(logged).toContain('Connection timeout');
  });
});
