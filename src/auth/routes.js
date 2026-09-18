const express = require('express');
const db = require('../db');
const { verifyPassword } = require('./password');

const router = express.Router();

// Audit requirement: every login attempt is recorded (date, username, success).
async function recordLoginAttempt(username, success) {
  await db.query(
    'INSERT INTO login_attempts (username, success) VALUES (?, ?)',
    [username, success]
  );
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
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
      'SELECT id, username, password_hash, role FROM users WHERE username = ?',
      [username]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));

    await recordLoginAttempt(username, Boolean(valid));

    if (!valid) {
      // Same message for unknown user and wrong password, so the form
      // doesn't reveal which usernames exist.
      return res.status(401).render('login', {
        error: 'Incorrect username or password.',
      });
    }

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

    // Role comes from the database — the client never sends a user type.
    const rows = await db.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = ?',
      [username]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));

    await recordLoginAttempt(username, Boolean(valid));

    if (!valid) {
      // Same message for unknown user and wrong password, so the response
      // doesn't reveal which usernames exist.
      return res.status(401).json({
        success: false,
        error: 'Incorrect username or password.',
      });
    }

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

module.exports = router;
