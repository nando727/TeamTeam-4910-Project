// Story 22255: where a newly created user claims their account. The token in
// the URL is the only credential, so no login is required here — which is why
// every handler re-checks it rather than trusting an earlier render.

const express = require('express');
const db = require('../db');
const { hashPassword } = require('../auth/password');
const { findValidToken, consumeToken } = require('../auth/setup-tokens');
const { formToken, requireFormToken } = require('../auth/form-token');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('../auth/password-policy');

const router = express.Router();

function renderExpired(res) {
  // 410 Gone: the link was real at some point but can't be used now.
  return res.status(410).render('setup-expired');
}

function renderForm(req, res, { error = null, status = 200 } = {}) {
  return res.status(status).render('setup', {
    token: req.params.token,
    formToken: formToken(req),
    rules: PUBLIC_RULES,
    maxLength: MAX_PASSWORD_LENGTH,
    error,
  });
}

router.get('/setup/:token', async (req, res, next) => {
  try {
    const setupToken = await findValidToken(req.params.token);
    if (!setupToken) return renderExpired(res);
    renderForm(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/setup/:token', requireFormToken, async (req, res, next) => {
  try {
    // Re-checked on submit: the link may have expired or been used since the
    // form was rendered.
    const setupToken = await findValidToken(req.params.token);
    if (!setupToken) return renderExpired(res);

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    // Same complexity rules as every other password form; each failed rule
    // gets its own sentence.
    const problems = passwordProblems(password);
    if (problems.length) {
      return renderForm(req, res, { error: problems.join(' '), status: 400 });
    }
    if (password !== confirmation) {
      return renderForm(req, res, { error: 'Both passwords must match.', status: 400 });
    }

    // Spend the link first. If two submits race, only one gets past this.
    const consumed = await consumeToken(setupToken.id);
    if (!consumed) return renderExpired(res);

    const passwordHash = await hashPassword(password);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, setupToken.user_id]);

    res.redirect('/login?setup=1');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
