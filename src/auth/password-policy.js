// Password complexity rules, shared by every place a password is set: the
// change-password page, admin create-user, admin password reset, and the
// forgot-password flow. Each rule is plain data (a regex source), so the same
// list is embedded in the page for the live browser checklist. The server
// check is the one that counts; the browser check is a convenience.
const PASSWORD_RULES = [
  {
    id: 'length',
    label: 'At least 8 characters',
    pattern: '^[\\s\\S]{8,}$',
    message: 'Password must be at least 8 characters long.',
  },
  {
    id: 'uppercase',
    label: 'One uppercase letter (A-Z)',
    pattern: '[A-Z]',
    message: 'Password must include an uppercase letter.',
  },
  {
    id: 'lowercase',
    label: 'One lowercase letter (a-z)',
    pattern: '[a-z]',
    message: 'Password must include a lowercase letter.',
  },
  {
    id: 'number',
    label: 'One number (0-9)',
    pattern: '[0-9]',
    message: 'Password must include a number.',
  },
  {
    id: 'special',
    label: 'One special character (for example ! @ # $ %)',
    pattern: '[^A-Za-z0-9\\s]',
    message: 'Password must include a special character such as ! @ # $ %.',
  },
];

// bcrypt only reads the first 72 bytes of a password, so anything longer would
// silently be ignored. Refuse it instead.
const MAX_PASSWORD_LENGTH = 72;

function failedPasswordRules(password) {
  const value = typeof password === 'string' ? password : '';
  return PASSWORD_RULES.filter(rule => !new RegExp(rule.pattern).test(value));
}

// Human-readable problems, one per failed rule; empty when the password is OK.
function passwordProblems(password) {
  const value = typeof password === 'string' ? password : '';
  const problems = failedPasswordRules(value).map(rule => rule.message);
  if (value.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
  }
  return problems;
}

// What a page needs to render the checklist: no messages, no functions.
const PUBLIC_RULES = PASSWORD_RULES.map(({ id, label, pattern }) => ({ id, label, pattern }));

module.exports = {
  PASSWORD_RULES, PUBLIC_RULES, MAX_PASSWORD_LENGTH, failedPasswordRules, passwordProblems,
};
