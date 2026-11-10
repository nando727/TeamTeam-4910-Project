require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./auth/routes');
const { sessionTimeout, idleLimitMs, warningLeadMs, remainingMs } = require('./auth/session-timeout');
const { sessionRevocation } = require('./auth/session-revocation');
const { MysqlSessionStore } = require('./auth/session-store');
const { rememberAndRedirect } = require('./auth/return-to');
const { denyAccess } = require('./auth/deny');
const apiRoutes = require('./routes/api');
const sponsorRoutes = require('./sponsors/routes');
const driverRoutes = require('./driver/routes');
const reportRoutes = require('./reports/routes');
const accountRoutes = require('./account/routes');
const adminRoutes = require('./admin/routes');
const bulkUploadRoutes = require('./bulk/admin-routes');
const setupRoutes = require('./setup/routes');
const { healthCheck } = require('./health');
const { formToken, requireFormToken } = require('./auth/form-token');
const { listApplicationsForSponsor, setApplicationStatus, VALID_STATUSES, escapeLike} = require('./applications');
const db = require('./db');

const { createUser,updateUserContact, updateUserStatus, DuplicateError } = require('./users/store');
const { issueSetupToken, setupLinkFor, linkLifetimeHours } = require('./auth/setup-tokens');
const { listDriversForSponsor, listSponsorAccounts, findOrgMember, deleteOrgMember } = require('./sponsors/accounts');
const { sendMail } = require('./mail/mailer');
const { setupMailNotice } = require('./mail/outcome');
const { adjustPoints } = require('./points/store');
const { securityHeaders } = require('./security-headers');
const { PUBLIC_RULES, MAX_PASSWORD_LENGTH, passwordProblems } = require('./auth/password-policy');
const { randomBytes } = require('crypto');

const { searchProducts, getProduct, listCategories, FakeStoreError } = require('./fakestore/client');
const catalog = require('./catalog/store');

const app = express();

// Behind Elastic Beanstalk's reverse proxy the real client protocol and address
// arrive in X-Forwarded-* headers; trust one hop so req.protocol, req.ip, and
// the links built from them are right.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Story AA-74: on every response, including /health and the files in public/,
// so there is no page of ours that can be framed or asked to run a script.
app.use(securityHeaders);

// Story INF-10: public, and ahead of sessions so it needs no cookie.
app.get('/health', healthCheck);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Story AA-71: sessions are kept in MySQL, so restarting the server for a
// deployment no longer signs everyone out and a second instance would see the
// same sessions as the first. SESSION_STORE=memory asks for express-session's
// in-process store instead, which is what the tests use (tests/setup.js): no
// database to stand up and nothing left behind.
const sessionStore = process.env.SESSION_STORE === 'memory' ? undefined : new MysqlSessionStore();

app.use(
  session({
    store: sessionStore,
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

// Backlog AA-13: and refuse sessions the account has signed out everywhere.
app.use(sessionRevocation);

// Template-only locals for the shared header and nav (partials/head.ejs).
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  // Story AA-12: the browser needs these to warn before the session expires.
  res.locals.sessionRemainingMs = req.session.user ? remainingMs(req) : 0;
  res.locals.sessionWarningMs = warningLeadMs();
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
app.use('/points', require('./points/routes'));
app.use('/reports', reportRoutes);
app.use(accountRoutes);
// Mounted before the admin router: the upload is multipart and streamed.
app.use('/admin/bulk-upload', bulkUploadRoutes);
app.use('/admin', adminRoutes);
// Story 22255: claiming a new account. No login required; the link is the credential.
app.use(setupRoutes);

// Story AA-12: "Stay signed in" posts here. Reaching this point means the
// session was still valid, and the timeout middleware has just refreshed it.
app.post('/session/keep-alive', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Your session has already expired.' });
  }
  res.json({ remainingMs: idleLimitMs(), warningMs: warningLeadMs() });
});

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

    const rules = await db.query(
      'SELECT id, title, description FROM rules WHERE sponsor_id = ? ORDER BY id DESC',
      [req.session.user.sponsorId]
    );

    res.render('sponsor/organization', { organization, rules, formToken: formToken(req) });
  } catch (err) { next(err); }
});


const parseBalance = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function flash(req, kind, text) {
  req.session.accountNotice = { kind, text };
}

async function loadOrgMember(req, res, next) {
  try {
    const id = req.params.userId;
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return res.status(400).send('Please select a valid account.');
    const member = await findOrgMember(req.session.user.sponsorId, Number(id));
    if (!member) return res.status(404).send('Account not found in your organization.');
    req.member = member;
    next();
  } catch (err) { next(err); }
}

function requireDriverMember(req, res, next) {
  if (req.member.role !== 'driver') return res.status(404).send('Driver not found in your organization.');
  next();
}

app.get('/drivers', requireLogin, requireSponsor, async (req, res, next) => {
  const nameFilter = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 128) : '';
  const minBalance = parseBalance(req.query.minBalance);
  const maxBalance = parseBalance(req.query.maxBalance);
  try {
    const sponsorId = req.session.user.sponsorId;
    const [drivers, sponsorAccounts] = await Promise.all([
      listDriversForSponsor(sponsorId, { name: nameFilter || null, minBalance, maxBalance }),
      listSponsorAccounts(sponsorId),
    ]);
    const notice = req.session.accountNotice || null;
    delete req.session.accountNotice;
    res.render('sponsor/drivers', {
      drivers, sponsorAccounts, nameFilter,
      minBalance: minBalance ?? '', maxBalance: maxBalance ?? '',
      notice, formToken: formToken(req), currentUserId: req.session.user.id,
    });
  } catch (err) { next(err); }
});


function renderDriverEdit(req, res, values, error = null, status = 200) {
  return res.status(status).render('sponsor/driver-edit', {
    driver: req.member, values, error, formToken: formToken(req),
  });
}

app.get('/drivers/:userId/edit', requireLogin, requireSponsor, loadOrgMember, requireDriverMember, (req, res) => {
  renderDriverEdit(req, res, { name: req.member.name || '', email: req.member.email || '' });
});

app.post('/drivers/:userId/edit', requireLogin, requireSponsor, requireFormToken, loadOrgMember, requireDriverMember, async (req, res, next) => {
  const read = (key) => (typeof req.body[key] === 'string' ? req.body[key].trim() : '');
  const values = { name: read('name'), email: read('email') };
  if (!values.name || values.name.length > 255 ||
      !values.email || values.email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return renderDriverEdit(req, res, values, 'Enter a name and a valid email address.', 400);
  }
  try {
    await updateUserContact(req.member.id, values);
    flash(req, 'success', `Updated ${req.member.username}.`);
    res.redirect(303, '/drivers');
  } catch (err) {
    if (err instanceof DuplicateError) return renderDriverEdit(req, res, values, err.message, 409);
    next(err);
  }
});


app.post('/drivers/:userId/status', requireLogin, requireSponsor, requireFormToken, loadOrgMember, requireDriverMember, async (req, res, next) => {
  const status = req.body.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).send('Choose active or disabled.');
  if (req.member.status === 'revoked') {
    flash(req, 'error', 'That account was revoked by an administrator and cannot be changed here.');
    return res.redirect(303, '/drivers');
  }
  try {
    if (status !== req.member.status) await updateUserStatus(req.member.id, status);
    flash(req, 'success', `${req.member.username} is now ${status}.`);
    res.redirect(303, '/drivers');
  } catch (err) { next(err); }
});


app.post('/accounts/:userId/delete', requireLogin, requireSponsor, requireFormToken, loadOrgMember, async (req, res, next) => {
  if (req.member.id === req.session.user.id) {
    flash(req, 'error', 'You cannot delete your own account.');
    return res.redirect(303, '/drivers');
  }
  try {
    const ok = await deleteOrgMember(req.session.user.sponsorId, req.member.id);
    if (!ok) return res.status(404).send('Account not found in your organization.');
    flash(req, 'success', `Deleted ${req.member.username}.`);
    res.redirect(303, '/drivers');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      flash(req, 'error', 'This account still has linked records and could not be deleted. Deactivate it instead.');
      return res.redirect(303, '/drivers');
    }
    next(err);
  }
});

app.post('/organization/rules', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const pointValue = (req.body.pointValue || '').trim();

  if (!title || title.length > 255) {
    return res.status(400).send('Enter a title (up to 255 characters).');
  }
  if (!pointValue || pointValue.length > 255){
    return res.status(400).send('Enter a valid point amount.');
  }
  if (!description || description.length > 2000) {
    return res.status(400).send('Enter a description (up to 2000 characters).');
  }

  try {
    await db.query(
      'INSERT INTO rules (sponsor_id, title, points, description) VALUES (?, ?, ?, ?)',
      [req.session.user.sponsorId, title, pointValue, description]
    );
    res.redirect('/organization');
  } catch (err) { next(err); }
});

app.post('/organization/rules/:id/delete', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM rules WHERE id = ? AND sponsor_id = ?',
      [req.params.id, req.session.user.sponsorId]
    );
    if (result.affectedRows === 0) return res.status(404).send('Rule not found.');
    res.redirect('/organization');
  } catch (err) { next(err); }
});

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

app.get('/catalog', requireLogin, requireSponsor, async (req, res, next) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 100) : '';
  try {
    const sponsorId = req.session.user.sponsorId;
    const [items, savedIds] = await Promise.all([catalog.listCatalog(sponsorId), catalog.savedProductIds(sponsorId)]);
    let products = [], categories = [], browseError = null;
    try {
      [products, categories] = await Promise.all([searchProducts({ q, category }), listCategories()]);
    } catch (err) {
      if (err instanceof FakeStoreError) browseError = err.message; else throw err;
    }
    const notice = req.session.accountNotice || null;
    delete req.session.accountNotice;
    res.render('sponsor/catalog', { items, savedIds, products, categories, q, category, browseError, notice, formToken: formToken(req) });
  } catch (err) { next(err); }
});

app.post('/catalog/add', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const q = typeof req.body.q === 'string' ? req.body.q.trim().slice(0, 100) : '';
  const category = typeof req.body.category === 'string' ? req.body.category.trim().slice(0, 100) : '';
  const back = '/catalog?' + new URLSearchParams({ q, category }).toString();
  const rawId = typeof req.body.productId === 'string' ? req.body.productId : '';
  const pointsCost = Number(req.body.pointsCost);
  if (!/^[1-9]\d{0,9}$/.test(rawId)) return res.status(400).send('Invalid product.');
  if (!Number.isInteger(pointsCost) || pointsCost < 1 || pointsCost > 1000000) {
    flash(req, 'error', 'Enter a whole number of points from 1 to 1,000,000.');
    return res.redirect(303, back);
  }
  try {
    // Title, price and image come from the product service, not from the form.
    const product = await getProduct(Number(rawId));
    await catalog.addCatalogItem(req.session.user.sponsorId, product, pointsCost);
    flash(req, 'success', `Added "${product.title}" to your catalog.`);
    res.redirect(303, back);
  } catch (err) {
    if (err instanceof FakeStoreError) { flash(req, 'error', err.message); return res.redirect(303, back); }
    if (err.code === 'ER_DUP_ENTRY') { flash(req, 'error', 'That item is already in your catalog.'); return res.redirect(303, back); }
    next(err);
  }
});

app.post('/catalog/:id/remove', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  try {
    const ok = await catalog.removeCatalogItem(req.session.user.sponsorId, req.params.id);
    flash(req, ok ? 'success' : 'error', ok ? 'Item removed.' : 'Item not found.');
    res.redirect(303, '/catalog');
  } catch (err) { next(err); }
});

// ---- Sponsor buys from the catalog for one of their drivers (sprint 8) -------
// The sponsor picks a driver, reviews the cost against that driver's balance
// with this sponsor, then confirms. The points are spent through adjustPoints,
// which also writes the purchases row the reports read, all in one
// transaction. The review is held in the session with a one-time id, so a
// confirmation cannot be forged or replayed.

const points = n => `${Number(n).toLocaleString('en-US')} point${Number(n) === 1 ? '' : 's'}`;

function shortfallMessage(driver, organization, balance, cost) {
  const short = cost - balance;
  return `${driver.displayName} has ${points(balance)} with ${organization}. This item costs ${points(cost)}, ` +
    `so they need ${short.toLocaleString('en-US')} more point${short === 1 ? '' : 's'}.`;
}

async function loadPurchase(req) {
  const sponsorId = req.session.user.sponsorId;
  if (!sponsorId || !/^[1-9]\d{0,9}$/.test(req.params.id)) return null;
  const item = await catalog.findCatalogItem(sponsorId, Number(req.params.id));
  if (!item) return null;
  const [drivers, organization] = await Promise.all([catalog.listDriversForPurchase(sponsorId), catalog.sponsorName(sponsorId)]);
  return { sponsorId, item, drivers, organization };
}

function renderPurchase(req, res, context, { driver = null, review = null, problem = null, status = 200 } = {}) {
  res.status(status).render('sponsor/buy', {
    ...context, driver, review, problem, points, formToken: formToken(req),
  });
}

app.get('/catalog/:id/buy', requireLogin, requireSponsor, async (req, res, next) => {
  try {
    const context = await loadPurchase(req);
    if (!context) { flash(req, 'error', 'That item is not in your catalog.'); return res.redirect('/catalog'); }
    const wanted = typeof req.query.driver === 'string' ? req.query.driver.trim() : '';
    if (!wanted) return renderPurchase(req, res, context);
    const driver = context.drivers.find(d => String(d.id) === wanted);
    if (!driver) return renderPurchase(req, res, context, { problem: 'Choose one of your drivers from the list.', status: 400 });
    const balance = Number(driver.balance);
    const cost = context.item.points_cost;
    if (balance < cost) {
      return renderPurchase(req, res, context, { driver, problem: shortfallMessage(driver, context.organization, balance, cost), status: 409 });
    }
    const confirmId = randomBytes(32).toString('hex');
    req.session.purchaseDraft = { itemId: context.item.id, driverId: driver.id, pointsCost: cost, confirmId };
    renderPurchase(req, res, context, { driver, review: { balance, after: balance - cost, confirmId } });
  } catch (err) { next(err); }
});

app.post('/catalog/:id/buy', requireLogin, requireSponsor, requireFormToken, async (req, res, next) => {
  const draft = req.session.purchaseDraft;
  // Used once, whatever happens next: a second click finds nothing to confirm.
  delete req.session.purchaseDraft;
  try {
    if (!draft || String(draft.itemId) !== req.params.id || String(draft.driverId) !== req.body.driver || draft.confirmId !== req.body.confirmId) {
      flash(req, 'error', 'That purchase was not confirmed, or it has already been made. Review it again before buying.');
      return res.redirect(303, '/catalog');
    }
    const context = await loadPurchase(req);
    if (!context) { flash(req, 'error', 'That item is no longer in your catalog, so nothing was bought.'); return res.redirect(303, '/catalog'); }
    const { item, organization } = context;
    if (item.points_cost !== draft.pointsCost) {
      flash(req, 'error', `The points cost of "${item.title}" changed, so nothing was bought. Review the purchase again.`);
      return res.redirect(303, '/catalog');
    }
    const driver = context.drivers.find(d => d.id === draft.driverId);
    if (!driver) { flash(req, 'error', 'That driver is no longer one of your active drivers, so nothing was bought.'); return res.redirect(303, '/catalog'); }

    const title = item.title.trim().slice(0, 255);
    let balance;
    try {
      balance = await adjustPoints({
        driverId: driver.id, sponsorId: context.sponsorId, userId: req.session.user.id,
        amount: -item.points_cost, reason: `Catalog purchase: ${title}`.slice(0, 255),
        purchase: { description: title, amountCents: Math.round(Number(item.price_value) * 100) },
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_POINTS') {
        return renderPurchase(req, res, context, { driver, problem: shortfallMessage(driver, organization, err.balance, err.cost), status: 409 });
      }
      if (err.status) { flash(req, 'error', err.message); return res.redirect(303, '/catalog'); }
      throw err;
    }
    flash(req, 'success', `Bought "${title}" for ${driver.displayName} for ${points(item.points_cost)}. ` +
      `Their balance with ${organization} is now ${points(balance)}.`);
    res.redirect(303, '/catalog');
  } catch (err) { next(err); }
});

app.get('/my-catalog', requireLogin, (req, res) => {
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  res.redirect('/driver/catalog');
});




const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_SPONSOR_USER = { name: '', email: '', username: '' };

function renderCreateSponsorUser(req, res, values, { error = null, created = null, setupLink = null, mailNotice = null, status = 200 } = {}) {
  return res.status(status).render('sponsor/create-user', {
    values, error, created, setupLink, mailNotice, token: formToken(req),
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
      sponsorId: req.session.user.sponsorId, 
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
          `An account has been created for you as a sponsor user at your organization.`,
          'Choose your password using the link below:',
          '',
          setupLink,
          '',
          `The link works once and expires in ${linkLifetimeHours()} hours.`,
        ].join('\n'),
      });
      mailNotice = setupMailNotice(mail);
    }

    renderCreateSponsorUser(req, res, EMPTY_SPONSOR_USER, { created, setupLink, mailNotice });
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
