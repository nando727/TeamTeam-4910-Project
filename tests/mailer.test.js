// The shared mail seam (story 22255, reused by password reset and alerts).
import { createRequire } from 'node:module';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { sendMail, sentMessages, clearOutbox } = require('../src/mail/mailer');

const originalTransport = process.env.MAIL_TRANSPORT;

beforeEach(() => {
  clearOutbox();
  process.env.MAIL_TRANSPORT = 'silent';
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOutbox();
  if (originalTransport === undefined) delete process.env.MAIL_TRANSPORT;
  else process.env.MAIL_TRANSPORT = originalTransport;
});

describe('sendMail', () => {
  test('records what was sent, so callers and tests can check it', async () => {
    await sendMail({ to: 'newuser@example.com', subject: 'Set up your account', text: 'link here' });

    const [message] = sentMessages();
    expect(message.to).toBe('newuser@example.com');
    expect(message.subject).toBe('Set up your account');
    expect(message.text).toBe('link here');
    expect(message.delivered).toBe(true);
  });

  test('the console transport writes the message to the server log', async () => {
    process.env.MAIL_TRANSPORT = 'console';
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMail({ to: 'newuser@example.com', subject: 'Set up your account', text: 'http://localhost:3000/setup/abc' });

    const output = logged.mock.calls.flat().join('\n');
    expect(output).toContain('newuser@example.com');
    expect(output).toContain('http://localhost:3000/setup/abc');
  });

  test('an unknown transport name falls back to the console one', async () => {
    process.env.MAIL_TRANSPORT = 'carrier-pigeon';
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMail({ to: 'someone@example.com', subject: 'Hello' });

    expect(logged).toHaveBeenCalled();
    expect(sentMessages()[0].delivered).toBe(true);
  });

  test('a failing transport is reported but does not throw', async () => {
    process.env.MAIL_TRANSPORT = 'console';
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('transport is down'); });
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The caller's own work (creating a user) must not fail because mail failed.
    const message = await sendMail({ to: 'someone@example.com', subject: 'Hello' });

    expect(message.delivered).toBe(false);
    expect(message.error).toBe('transport is down');
    expect(errored).toHaveBeenCalled();
  });

  test('refuses a message with no recipient or no subject', async () => {
    await expect(sendMail({ subject: 'No recipient' })).rejects.toThrow('sendMail needs');
    await expect(sendMail({ to: 'someone@example.com' })).rejects.toThrow('sendMail needs');
  });

  test('keeps messages in order', async () => {
    await sendMail({ to: 'first@example.com', subject: 'One' });
    await sendMail({ to: 'second@example.com', subject: 'Two' });

    expect(sentMessages().map((m) => m.to)).toEqual(['first@example.com', 'second@example.com']);
  });
});
