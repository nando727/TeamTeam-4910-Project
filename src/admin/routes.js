const express = require('express');
const { VALID_ROLES, DuplicateError, createUser } = require('../users/store');
const { createSponsor } = require('../sponsors/store');
const { formToken, requireFormToken } = require('../auth/form-token');
const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-only pages: creating users and sponsor organizations.
router.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).send('Only admins can manage users and sponsors.');
  next();
});
router.use(requireFormToken);

const read = (req, key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');

// ---- Create user ----------------------------------------------------------

const EMPTY_USER = { name: '', email: '', username: '', role: '' };

function renderCreateUser(req, res, values, { error = null, created = null, status = 200 } = {}) {
  return res.status(status).render('create-user', {
    values, roles: VALID_ROLES, error, created, token: formToken(req),
  });
}

router.get('/create-user', (req, res) => {
  renderCreateUser(req, res, EMPTY_USER);
});

router.post('/create-user', async (req, res, next) => {
  const values = {
    name: read(req, 'name'), email: read(req, 'email'),
    username: read(req, 'username'), role: read(req, 'role'),
  };
  // Never echoed back to the page; the field is emptied on every re-render.
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const problems = [];
  if (!values.name || values.name.length > 255) problems.push('Enter a name (up to 255 characters).');
  if (!values.email || values.email.length > 255 || !EMAIL_PATTERN.test(values.email)) problems.push('Enter a valid email address.');
  if (!values.username || values.username.length > 64) problems.push('Enter a username (up to 64 characters).');
  if (password.length < 8) problems.push('Password must be at least 8 characters.');
  if (!VALID_ROLES.includes(values.role)) problems.push('Choose a role: driver, sponsor, or admin.');
  if (problems.length) return renderCreateUser(req, res, values, { error: problems.join(' '), status: 400 });

  try {
    const created = await createUser({ ...values, password });
    renderCreateUser(req, res, EMPTY_USER, { created });
  } catch (err) {
    if (err instanceof DuplicateError) return renderCreateUser(req, res, values, { error: err.message, status: 409 });
    next(err);
  }
});

// ---- Create sponsor -------------------------------------------------------

const EMPTY_SPONSOR = { name: '', contactEmail: '', contactPhone: '', address: '' };

function renderCreateSponsor(req, res, values, { error = null, created = null, status = 200 } = {}) {
  return res.status(status).render('create-sponsor', { values, error, created, token: formToken(req) });
}

router.get('/create-sponsor', (req, res) => {
  renderCreateSponsor(req, res, EMPTY_SPONSOR);
});

router.post('/create-sponsor', async (req, res, next) => {
  const values = {
    name: read(req, 'name'), contactEmail: read(req, 'contactEmail'),
    contactPhone: read(req, 'contactPhone'), address: read(req, 'address'),
  };

  const problems = [];
  if (!values.name || values.name.length > 255) problems.push('Enter an organization name (up to 255 characters).');
  if (!values.contactEmail || values.contactEmail.length > 255 || !EMAIL_PATTERN.test(values.contactEmail)) problems.push('Enter a valid contact email.');
  if (!values.contactPhone || values.contactPhone.length > 32) problems.push('Enter a contact phone (up to 32 characters).');
  if (!values.address || values.address.length > 255) problems.push('Enter an address (up to 255 characters).');
  if (problems.length) return renderCreateSponsor(req, res, values, { error: problems.join(' '), status: 400 });

  try {
    const created = await createSponsor(values);
    renderCreateSponsor(req, res, EMPTY_SPONSOR, { created });
  } catch (err) {
    if (err instanceof DuplicateError) return renderCreateSponsor(req, res, values, { error: err.message, status: 409 });
    next(err);
  }
});

module.exports = router;
