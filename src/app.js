require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./auth/routes');
const { sessionTimeout } = require('./auth/session-timeout');
const { rememberAndRedirect } = require('./auth/return-to');
const apiRoutes = require('./routes/api');
const sponsorRoutes = require('./sponsors/routes');
const accountRoutes = require('./account/routes');
const adminRoutes = require('./admin/routes');
const setupRoutes = require('./setup/routes');
const { formToken, requireFormToken } = require('./auth/form-token');
const { listApplicationsForSponsor, setApplicationStatus, VALID_STATUSES} = require('./applications');
const db = require('./db');

const app = express();

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
  if (req.session.user.role !== 'sponsor') return res.status(403).send('Sponsors only.');
  next();
}

app.get('/', requireLogin, async (req, res, next) => {
  const view = HOME_VIEWS[req.session.user.role];
  if (!view) return res.status(403).send('Your account has no homepage. Contact an admin.');

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
  } catch (err) { next(err); }
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

module.exports = { app, requireLogin };
