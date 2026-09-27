// Password complexity rules: 8+ characters, one uppercase, one lowercase, one
// number, one special character. Each failed rule produces its own message.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { passwordProblems, failedPasswordRules, PUBLIC_RULES, MAX_PASSWORD_LENGTH } = require('../src/auth/password-policy');

describe('passwordProblems', () => {
  test('accepts a password that meets every rule', () => {
    expect(passwordProblems('GoodPass1!')).toEqual([]);
    expect(passwordProblems('a Very long Passphrase 9?')).toEqual([]);
  });

  test.each([
    ['Sh0rt!!', 'length', 'at least 8 characters'],
    ['lowercase1!', 'uppercase', 'uppercase letter'],
    ['UPPERCASE1!', 'lowercase', 'lowercase letter'],
    ['NoNumbers!!', 'number', 'include a number'],
    ['NoSpecial123', 'special', 'special character'],
  ])('%s fails only the %s rule and names it', (password, ruleId, wording) => {
    expect(failedPasswordRules(password).map(r => r.id)).toEqual([ruleId]);
    const problems = passwordProblems(password);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(wording);
  });

  test('a space is not a special character', () => {
    expect(failedPasswordRules('Spaces Only 123').map(r => r.id)).toEqual(['special']);
  });

  test('reports every failed rule at once', () => {
    expect(failedPasswordRules('abc').map(r => r.id)).toEqual(['length', 'uppercase', 'number', 'special']);
    expect(passwordProblems('')).toHaveLength(5);
  });

  test('rejects non-strings and over-long passwords', () => {
    expect(passwordProblems(undefined)).toHaveLength(5);
    expect(passwordProblems(12345678)).toHaveLength(5);
    const tooLong = 'Aa1!' + 'x'.repeat(MAX_PASSWORD_LENGTH);
    expect(passwordProblems(tooLong)).toEqual([`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`]);
  });

  test('the rules embedded in pages carry no server-only fields', () => {
    expect(PUBLIC_RULES).toHaveLength(5);
    for (const rule of PUBLIC_RULES) {
      expect(Object.keys(rule).sort()).toEqual(['id', 'label', 'pattern']);
      expect(() => new RegExp(rule.pattern)).not.toThrow();
    }
  });
});
