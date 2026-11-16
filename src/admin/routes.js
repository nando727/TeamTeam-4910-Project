const express = require('express');
const { randomBytes } = require('crypto');
const {
  VALID_ROLES, USER_STATUSES, DuplicateError, createUser, findUserById, listUsers, updateUserStatus,
  updateUserPassword, countRecentFailedLogins, revokeSessions, SamePasswordError,
  searchUsers, countUsers, countActiveAdmins, roleChangeImpact, changeUserRole,
} = require('../users/store');
const { createSponsor, listSponsors, findSponsorById } = require('../sponsors/store');
const { listDriversForSponsor, listSponsorAccounts } = require('../sponsors/accounts');
const { ACTIONS, actionLabel, recordAdminAction, listAdminActions, countAdminActions } = require('./audit');
const { positiveInt, text, queryString, formatStamp } = require('../reports/helpers');
const { formToken, requireFormToken } = require('../auth/form-token');
const { requireActiveAdmin } = require('./guard');
const { listDriverSponsors, addDriverSponsor, removeDriverSponsor, MembershipError } = require('../memberships/store');
const {
  PUBLIC_RULES, MAX_PASSWORD_LENGTH, PASSWORD_HISTORY_LIMIT, passwordProblems,
} = require('../auth/password-policy');
const {
  issueSetupToken, setupLinkFor, linkLifetimeHours, invalidateSetupTokens, userIdsAwaitingSetup,
} = require('../auth/setup-tokens');
const { sendMail } = require('../mail/mailer');
const { setupMailNotice } = require('../mail/outcome');
const { lockedUsernames, clearLockout } = require('../auth/lockout');
const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-only pages: creating users and sponsor organizations, managing user
// status, viewing sponsor status. The guard lives in ./guard so the bulk
// upload router (mounted separately because it streams multipart) shares it.
router.use(requireActiveAdmin);
router.use(requireFormToken);

const read = (req, key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');

// ---- Create user ----------------------------------------------------------

const EMPTY_USER = { name: '', email: '', username: '', role: '' };

function renderCreateUser(req, res, values, { error = null, created = null, setupLink = null, mailNotice = null, status = 200 } = {}) {
  return res.status(status).render('create-user', {
    values, roles: VALID_ROLES, error, created, setupLink, mailNotice, token: formToken(req),
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
    let mailNotice = null;
    if (usesSetupLink) {
      const rawToken = await issueSetupToken(created.id);
      setupLink = setupLinkFor(req, rawToken);
      const mail = await sendMail({
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
      mailNotice = setupMailNotice(mail);
    }

    renderCreateUser(req, res, EMPTY_USER, { created, setupLink, mailNotice });
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

// ---- One sponsor organization (sprint 9) ----------------------------------
//
// Sponsor status answers "which organizations exist?". This answers "who
// belongs to this one?", which until now could only be worked out by reading
// the whole user list: its details, the sponsor users who act for it, and its
// drivers with the points they hold there.

router.get('/sponsors/:sponsorId', async (req, res, next) => {
  const id = positiveInt(req.params.sponsorId);
  if (!id) return res.status(400).send('Please select a valid sponsor organization.');
  try {
    const organization = await findSponsorById(id);
    if (!organization) return res.status(404).send('That sponsor organization no longer exists.');
    const [sponsorUsers, drivers] = await Promise.all([listSponsorAccounts(id), listDriversForSponsor(id)]);
    const totalPoints = drivers.reduce((sum, driver) => sum + Number(driver.balance || 0), 0);
    res.render('admin/organization', {
      organization, sponsorUsers, drivers, totalPoints, notice: takeNotice(req),
      activeDrivers: drivers.filter(driver => driver.status === 'active').length,
    });
  } catch (err) { next(err); }
});

// ---- Audit log (sprint 9) -------------------------------------------------
//
// What administrators have done to accounts, newest first. The sign-in log
// (login_attempts) and the password log (password_changes) answer their own
// questions; this one answers "who changed this account, and what went with
// it?", which role changes made worth asking.

const AUDIT_PAGE_SIZE = 25;

router.get('/audit-log', async (req, res, next) => {
  try {
    const wanted = text(req.query.action);
    const action = Object.prototype.hasOwnProperty.call(ACTIONS, wanted) && wanted !== 'other' ? wanted : '';
    const userId = positiveInt(text(req.query.user));
    const filters = { action: action || null, targetUserId: userId };

    const total = await countAdminActions(filters);
    const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
    const page = Math.min(positiveInt(text(req.query.page)) || 1, pageCount);
    const rows = await listAdminActions(filters, { limit: AUDIT_PAGE_SIZE, offset: (page - 1) * AUDIT_PAGE_SIZE });
    const state = { action, user: userId ? String(userId) : '' };
    const pageHref = n => '/admin/audit-log' + queryString({ ...state, page: n > 1 ? n : null });
    const target = userId ? await findUserById(userId) : null;

    res.render('admin/audit-log', {
      rows, actions: Object.entries(ACTIONS).filter(([key]) => key !== 'other').map(([value, label]) => ({ value, label })),
      state, target, actionLabel, formatStamp,
      total, page, pageCount,
      pageStart: total ? (page - 1) * AUDIT_PAGE_SIZE + 1 : 0, pageEnd: Math.min(page * AUDIT_PAGE_SIZE, total),
      prevHref: page > 1 ? pageHref(page - 1) : null, nextHref: page < pageCount ? pageHref(page + 1) : null,
      filtered: Boolean(action || userId),
    });
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

// Who the audit log credits. While an admin is acting as somebody else the
// session user is that somebody, so the impersonator is the one who really
// did it -- the same rule the password-change log already uses.
const actingAdminId = req => (req.session.impersonator ? req.session.impersonator.id : req.session.user.id);

// A status change can start from either list page. The form says which one
// (hidden `from` field) and the admin is sent back there afterwards. Anything
// not on this list falls back to the full user list.
const STATUS_PAGES = {
  'manage-users': '/admin/manage-users',
  'admin-accounts': '/admin/admin-accounts',
  'locked-users': '/admin/locked-users',
};
const pageKey = value => (Object.prototype.hasOwnProperty.call(STATUS_PAGES, value) ? value : 'manage-users');

// Sprint 9: the search and filters on Manage users have to survive paging and
// every action taken from a row, or an administrator who filters, changes one
// account, and is returned to the unfiltered first page has to find their way
// back each time.
//
// Each row's form carries the current filters as hidden fields, and they are
// read back through the same validation as the query string: the state in a
// form is no more trusted than the state in a URL. `page` is dropped from an
// action's return path on purpose when the filters are what matters -- the row
// may well not be on that page any more.
// The query string uses q/role/status/sponsor/page. A row's form cannot: its
// own fields are already called `role` and `status` (the new role, the new
// status), so in a form body the filters are prefixed with `f`. Both are read
// through this one function, into the same state object either way.
function manageFilterState(source = {}, prefix = '') {
  const value = key => (typeof source[prefix + key] === 'string' ? source[prefix + key].trim() : '');
  const role = value('role');
  const status = value('status');
  return {
    q: value('q').slice(0, 128),
    role: VALID_ROLES.includes(role) ? role : '',
    status: USER_STATUSES.includes(status) ? status : '',
    sponsor: positiveInt(value('sponsor')) ? value('sponsor') : '',
    page: positiveInt(value('page')) ? value('page') : '',
  };
}
const manageUsersPath = (state, { keepPage = true } = {}) =>
  STATUS_PAGES['manage-users'] + queryString({ ...state, page: keepPage ? state.page : null });

function returnPathFor(req) {
  const key = pageKey(read(req, 'from'));
  if (key !== 'manage-users') return STATUS_PAGES[key];
  return manageUsersPath(manageFilterState(req.body, 'f'), { keepPage: false });
}

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

const MANAGE_PAGE_SIZE = 25;

router.get('/manage-users', async (req, res, next) => {
  try {
    const state = manageFilterState(req.query);
    const sponsors = await listSponsors();
    // A sponsor id that is not a real organization filters on nothing and
    // would quietly show an empty list, so it is dropped and said out loud.
    const problems = [];
    let sponsorId = positiveInt(state.sponsor);
    if (sponsorId && !sponsors.some(s => s.id === sponsorId)) {
      sponsorId = null;
      state.sponsor = '';
      problems.push('Choose a sponsor organization from the list.');
    }
    const filters = { search: state.q || null, role: state.role || null, status: state.status || null, sponsorId };

    const total = await countUsers(filters);
    const pageCount = Math.max(1, Math.ceil(total / MANAGE_PAGE_SIZE));
    const page = Math.min(positiveInt(state.page) || 1, pageCount);
    state.page = page > 1 ? String(page) : '';
    const users = await searchUsers(filters, { limit: MANAGE_PAGE_SIZE, offset: (page - 1) * MANAGE_PAGE_SIZE });

    // Story 22255 follow-up: who still owes us a password, so the list can
    // offer them a fresh setup link.
    const awaitingSetup = new Set(await userIdsAwaitingSetup());
    // Story AA-72: who cannot sign in right now, so the list can let them
    // back in. One query for the page, not one per account.
    const locked = await lockedUsernames();
    const pageHref = n => manageUsersPath({ ...state, page: n > 1 ? String(n) : '' });
    const filtered = Boolean(state.q || state.role || state.status || state.sponsor);
    const chosenSponsor = sponsorId ? sponsors.find(s => s.id === sponsorId) : null;

    res.status(problems.length ? 400 : 200).render('manage-users', {
      users: users.map(user => ({
        ...user, awaitingSetup: awaitingSetup.has(user.id), locked: locked.has(user.username),
      })),
      statuses: USER_STATUSES, roles: VALID_ROLES, sponsors, state, filters: state, filtered, chosenSponsor,
      error: problems.length ? problems.join(' ') : null,
      notice: takeNotice(req), currentUserId: req.session.user.id, token: formToken(req),
      total, page, pageCount, pageSize: MANAGE_PAGE_SIZE,
      pageStart: total ? (page - 1) * MANAGE_PAGE_SIZE + 1 : 0, pageEnd: Math.min(page * MANAGE_PAGE_SIZE, total),
      prevHref: page > 1 ? pageHref(page - 1) : null, nextHref: page < pageCount ? pageHref(page + 1) : null,
      clearHref: STATUS_PAGES['manage-users'],
    });
  } catch (err) { next(err); }
});

// Story AA-72: the accounts that cannot sign in right now, on their own page.
// Manage users marks them, but "who is locked out?" is the question an admin
// has when somebody calls them, and it should not mean reading every row.
router.get('/locked-users', async (req, res, next) => {
  try {
    const locked = await lockedUsernames();
    const users = (await listUsers()).filter(user => locked.has(user.username));
    res.render('locked-users', { users, notice: takeNotice(req), token: formToken(req) });
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
      await recordAdminAction({
        adminUserId: actingAdminId(req), targetUserId: user.id, action: 'status-change',
        detail: `${user.username}: ${user.status} to active`,
      });
      return flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${status}.` }, returnTo);
    }
    req.session.statusChange = { userId: user.id, status, returnTo, confirmId: randomBytes(32).toString('hex') };
    res.redirect(303, `/admin/manage-users/${user.id}/confirm`);
  } catch (err) { next(err); }
});

// Story AA-72: let a locked-out user sign in again without waiting out the
// clock. The form token is required by the router-wide guard above, like every
// other action on this page.
router.post('/manage-users/:userId/unlock', async (req, res, next) => {
  const user = req.targetUser;
  try {
    // Checked first so the notice tells the truth, the same way a status
    // change that changes nothing says so.
    const returnTo = returnPathFor(req);
    const locked = await lockedUsernames();
    if (!locked.has(user.username)) {
      return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, ${user.username} is not locked out.` }, returnTo);
    }

    // Recorded against the administrator who did it; the failed attempts stay
    // in the audit log exactly as they were.
    await clearLockout(user.username, req.session.user.id);
    await recordAdminAction({
      adminUserId: actingAdminId(req), targetUserId: user.id, action: 'unlock',
      detail: `${user.username} was let back in after failed sign-ins`,
    });
    flashAndRedirect(req, res, { kind: 'success', text: `${user.username} can sign in again.` }, returnTo);
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
    await recordAdminAction({
      adminUserId: actingAdminId(req), targetUserId: user.id, action: 'status-change',
      detail: `${user.username}: ${user.status} to ${draft.status}`,
    });
    flashAndRedirect(req, res, { kind: 'success', text: `Status for ${user.username} changed to ${draft.status}.` }, draft.returnTo);
  } catch (err) { next(err); }
});

// ---- Changing a role (sprint 9) -------------------------------------------
//
// Same shape as the status change above: the intended change is held in the
// session with a one-time id, a confirmation page lists exactly what it will
// remove, and only a submit that echoes the id writes anything.
//
// Two changes are refused outright. An administrator cannot change their own
// role, because the page that would change it back is behind the admin guard;
// and the last active administrator cannot be demoted, because an
// installation with no administrator has no way back in at all.

function roleDraftFor(req) {
  const draft = req.session.roleChange;
  return draft && draft.userId === req.targetUser.id ? draft : null;
}

// Why this role change is refused, or null when it may go ahead.
async function roleChangeRefusal(req, user, role) {
  if (user.id === req.session.user.id) {
    return 'You cannot change your own role. Ask another administrator to do it.';
  }
  if (user.role === 'admin' && role !== 'admin' && user.status === 'active' && (await countActiveAdmins()) <= 1) {
    return `${user.username} is the only administrator who can sign in, so their role cannot be changed. Make another account an administrator first.`;
  }
  return null;
}

router.post('/manage-users/:userId/role', async (req, res, next) => {
  const user = req.targetUser;
  const role = read(req, 'role');
  const returnTo = returnPathFor(req);
  // A stale draft must never survive a new request for the same account.
  delete req.session.roleChange;
  if (!VALID_ROLES.includes(role)) return res.status(400).send('Choose a role: driver, sponsor, or admin.');
  try {
    const refusal = await roleChangeRefusal(req, user, role);
    if (refusal) return flashAndRedirect(req, res, { kind: 'error', text: refusal }, returnTo);
    if (role === user.role) {
      return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, ${user.username} is already a ${role}.` }, returnTo);
    }
    req.session.roleChange = { userId: user.id, role, returnTo, confirmId: randomBytes(32).toString('hex') };
    res.redirect(303, `/admin/manage-users/${user.id}/role/confirm`);
  } catch (err) { next(err); }
});

router.get('/manage-users/:userId/role/confirm', async (req, res, next) => {
  const draft = roleDraftFor(req);
  if (!draft) return res.redirect('/admin/manage-users');
  try {
    // Counted now rather than when the draft was made, so the page lists what
    // would go if it were confirmed at this moment.
    const impact = await roleChangeImpact(req.targetUser.id, draft.role);
    if (!impact) {
      delete req.session.roleChange;
      return flashAndRedirect(req, res, { kind: 'info', text: `No change needed, ${req.targetUser.username} is already a ${draft.role}.` }, draft.returnTo);
    }
    res.render('user-role-confirm', { user: req.targetUser, draft, impact, token: formToken(req) });
  } catch (err) { next(err); }
});

router.post('/manage-users/:userId/role/confirm', async (req, res, next) => {
  const user = req.targetUser;
  const draft = roleDraftFor(req);
  if (!draft || req.body.confirmId !== draft.confirmId) {
    return res.status(400).send('Confirm the role change before saving it.');
  }
  try {
    delete req.session.roleChange;
    // The account may have changed since the draft was made; both rules are
    // checked again before anything is written.
    const refusal = await roleChangeRefusal(req, user, draft.role);
    if (refusal) return flashAndRedirect(req, res, { kind: 'error', text: refusal }, draft.returnTo);

    const result = await changeUserRole(user.id, draft.role);
    if (!result.changed) {
      return flashAndRedirect(req, res, {
        kind: 'info',
        text: result.reason === 'missing' ? 'That account no longer exists.' : `No change needed, ${user.username} is already a ${draft.role}.`,
      }, draft.returnTo);
    }

    // What actually went, in the same words the confirmation used.
    const removed = Object.entries(result.removed).filter(([, count]) => count > 0)
      .map(([key, count]) => `${count} ${key}`);
    await recordAdminAction({
      adminUserId: actingAdminId(req), targetUserId: user.id, action: 'role-change',
      detail: `${user.username}: ${result.from} to ${result.to}` + (removed.length ? `; removed ${removed.join(', ')}` : '; nothing to remove'),
    });

    // The old role is in their session, and so is anything it let them see.
    // Signing the account out everywhere is what makes the change take hold
    // on whatever device they are already using.
    await revokeSessions(user.id);
    flashAndRedirect(req, res, {
      kind: 'success',
      text: `${user.username} is now a ${result.to}. They were signed out everywhere, so the new role applies the next time they sign in.`,
    }, draft.returnTo);
  } catch (err) { next(err); }
});

// ---- Driver sponsorships (RC#2) --------------------------------------------

// Every sponsor a driver belongs to, with the balance for each; add one or
// remove one and leave the rest in place. Removal is confirmed first.

async function renderDriverSponsors(req, res, { error = null, status = 200 } = {}) {
  const user = req.targetUser;
  const [memberships, sponsors] = await Promise.all([listDriverSponsors(user.id), listSponsors()]);
  const memberIds = new Set(memberships.map(m => m.id));
  res.status(status).render('driver-sponsors', {
    user, memberships, notice: takeNotice(req), error, token: formToken(req),
    available: sponsors.filter(s => !memberIds.has(s.id)),
    draft: req.session.sponsorRemoval && req.session.sponsorRemoval.userId === user.id ? req.session.sponsorRemoval : null,
  });
}

function requireDriver(req, res, next) {
  if (req.targetUser.role !== 'driver') return res.status(400).send('Only driver accounts have sponsors.');
  next();
}

router.get('/manage-users/:userId/sponsors', requireDriver, async (req, res, next) => {
  try { await renderDriverSponsors(req, res); } catch (err) { next(err); }
});

router.post('/manage-users/:userId/sponsors', requireDriver, async (req, res, next) => {
  const user = req.targetUser;
  const sponsorId = /^[1-9]\d*$/.test(read(req, 'sponsor')) ? Number(read(req, 'sponsor')) : null;
  const back = `/admin/manage-users/${user.id}/sponsors`;
  if (!sponsorId) return flashAndRedirect(req, res, { kind: 'error', text: 'Choose a sponsor from the list.' }, back);
  try {
    const sponsor = (await listSponsors()).find(s => s.id === sponsorId);
    if (!sponsor) return flashAndRedirect(req, res, { kind: 'error', text: 'Choose a sponsor from the list.' }, back);
    await addDriverSponsor(user.id, sponsorId);
    await recordAdminAction({
      adminUserId: actingAdminId(req), targetUserId: user.id, action: 'sponsorship-added',
      detail: `${user.username} was added to ${sponsor.name}`,
    });
    flashAndRedirect(req, res, { kind: 'success', text: `${user.username} now belongs to ${sponsor.name}.` }, back);
  } catch (err) {
    if (err instanceof MembershipError) return flashAndRedirect(req, res, { kind: 'error', text: err.message }, back);
    next(err);
  }
});

// Step 1: ask. The pending removal is held in the session with a one-time id.
router.post('/manage-users/:userId/sponsors/:sponsorId/remove', requireDriver, async (req, res, next) => {
  const user = req.targetUser;
  const back = `/admin/manage-users/${user.id}/sponsors`;
  try {
    const membership = (await listDriverSponsors(user.id)).find(m => String(m.id) === req.params.sponsorId);
    delete req.session.sponsorRemoval;
    if (!membership) return flashAndRedirect(req, res, { kind: 'info', text: 'That sponsorship is no longer on this driver.' }, back);
    req.session.sponsorRemoval = { userId: user.id, sponsorId: membership.id, sponsorName: membership.name, balance: Number(membership.balance), confirmId: randomBytes(32).toString('hex') };
    res.redirect(303, back);
  } catch (err) { next(err); }
});

// Step 2: confirmed removal, echoing the one-time id.
router.post('/manage-users/:userId/sponsors/:sponsorId/remove/confirm', requireDriver, async (req, res, next) => {
  const user = req.targetUser;
  const back = `/admin/manage-users/${user.id}/sponsors`;
  const draft = req.session.sponsorRemoval;
  if (!draft || draft.userId !== user.id || String(draft.sponsorId) !== req.params.sponsorId || req.body.confirmId !== draft.confirmId) {
    return res.status(400).send('Confirm the removal before saving it.');
  }
  try {
    delete req.session.sponsorRemoval;
    const removed = await removeDriverSponsor(user.id, draft.sponsorId);
    if (removed) {
      await recordAdminAction({
        adminUserId: actingAdminId(req), targetUserId: user.id, action: 'sponsorship-removed',
        detail: `${user.username} was removed from ${draft.sponsorName}, losing ${Number(draft.balance).toLocaleString('en-US')} point${Number(draft.balance) === 1 ? '' : 's'} held there`,
      });
    }
    flashAndRedirect(req, res, removed
      ? { kind: 'success', text: `Removed ${user.username} from ${draft.sponsorName}. Other sponsorships were left in place.` }
      : { kind: 'info', text: 'That sponsorship was already gone.' }, back);
  } catch (err) { next(err); }
});

router.post('/manage-users/:userId/sponsors/cancel', requireDriver, (req, res) => {
  delete req.session.sponsorRemoval;
  res.redirect(303, `/admin/manage-users/${req.targetUser.id}/sponsors`);
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
    historyLimit: PASSWORD_HISTORY_LIMIT,
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
    try {
      await updateUserPassword(user.id, newPassword, {
        method: 'admin-reset',
        changedBy: req.session.impersonator ? req.session.impersonator.id : req.session.user.id,
      });
    } catch (err) {
      // Stories 22232 (AA-29) and 28211 (AA-79): the store refuses a password
      // the account has had recently, and refuses it before it touches
      // anything, so there is nothing to undo here. The wording is the
      // admin's: it is not their password.
      if (!(err instanceof SamePasswordError)) throw err;
      const failedLogins = await countRecentFailedLogins(user.username);
      return renderResetPassword(req, res, {
        from, failedLogins, status: 400,
        error: `${user.username} has used that password before. Choose one they have not had recently.`,
      });
    }

    // Backlog AA-14: the account being reset is signed out everywhere. An
    // admin resetting their own password keeps the session they are using.
    const cutoffMs = await revokeSessions(user.id);
    if (req.session.user.id === user.id) req.session.issuedAt = cutoffMs + 1;

    // The password itself is already recorded in password_changes; this is the
    // administrator-facing log, which holds no hash either.
    await recordAdminAction({
      adminUserId: actingAdminId(req), targetUserId: user.id, action: 'password-reset',
      detail: `${user.username}'s password was reset and their other sessions were signed out`,
    });

    flashAndRedirect(req, res, { kind: 'success', text: `Password for ${user.username} was reset. Their other sessions were signed out.` }, STATUS_PAGES[from]);
  } catch (err) { next(err); }
});

// Story 22255 follow-up: a setup link expires after SETUP_LINK_HOURS, so an
// admin can issue a replacement. Only for accounts that have never completed
// setup; an account with a password of its own gets a reset instead.
router.post('/manage-users/:userId/setup-link', async (req, res, next) => {
  try {
    // router.param above has already validated the id and loaded the account,
    // and the router requires a form token on every POST.
    const user = req.targetUser;

    // Re-checked here rather than trusting the button that was rendered.
    const awaiting = await userIdsAwaitingSetup();
    if (!awaiting.includes(user.id)) {
      return flashAndRedirect(req, res, {
        kind: 'error',
        text: `${user.username} has already set a password. Use Reset instead.`,
      });
    }

    // The replacement is the only link that works from now on.
    await invalidateSetupTokens(user.id);
    const rawToken = await issueSetupToken(user.id);
    const setupLink = setupLinkFor(req, rawToken);
    await sendMail({
      to: user.email || '(no email on file)',
      subject: 'Set up your Good Driver Incentive Program account',
      text:
        `Hi ${user.name || user.username},\n\n` +
        `Here is a new link to choose your password. It works once, and expires in ${linkLifetimeHours()} hours:\n\n` +
        `  ${setupLink}\n\n` +
        'Any earlier link for your account has stopped working.',
    });

    flashAndRedirect(req, res, {
      kind: 'success',
      text: `New setup link for ${user.username}. Any earlier link has stopped working.`,
      link: setupLink,
    });
  } catch (err) { next(err); }
});

module.exports = router;
