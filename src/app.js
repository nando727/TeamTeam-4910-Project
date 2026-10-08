require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./auth/routes');
const { sessionTimeout } = require('./auth/session-timeout');
const { rememberAndRedirect } = require('./auth/return-to');
const { denyAccess } = require('./auth/deny');
const apiRoutes = require('./routes/api');
const sponsorRoutes = require('./sponsors/routes');
const driverRoutes = require('./driver/routes');
const reportRoutes = require('./reports/routes');
const accountRoutes = require('./account/routes');
const adminRoutes = require('./admin/routes');
const setupRoutes = require('./setup/routes');
const { formToken, requireFormToken } = require('./auth/form-token');
const { listApplicationsForSponsor, setApplicationStatus, VALID_STATUSES} = require('./applications');
const db = require('./db');

const { createUser, DuplicateError } = require('./users/store');
const { issueSetupToken, setupLinkFor, linkLifetimeHours } = require('./auth/setup-tokens');
const { sendMail } = require('./mail/mailer');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('./auth/password-policy');
const { randomBytes } = require('crypto');

const app = express();

// Behind Elastic Beanstalk's reverse proxy the real client protocol and address
// arrive in X-Forwarded-* headers; trust one hop so req.protocol, req.ip, and
// the links built from them are right.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Course spec allows plain HTTP, so `secure` stays off.
    },
  })
);

// Story 22204: expire idle sessions before anything else reads req.session.user.
app.use(sessionTimeout);

// Template-only locals for the shared header and nav (partials/head.ejs).
app.use((req, res, next) => {
  //debug line to try and find log out bug
  console.log('sessionID:', req.sessionID, 'user:', req.session.user);
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  // While an admin acts as another user, every page shows a banner with a stop button.
  res.locals.currentImpersonator = req.session.impersonator || null;
  res.locals.impersonationToken = req.session.impersonator ? formToken(req) : null;
  next();
});

app.use(authRoutes);
app.use(apiRoutes);
app.use('/sponsors', sponsorRoutes);
app.use('/driver', driverRoutes);
app.use('/reports', reportRoutes);
app.use(accountRoutes);
app.use('/admin', adminRoutes);
// Story 22255: claiming a new account. No login required; the link is the credential.
app.use(setupRoutes);

function requireLogin(req, res, next) {
  // Story 22208: remember where they were headed before sending them to log in.
  if (!req.session.user) return rememberAndRedirect(req, res);
  next();
}

// Story 22200: each role lands on its own homepage view.
const HOME_VIEWS = { driver: 'driver/home', sponsor: 'sponsor/home', admin: 'admin/home' };


function requireSponsor(req, res, next) {
  if (req.session.user.role !== 'sponsor') return denyAccess(req, res, { needs: 'sponsor' });
  next();
}

app.get('/', requireLogin, async (req, res, next) => {
  const view = HOME_VIEWS[req.session.user.role];
  if (!view) return denyAccess(req, res, { detail: 'Your account has no home page yet. An administrator needs to set its role.' });

  const locals = { user: req.session.user };
  if (req.session.user.role === 'sponsor') {
    const StatusFilter = VALID_STATUSES.includes(req.query.status) ? req.query.status : null;
    const searchFilter = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 128) : '';
    try {
      locals.applications = await listApplicationsForSponsor(req.session.user.sponsorId, {
        status: StatusFilter,
        search: searchFilter || null,
      });
      locals.formToken = formToken(req);
      locals.StatusFilter = StatusFilter;
      locals.searchFilter = searchFilter;
    } catch (err) {
      return next(err);
    }
  }
  res.render(view, locals);
});

app.post('/applications/:id/approve', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  try {
    const ok = await setApplicationStatus(req.params.id, 'approved', req.session.user.sponsorId);
    if (!ok) return res.status(404).send('Application not found.');
    res.redirect('/');
  } catch (err) {
    if (err.code === 'DRIVER_ALREADY_SPONSORED') return res.status(409).send(err.message);
    next(err);
  }
});

app.post('/applications/:id/reject', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const reason = (req.body.rejectionReason || '').trim().slice(0, 2000) || null;
  if (!reason) {
    return res.status(400).send('A rejection reason is required.');
  }
  try {
    const ok = await setApplicationStatus(req.params.id, 'rejected', req.session.user.sponsorId, reason);
    if (!ok) return res.status(404).send('Application not found.');
    res.redirect('/');
  } catch (err) { next(err); }
});

app.get('/organization', requireLogin, requireSponsor, async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT id, name, contact_email, contact_phone, address, status FROM sponsors WHERE id = ?',
      [req.session.user.sponsorId]
    );
    const organization = rows[0];
    if (!organization) return res.status(404).send('Organization not found.');
    res.render('sponsor/organization', { organization });
  } catch (err) { next(err); }
});

function renderOrganizationEdit(req, res, organization, values, error = null, status = 200) {
  return res.status(status).render('sponsor/organization-edit', {
    organization, values, error, formToken: formToken(req),
  });
}

app.get('/organization/edit', requireLogin, requireSponsor, async (req, res, next) => {
  try {
    const rows = await db.query(
      'SELECT id, name, contact_email, contact_phone, address, status FROM sponsors WHERE id = ?',
      [req.session.user.sponsorId]
    );
    const organization = rows[0];
    if (!organization) return res.status(404).send('Organization not found.');
    renderOrganizationEdit(req, res, organization, {
      name: organization.name,
      contact_email: organization.contact_email,
      contact_phone: organization.contact_phone || '',
      address: organization.address,
    });
  } catch (err) { next(err); }
});

app.post('/organization/edit', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const read = (key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');
  const values = {
    name: read('name'),
    contact_email: read('contact_email'),
    contact_phone: read('contact_phone'),
    address: read('address'),
  };

  let organization;
  try {
    const rows = await db.query(
      'SELECT id, name, contact_email, contact_phone, address, status FROM sponsors WHERE id = ?',
      [req.session.user.sponsorId]
    );
    organization = rows[0];
    if (!organization) return res.status(404).send('Organization not found.');
  } catch (err) { return next(err); }

  if (
    !values.name || values.name.length > 255 ||
    !values.contact_email || values.contact_email.length > 255 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email) ||
    values.contact_phone.length > 32 ||
    !values.address || values.address.length > 255
  ) {
    return renderOrganizationEdit(req, res, organization, values,
      'Enter a name, a valid contact email, and an address (phone is optional).', 400);
  }

  try {
    await db.query(
      'UPDATE sponsors SET name = ?, contact_email = ?, contact_phone = ?, address = ? WHERE id = ?',
      [values.name, values.contact_email, values.contact_phone || null, values.address, req.session.user.sponsorId]
    );
    res.redirect('/organization');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return renderOrganizationEdit(req, res, organization, values,
        'That contact email is already in use by another organization.', 409);
    }
    next(err);
  }
});


const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_SPONSOR_USER = { name: '', email: '', username: '' };

function renderCreateSponsorUser(req, res, values, { error = null, created = null, setupLink = null, status = 200 } = {}) {
  return res.status(status).render('sponsor/create-user', {
    values, error, created, setupLink, token: formToken(req),
    rules: PUBLIC_RULES, maxLength: MAX_PASSWORD_LENGTH,
  });
}

app.get('/sponsor-users/create', requireLogin, requireSponsor, (req, res) => {
  renderCreateSponsorUser(req, res, EMPTY_SPONSOR_USER);
});

app.post('/sponsor-users/create', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const read = (key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');
  const values = { name: read('name'), email: read('email'), username: read('username') };
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const problems = [];
  if (!values.name || values.name.length > 255) problems.push('Enter a name (up to 255 characters).');
  if (!values.email || values.email.length > 255 || !EMAIL_PATTERN.test(values.email)) problems.push('Enter a valid email address.');
  if (!values.username || values.username.length > 64) problems.push('Enter a username (up to 64 characters).');
  if (password) problems.push(...passwordProblems(password));
  if (problems.length) return renderCreateSponsorUser(req, res, values, { error: problems.join(' '), status: 400 });

  try {
    const usesSetupLink = password.length === 0;
    const created = await createUser({
      ...values,
      role: 'sponsor',
      sponsorId: req.session.user.sponsorId, // ⚠️ depends on createUser's actual signature — see users/store.js
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
          `An account has been created for you as a sponsor user at your organization.`,
          'Choose your password using the link below:',
          '',
          setupLink,
          '',
          `The link works once and expires in ${linkLifetimeHours()} hours.`,
        ].join('\n'),
      });
    }

    renderCreateSponsorUser(req, res, EMPTY_SPONSOR_USER, { created, setupLink });
  } catch (err) {
    if (err instanceof DuplicateError) return renderCreateSponsorUser(req, res, values, { error: err.message, status: 409 });
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

module.exports = { app, requireLogin };
