// Driver self sign-up. Anyone can create an account here, and it is always a
// driver: the role is not a field, so there is no form value that could ask
// for sponsor or admin. Sponsor users are created by an administrator or by
// their organization, and administrators only by an administrator.
//
// The password rules, duplicate checks, and the password-history record are
// the ones every other way of creating an account uses, through createUser.
// A new account is not signed in here: the visitor is sent to the login page,
// so their first sign-in is audited in login_attempts like everyone else's.

const express = require('express');
const { createUser, DuplicateError } = require('../users/store');
const { formToken, requireFormToken } = require('./form-token');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('./password-policy');
const { createRateLimiter, signupPolicy } = require('./rate-limit');
const { requestSource } = require('./request-source');

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letters, digits, dot, underscore, hyphen: a username is typed on the login
// page, read aloud over the phone, and shown in every admin list.
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const EMPTY = { name: '', email: '', username: '' };

// One limiter for the process. The policy is read on each request so an
// environment change applies without a restart; the window of an existing
// entry is judged by the policy in force when it is checked.
let limiter = null;
function signupLimiter() {
  const { max, windowMinutes } = signupPolicy();
  const windowMs = windowMinutes * 60 * 1000;
  if (!limiter || limiter.max !== max || limiter.windowMs !== windowMs) {
    limiter = Object.assign(createRateLimiter({ max, windowMs }), { max, windowMs });
  }
  return limiter;
}

function renderSignup(req, res, values, { error = null, status = 200 } = {}) {
  return res.status(status).render('signup', {
    values, error, token: formToken(req), rules: PUBLIC_RULES, maxLength: MAX_PASSWORD_LENGTH,
  });
}

router.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/');
  renderSignup(req, res, EMPTY);
});

router.post('/signup', requireFormToken, async (req, res, next) => {
  if (req.session.user) return res.redirect('/');
  const read = key => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');
  const values = { name: read('name'), email: read('email'), username: read('username') };
  // Passwords are never trimmed and never echoed back.
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

  // Checked before the form is validated, so a script cannot probe which
  // usernames exist for free: every post counts, valid or not.
  const source = requestSource(req);
  const limit = signupLimiter();
  const verdict = limit.check(source);
  if (!verdict.allowed) {
    const minutes = Math.max(1, Math.ceil(verdict.retryAfterMs / 60000));
    console.log(`[signup] refused: too many sign-ups from ${source || 'an unknown source'}`);
    return renderSignup(req, res, values, {
      error: `Too many sign-ups from this connection. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      status: 429,
    });
  }
  limit.hit(source);

  const problems = [];
  if (!values.name || values.name.length > 255) problems.push('Enter your name (up to 255 characters).');
  if (!values.email || values.email.length > 255 || !EMAIL_PATTERN.test(values.email)) problems.push('Enter a valid email address.');
  if (!USERNAME_PATTERN.test(values.username)) problems.push('Choose a username of 3 to 64 letters, numbers, dots, underscores, or hyphens.');
  problems.push(...passwordProblems(password));
  if (!problems.length && password !== confirmPassword) problems.push('The password and confirmation do not match.');
  if (problems.length) return renderSignup(req, res, values, { error: problems.join(' '), status: 400 });

  try {
    const created = await createUser({ ...values, password, role: 'driver' });
    console.log(`[signup] driver account created: ${created.username} (id ${created.id})`);
    res.redirect(303, '/login?created=1');
  } catch (err) {
    if (err instanceof DuplicateError) return renderSignup(req, res, values, { error: err.message, status: 409 });
    next(err);
  }
});

module.exports = router;
// For tests: start the throttle over between cases.
module.exports._resetLimiter = () => { if (limiter) limiter.reset(); };
