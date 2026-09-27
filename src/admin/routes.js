const express = require('express');
const { randomBytes } = require('crypto');
const {
  VALID_ROLES, USER_STATUSES, DuplicateError, createUser, findUserById, listUsers, updateUserStatus,
  updateUserPassword, countRecentFailedLogins,
} = require('../users/store');
const { createSponsor, listSponsors } = require('../sponsors/store');
const { formToken, requireFormToken } = require('../auth/form-token');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('../auth/password-policy');
const { rememberAndRedirect } = require('../auth/return-to');
const { issueSetupToken, setupLinkFor, linkLifetimeHours } = require('../auth/setup-tokens');
const { sendMail } = require('../mail/mailer');
const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-only pages: creating users and sponsor organizations, managing user
// status, viewing sponsor status.
router.use(async (req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'admin') return res.status(403).send('Only admins can manage users and sponsors.');
  try {
    // The session only says who signed in. Re-read the account so an admin who
    // was disabled, revoked, demoted, or deleted since then is cut off on their
    // next admin request, not just at their next login.
    const account = await findUserById(req.session.user.id);
    const reason = !account ? 'missing' : account.status !== 'active' ? account.status : account.role !== 'admin' ? 'role' : null;
    if (reason) {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect(`/login?reason=${encodeURIComponent(reason)}`);
      });
    }
    next();
  } catch (err) { next(err); }
});
router.use(requireFormToken);

const read = (req, key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');

// ---- Create user ----------------------------------------------------------

const EMPTY_USER = { name: '', email: '', username: '', role: '' };

function renderCreateUser(req, res, values, { error = null, created = null, setupLink = null, status = 200 } = {}) {
  return res.status(status).render('create-user', {
    values, roles: VALID_ROLES, error, created, setupLink, token: formToken(req),
    rules: PUBLIC_RULES, maxLength: MAX_PASSWORD_LENGTH,
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
  // Story 22255: a blank password means the new user sets their own from a
  // setup link, so the admin never knows it. A password that is given must
  // meet the shared complexity rules.
  if (password) problems.push(...passwordProblems(password));
  if (!VALID_ROLES.includes(values.role)) problems.push('Choose a role: driver, sponsor, or admin.');
  if (problems.length) return renderCreateUser(req, res, values, { error: problems.join(' '), status: 400 });

  try {
    // With no password chosen, the account gets an unguessable one nobody
    // holds, so the only way in is the setup link.
    const usesSetupLink = password.length === 0;
    const created = await createUser({
      ...values,
      password: usesSetupLink ? randomBytes(32).toString('hex') : password,
    });

    let setupLink = null;
    if (usesSetupLink) {
      const rawToken = await issueSetupToken(created.id);
      setupLink = setupLinkFor(req, rawToken);
      await sendMail({
        to: created.email,
        subject: 'Set up your Good Driver Incentive Program account',
        text: [
          `Hello ${created.name},`,
          '',
          `An account has been created for you as a ${created.role}.`,
          'Choose your password using the link below:',
          '',
          setupLink,
          '',
          `The link works once and expires in ${linkLifetimeHours()} hours.`,
        ].join('\n'),
      });
    }

    renderCreateUser(req, res, EMPTY_USER, { created, setupLink });
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

// A status change can start from either list page. The form says which one
// (hidden `from` field) and the admin is sent back there afterwards. Anything
// not on this list falls back to the full user list.
const STATUS_PAGES = { 'manage-users': '/admin/manage-users', 'admin-accounts': '/admin/admin-accounts' };
const pageKey = value => (Object.prototype.hasOwnProperty.call(STATUS_PAGES, value) ? value : 'manage-users');
const returnPathFor = req => STATUS_PAGES[pageKey(read(req, 'from'))];

// One-shot notice shown on the next visit to a list page (success or no-op).
function flashAndRedirect(req, res, notice, path = STATUS_PAGES['manage-users']) {
  req.session.statusNotice = notice;
  res.redirect(303, path);
}
function takeNotice(req) {
  const notice = req.session.statusNotice || null;
  delete req.session.statusNotice;
  return notice;
}

router.get('/manage-users', async (req, res, next) => {
  try {
    const users = await listUsers();
    res.render('manage-users', {
      users, statuses: USER_STATUSES, notice: takeNotice(req), currentUserId: req.session.user.id, token: formToken(req),
    });
  } catch (err) { next(err); }
});

// Story: review and update the status of admin accounts. Same controls and
// the same confirm step as the full list, filtered to the admin team.
router.get('/admin-accounts', async (req, res, next) => {
  try {
    const admins = await listUsers({ role: 'admin' });
    res.render('admin-accounts', {
      admins, statuses: USER_STATUSES, notice: takeNotice(req), currentUserId: req.session.user.id, token: formToken(req),
    });
  } catch (err) { next(err); }
});

router.post('/manage-users/:userId/status', async (req, res, next) => {
  const user = req.targetUser;
  const status = read(req, 'status');
  const returnTo = returnPathFor(req);
  // A stale draft must never survive a new request for the same account.
  delete req.session.statusChange;
  if (!USER_STATUSES.includes(status)) return res.status(400).send('Choose a status: active, disabled, or revoked.');
  if (user.id === req.session.user.id && status !== 'active') {
    return flashAndRedirect(req, res, { kind: 'error', text: 'You cannot disable or revoke your own account.' }, returnTo);
  }
  if (status === user.status) {
    return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, status is already ${status}.` }, returnTo);
  }
  try {
    if (status === 'active') {
      // Restoring access needs no confirmation.
      await updateUserStatus(user.id, status);
      return flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${status}.` }, returnTo);
    }
    req.session.statusChange = { userId: user.id, status, returnTo, confirmId: randomBytes(32).toString('hex') };
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
      return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, status is already ${user.status}.` }, draft.returnTo);
    }
    await updateUserStatus(user.id, draft.status);
    flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${draft.status}.` }, draft.returnTo);
  } catch (err) { next(err); }
});

// ---- Impersonation (drivers and sponsors only) -----------------------------

// The admin's session becomes the target's, with the admin remembered so the
// banner's stop button can switch back. Never admins, never inactive accounts.
router.post('/impersonate/:userId', (req, res) => {
  const target = req.targetUser;
  const returnTo = returnPathFor(req);
  const refuse = text => flashAndRedirect(req, res, { kind: 'error', text }, returnTo);
  if (target.role === 'admin') {
    return refuse(`Cannot sign in as ${target.username}: admin accounts cannot be impersonated.`);
  }
  if (target.status !== 'active') {
    return refuse(`Cannot sign in as ${target.username}: that account is ${target.status}. Only active accounts can be impersonated.`);
  }
  const admin = req.session.user;
  req.session.impersonator = { id: admin.id, username: admin.username, role: admin.role, sponsorId: admin.sponsorId ?? null, returnTo };
  // sponsorId is read by the sponsor homepage; null (never undefined) so the query binds cleanly.
  req.session.user = { id: target.id, username: target.username, role: target.role, sponsorId: target.sponsor_id ?? null };
  delete req.session.statusChange;
  console.log(`[impersonation] ${admin.username} (id ${admin.id}) started acting as ${target.username} (id ${target.id})`);
  res.redirect(303, '/');
});

// ---- Reset a user's password on their behalf ------------------------------

// Same rules and the same hashing helper as every other password form. The
// audit log is left untouched; the page only shows the recent failure count.

function renderResetPassword(req, res, { from, failedLogins, error = null, status = 200 }) {
  return res.status(status).render('admin-reset-password', {
    user: req.targetUser, rules: PUBLIC_RULES, maxLength: MAX_PASSWORD_LENGTH, token: formToken(req),
    from, returnTo: STATUS_PAGES[from], failedLogins, error,
  });
}

router.get('/manage-users/:userId/password', async (req, res, next) => {
  // Your own password goes through the profile page, which asks for the current one.
  if (req.targetUser.id === req.session.user.id) return res.redirect('/profile/password');
  const from = pageKey(typeof req.query.from === 'string' ? req.query.from : '');
  try {
    const failedLogins = await countRecentFailedLogins(req.targetUser.username);
    renderResetPassword(req, res, { from, failedLogins });
  } catch (err) { next(err); }
});

router.post('/manage-users/:userId/password', async (req, res, next) => {
  const user = req.targetUser;
  const from = pageKey(read(req, 'from'));
  if (user.id === req.session.user.id) {
    return flashAndRedirect(req, res, { kind: 'error', text: 'Change your own password from your profile page.' }, STATUS_PAGES[from]);
  }
  // Passwords are never trimmed.
  const field = key => (typeof req.body[key] === 'string' ? req.body[key] : '');
  const newPassword = field('newPassword');
  const confirmPassword = field('confirmPassword');
  try {
    const problems = passwordProblems(newPassword);
    if (!problems.length && newPassword !== confirmPassword) problems.push('The new password and confirmation do not match.');
    if (problems.length) {
      const failedLogins = await countRecentFailedLogins(user.username);
      return renderResetPassword(req, res, { from, failedLogins, error: problems.join(' '), status: 400 });
    }
    await updateUserPassword(user.id, newPassword);
    flashAndRedirect(req, res, { kind: 'success', text: `Password for ${user.username} was reset.` }, STATUS_PAGES[from]);
  } catch (err) { next(err); }
});

module.exports = router;
