const express = require('express');
const db = require('../db');
const { verifyPassword } = require('./password');
const { idleLimitLabel } = require('./session-timeout');

const router = express.Router();

// Audit requirement: every login attempt is recorded (date, username, success).
async function recordLoginAttempt(username, success) {
  await db.query(
    'INSERT INTO login_attempts (username, success) VALUES (?, ?)',
    [username, success]
  );
}

// Story 22205: an account an admin has disabled or revoked cannot sign in, even
// with the right password. Returns null when the account may proceed.
function accessDeniedMessage(user) {
  if (user.status === 'revoked') {
    return 'This account has been revoked. Contact an administrator if you believe this is a mistake.';
  }
  if (user.status === 'disabled') {
    return 'This account is disabled. Contact your sponsor or an administrator to restore access.';
  }
  return null;
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  // Story 22208: say why they were signed out instead of showing a bare form.
  let notice = null;
  if (req.query.expired) {
    notice = `You were signed out after ${idleLimitLabel()} of inactivity. Please log in again.`;
  } else if (req.query.setup) {
    // Story 22255: arriving here after choosing a password from a setup link.
    notice = 'Your password is set. Please log in.';
  }
  res.render('login', { error: null, notice });
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

    // Role comes from the database — the form never asks for a user type.
    const rows = await db.query(
      'SELECT id, username, password_hash, role, status FROM users WHERE username = ?',
      [username]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));
    const denied = valid ? accessDeniedMessage(user) : null;

    // A blocked account is an unsuccessful login, so the audit log records it
    // as a failure even though the password was correct.
    await recordLoginAttempt(username, Boolean(valid) && !denied);

    if (!valid) {
      // Same message for unknown user and wrong password, so the form
      // doesn't reveal which usernames exist.
      return res.status(401).render('login', {
        error: 'Incorrect username or password.',
      });
    }

    if (denied) {
      return res.status(403).render('login', { error: denied });
    }

    // New session ID on login so a pre-login session can't be reused.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: user.id, username: user.username, role: user.role };
      req.session.lastActivity = Date.now();
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

    // Role comes from the database — the client never sends a user type.
    const rows = await db.query(
      'SELECT id, username, password_hash, role, status FROM users WHERE username = ?',
      [username]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));
    const denied = valid ? accessDeniedMessage(user) : null;

    // A blocked account is an unsuccessful login, so the audit log records it
    // as a failure even though the password was correct.
    await recordLoginAttempt(username, Boolean(valid) && !denied);

    if (!valid) {
      // Same message for unknown user and wrong password, so the response
      // doesn't reveal which usernames exist.
      return res.status(401).json({
        success: false,
        error: 'Incorrect username or password.',
      });
    }

    if (denied) {
      return res.status(403).json({ success: false, error: denied });
    }

    // New session ID on login so a pre-login session can't be reused.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: user.id, username: user.username, role: user.role };
      req.session.lastActivity = Date.now();
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

module.exports = router;
