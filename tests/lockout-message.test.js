// Story 22215: a locked-out user is told how to get back in, not just that
// they are blocked. The wording lives in src/auth/lockout.js; how the sign-in
// page renders it is covered in tests/lockout-login.test.js.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { lockoutMessage, lockoutGuidance, RESET_PATH } = require('../src/auth/lockout');

const locked = (minutesRemaining = 15) => ({ locked: true, minutesRemaining, failures: 5, maxFailures: 5 });

describe('the one-line message', () => {
  test('says how long is left', () => {
    expect(lockoutMessage(locked(15))).toContain('15 minutes');
  });

  test('uses the singular for one minute', () => {
    const text = lockoutMessage(locked(1));
    expect(text).toContain('1 minute');
    expect(text).not.toContain('1 minutes');
  });

  test('offers resetting the password as a way back in', () => {
    expect(lockoutMessage(locked())).toMatch(/reset your password/i);
  });

  test('warns that trying again restarts the wait', () => {
    // checkLockout runs the lock from the most recent failure, so a visitor who
    // keeps retrying never gets in and would otherwise never know why.
    expect(lockoutMessage(locked())).toMatch(/restarts the wait/i);
  });

  test('still opens with the wording the sign-in routes have always used', () => {
    expect(lockoutMessage(locked())).toMatch(/^Too many failed sign-in attempts\./);
  });
});

describe('the guidance a page can render', () => {
  test('carries the three ways back in', () => {
    const guidance = lockoutGuidance(locked(15));

    expect(guidance.waitText).toContain('15 minutes');
    expect(guidance.resetPath).toBe(RESET_PATH);
    expect(guidance.resetText).toMatch(/reset your password/i);
    expect(guidance.adminText).toMatch(/administrator/i);
  });

  test('points the reset at the page that actually sends a link', () => {
    expect(lockoutGuidance(locked()).resetPath).toBe('/forgot-password');
  });

  test('repeats the retry warning', () => {
    expect(lockoutGuidance(locked()).retryWarning).toMatch(/restarts the wait/i);
  });

  test('keeps the minutes for the page to use', () => {
    expect(lockoutGuidance(locked(3)).minutesRemaining).toBe(3);
    expect(lockoutGuidance(locked(1)).waitText).toContain('1 minute');
  });

  test('is plain text, so a view escapes it without losing meaning', () => {
    const guidance = lockoutGuidance(locked());
    const sentences = [guidance.summary, guidance.waitText, guidance.retryWarning, guidance.resetText, guidance.adminText];

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/[<>]/);
    }
  });
});

describe('what it must never give away', () => {
  // The lock is checked before any credential check, and login_attempts records
  // usernames that never existed, so a locked response must read the same
  // either way or it becomes a way to discover accounts.
  const wordings = [lockoutMessage(locked()), ...Object.values(lockoutGuidance(locked())).filter(v => typeof v === 'string')];

  test('never claims the account exists', () => {
    for (const text of wordings) {
      expect(text).not.toMatch(/your account/i);
      expect(text).not.toMatch(/this account exists|no such account|account not found/i);
    }
  });

  test('never names the user or the attempted username', () => {
    for (const text of wordings) {
      expect(text).not.toMatch(/username is|account for/i);
    }
  });
});
