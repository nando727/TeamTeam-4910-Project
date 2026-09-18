const express = require('express');
const { DuplicateError, findUserById, updateUserContact } = require('../users/store');
const { getAbout } = require('../about/store');
const { formToken, requireFormToken } = require('../auth/form-token');
const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- About (public) -------------------------------------------------------

// mysql2 returns DATE columns as local-midnight Date objects.
function formatDate(value) {
  if (value instanceof Date) {
    return value.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  return value == null ? '' : String(value);
}

router.get('/about', async (req, res, next) => {
  try {
    const about = await getAbout();
    res.render('about', {
      about,
      releaseDate: about ? formatDate(about.release_date) : '',
      user: req.session.user || null,
    });
  } catch (err) { next(err); }
});

// ---- Profile (logged-in user) ---------------------------------------------

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function renderProfile(req, res, profile, { editing = false, values = null, error = null, success = null, status = 200 } = {}) {
  return res.status(status).render('profile', {
    profile,
    editing,
    values: values || { name: profile.name || '', email: profile.email || '' },
    error,
    success,
    token: formToken(req),
  });
}

async function loadProfile(req, res, next) {
  try {
    const profile = await findUserById(req.session.user.id);
    if (!profile) return res.status(404).send('Your account could not be found.');
    req.profile = profile;
    next();
  } catch (err) { next(err); }
}

router.get('/profile', requireLogin, loadProfile, (req, res) => {
  renderProfile(req, res, req.profile);
});

router.get('/profile/edit', requireLogin, loadProfile, (req, res) => {
  renderProfile(req, res, req.profile, { editing: true });
});

router.post('/profile', requireLogin, requireFormToken, loadProfile, async (req, res, next) => {
  const read = key => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');
  const values = { name: read('name'), email: read('email') };

  const problems = [];
  if (!values.name || values.name.length > 255) problems.push('Enter a name (up to 255 characters).');
  if (!values.email || values.email.length > 255 || !EMAIL_PATTERN.test(values.email)) problems.push('Enter a valid email address.');
  if (problems.length) {
    return renderProfile(req, res, req.profile, { editing: true, values, error: problems.join(' '), status: 400 });
  }

  try {
    const updated = await updateUserContact(req.profile.id, values);
    renderProfile(req, res, updated, { success: 'Profile updated successfully.' });
  } catch (err) {
    if (err instanceof DuplicateError) {
      return renderProfile(req, res, req.profile, { editing: true, values, error: err.message, status: 409 });
    }
    next(err);
  }
});

module.exports = router;
