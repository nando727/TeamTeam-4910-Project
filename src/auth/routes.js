const express = require('express');
const db = require('../db');
const { verifyPassword } = require('./password');
const { formToken, requireFormToken } = require('./form-token');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('./password-policy');
const { updateUserPassword } = require('../users/store');
const { createResetToken, findValidReset, consumeReset, TOKEN_PATTERN, EXPIRY_MINUTES } = require('./password-reset');
const { sendPasswordResetLink } = require('./mailer');

const router = express.Router();

// Audit requirement: every login attempt is recorded (date, username, success).
async function recordLoginAttempt(username, success) {
  await db.query(
    'INSERT INTO login_attempts (username, success) VALUES (?, ?)',
    [username, success]
  );
}

// Shown when the password is right but the account is not active. Only a
// caller who already knows the password sees these, so naming the status is
// safe and tells the user exactly why they cannot get in.
const BLOCKED_MESSAGES = {
  disabled: 'This account has been disabled. Contact an administrator to restore access.',
  revoked: 'Access for this account has been revoked. Contact an administrator.',
  default: 'This account is not active. Contact an administrator.',
};

// Shared by the form login and the JSON login: one credential check, one audit
// row, one status rule. Returns { outcome: 'invalid' | 'blocked' | 'ok' }.
async function authenticate(username, password) {
  // Role and status come from the database; the client never sends them.
  const rows = await db.query(
    'SELECT id, username, password_hash, role, status FROM users WHERE username = ?',
    [username]
  );
  const user = rows[0];
  const valid = Boolean(user && (await verifyPassword(password, user.password_hash)));
  // A disabled or revoked account cannot sign in even with the right password,
  // and that is recorded as a failed attempt.
  const blocked = valid && user.status !== 'active';
  await recordLoginAttempt(username, valid && !blocked);

  if (!valid) return { outcome: 'invalid' };
  if (blocked) return { outcome: 'blocked', message: BLOCKED_MESSAGES[user.status] || BLOCKED_MESSAGES.default };
  return { outcome: 'ok', user };
}

// Why a signed-in admin was sent back here by the admin router's status check.
// Only these keys are honored, so the query string cannot inject text.
const SIGNED_OUT_REASONS = {
  disabled: 'Your account was disabled and you have been signed out. Contact an administrator to restore access.',
  revoked: 'Access for your account was revoked and you have been signed out. Contact an administrator.',
  missing: 'Your account no longer exists and you have been signed out.',
  role: 'Your account role changed and you have been signed out. Sign in again.',
};

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const reason = typeof req.query.reason === 'string' ? req.query.reason : '';
  const notice = req.query.reset === 'done' ? 'Your password was reset. Sign in with your new password.' : null;
  res.render('login', { error: SIGNED_OUT_REASONS[reason] || null, notice });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).render('login', {
        error: 'Please enter both a username and a password.',
      });
    }

    const result = await authenticate(username, password);

    if (result.outcome === 'invalid') {
      // Same message for unknown user and wrong password, so the form
      // doesn't reveal which usernames exist.
      return res.status(401).render('login', {
        error: 'Incorrect username or password.',
      });
    }
    if (result.outcome === 'blocked') {
      return res.status(403).render('login', { error: result.message });
    }

    const { user } = result;
    // New session ID on login so a pre-login session can't be reused.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.redirect('/');
    });
  } catch (err) {
    next(err);
  }
});

// JSON variant of POST /login for the React client. Same credential check,
// same audit logging, same session handling; only the response shape differs.
router.post('/api/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Please enter both a username and a password.',
      });
    }

    const result = await authenticate(username, password);

    if (result.outcome === 'invalid') {
      // Same message for unknown user and wrong password, so the response
      // doesn't reveal which usernames exist.
      return res.status(401).json({
        success: false,
        error: 'Incorrect username or password.',
      });
    }
    if (result.outcome === 'blocked') {
      return res.status(403).json({ success: false, error: result.message });
    }

    const { user } = result;
    // New session ID on login so a pre-login session can't be reused.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.json({ success: true, role: user.role });
    });
  } catch (err) {
    next(err);
  }
});

// Story 22202: destroy the server-side session so the old cookie is worthless.
// POST only, so a link or a prefetch can't sign someone out.
router.post('/logout', (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// ---- Stop impersonating (any role: the session currently belongs to the
// impersonated user, so this cannot live behind the admin guard) -------------

router.post('/impersonate/stop', requireFormToken, (req, res) => {
  const admin = req.session.impersonator;
  if (!admin) return res.redirect('/');
  const acted = req.session.user;
  req.session.user = { id: admin.id, username: admin.username, role: admin.role };
  delete req.session.impersonator;
  // Anything the driver/sponsor pages stashed must not follow the admin back.
  for (const key of ['applicationDraft', 'applicationToken', 'applicationSuccess']) delete req.session[key];
  console.log(`[impersonation] ${admin.username} (id ${admin.id}) stopped acting as ${acted.username} (id ${acted.id})`);
  req.session.statusNotice = { kind: 'info', text: `You stopped acting as ${acted.username}.` };
  res.redirect(303, admin.returnTo || '/admin/manage-users');
});

// ---- Forgot password -----------------------------------------------------------

function renderForgot(req, res, { username = '', error = null, sent = false, status = 200 } = {}) {
  return res.status(status).render('forgot-password', { username, error, sent, expiryMinutes: EXPIRY_MINUTES });
}

router.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/profile/password');
  renderForgot(req, res);
});

router.post('/forgot-password', async (req, res, next) => {
  if (req.session.user) return res.redirect('/profile/password');
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!username || username.length > 64) {
    return renderForgot(req, res, { username, error: 'Enter your username.', status: 400 });
  }
  try {
    const rows = await db.query('SELECT id, username, email, status FROM users WHERE username = ?', [username]);
    const user = rows[0];
    // Only active accounts get a link, but the page says the same thing either
    // way so it cannot be used to discover which usernames exist.
    if (user && user.status === 'active') {
      const token = await createResetToken(user.id);
      const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await sendPasswordResetLink({
        username: user.username, email: user.email,
        link: `${base}/reset-password/${token}`, expiryMinutes: EXPIRY_MINUTES,
      });
    }
    renderForgot(req, res, { sent: true });
  } catch (err) { next(err); }
});

// ---- Reset password with a token ------------------------------------------

function renderReset(req, res, reset, { error = null, status = 200 } = {}) {
  return res.status(status).render('reset-password', {
    reset, token: req.params.token, error, rules: PUBLIC_RULES, maxLength: MAX_PASSWORD_LENGTH,
  });
}

// A link for an account that is no longer active is treated as invalid.
async function loadReset(req) {
  if (!TOKEN_PATTERN.test(req.params.token)) return null;
  const reset = await findValidReset(req.params.token);
  return reset && reset.status === 'active' ? reset : null;
}

router.get('/reset-password/:token', async (req, res, next) => {
  try {
    const reset = await loadReset(req);
    renderReset(req, res, reset, { status: reset ? 200 : 404 });
  } catch (err) { next(err); }
});

router.post('/reset-password/:token', async (req, res, next) => {
  const field = key => (typeof req.body[key] === 'string' ? req.body[key] : '');
  const newPassword = field('newPassword');
  const confirmPassword = field('confirmPassword');
  try {
    const reset = await loadReset(req);
    if (!reset) return renderReset(req, res, null, { status: 404 });

    const problems = passwordProblems(newPassword);
    if (!problems.length && newPassword !== confirmPassword) problems.push('The new password and confirmation do not match.');
    if (problems.length) return renderReset(req, res, reset, { error: problems.join(' '), status: 400 });

    // Spend the token before writing, so a second submit with the same link fails.
    if (!(await consumeReset(reset.id))) return renderReset(req, res, null, { status: 404 });
    await updateUserPassword(reset.userId, newPassword);
    console.log(`[password-reset] password reset completed for ${reset.username} (id ${reset.userId})`);
    res.redirect(303, '/login?reset=done');
  } catch (err) { next(err); }
});

module.exports = router;
