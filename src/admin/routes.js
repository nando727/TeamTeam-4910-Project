const express = require('express');
const { randomBytes } = require('crypto');
const {
  VALID_ROLES, USER_STATUSES, DuplicateError, createUser, findUserById, listUsers, updateUserStatus,
} = require('../users/store');
const { createSponsor, listSponsors } = require('../sponsors/store');
const { formToken, requireFormToken } = require('../auth/form-token');
const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-only pages: creating users and sponsor organizations, managing user
// status, viewing sponsor status.
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

// ---- Sponsor status (read-only) -------------------------------------------

router.get('/sponsor-status', async (req, res, next) => {
  try {
    const sponsors = await listSponsors();
    res.render('sponsor-status', { sponsors });
  } catch (err) { next(err); }
});

// ---- Manage users (change account status) ---------------------------------

// Same flow as the sponsor application review: a disable/revoke is held in the
// session until the admin confirms it on a separate page. Only a confirmed
// submit that echoes the one-time confirmId writes to the database.

router.param('userId', async (req, res, next, id) => {
  try {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return res.status(400).send('Please select a valid user.');
    const user = await findUserById(Number(id));
    if (!user) return res.status(404).send('That user no longer exists.');
    req.targetUser = user;
    next();
  } catch (err) { next(err); }
});

function statusDraftFor(req) {
  const draft = req.session.statusChange;
  return draft && draft.userId === req.targetUser.id ? draft : null;
}

// One-shot notice shown on the next visit to the list (success or no-op).
function flashAndRedirect(req, res, notice) {
  req.session.manageUsersNotice = notice;
  res.redirect(303, '/admin/manage-users');
}

router.get('/manage-users', async (req, res, next) => {
  try {
    const users = await listUsers();
    const notice = req.session.manageUsersNotice || null;
    delete req.session.manageUsersNotice;
    res.render('manage-users', {
      users, statuses: USER_STATUSES, notice, currentUserId: req.session.user.id, token: formToken(req),
    });
  } catch (err) { next(err); }
});

router.post('/manage-users/:userId/status', async (req, res, next) => {
  const user = req.targetUser;
  const status = read(req, 'status');
  // A stale draft must never survive a new request for the same account.
  delete req.session.statusChange;
  if (!USER_STATUSES.includes(status)) return res.status(400).send('Choose a status: active, disabled, or revoked.');
  if (user.id === req.session.user.id && status !== 'active') {
    return flashAndRedirect(req, res, { kind: 'error', text: 'You cannot disable or revoke your own account.' });
  }
  if (status === user.status) {
    return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, status is already ${status}.` });
  }
  try {
    if (status === 'active') {
      // Restoring access needs no confirmation.
      await updateUserStatus(user.id, status);
      return flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${status}.` });
    }
    req.session.statusChange = { userId: user.id, status, confirmId: randomBytes(32).toString('hex') };
    res.redirect(303, `/admin/manage-users/${user.id}/confirm`);
  } catch (err) { next(err); }
});

router.get('/manage-users/:userId/confirm', (req, res) => {
  const draft = statusDraftFor(req);
  if (!draft) return res.redirect('/admin/manage-users');
  res.render('user-status-confirm', { user: req.targetUser, draft, token: formToken(req) });
});

router.post('/manage-users/:userId/confirm', async (req, res, next) => {
  const user = req.targetUser;
  const draft = statusDraftFor(req);
  if (!draft || req.body.confirmId !== draft.confirmId) {
    return res.status(400).send('Confirm the status change before saving it.');
  }
  try {
    delete req.session.statusChange;
    // The account may have changed since the draft was made; re-check before writing.
    if (draft.status === user.status) {
      return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, status is already ${user.status}.` });
    }
    await updateUserStatus(user.id, draft.status);
    flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${draft.status}.` });
  } catch (err) { next(err); }
});

module.exports = router;
