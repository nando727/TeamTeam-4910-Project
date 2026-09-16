const express = require('express');
const { randomBytes } = require('crypto');
const db = require('../db');
const router = express.Router();

router.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'driver') return res.status(403).send('Only drivers can apply to join a sponsor.');
  if (!req.session.applicationToken) req.session.applicationToken = randomBytes(32).toString('hex');
  if (req.method === 'POST' && req.body.token !== req.session.applicationToken) {
    return res.status(403).send('Invalid application form. Reload the sponsor page and try again.');
  }
  next();
});

router.get('/', async (req, res, next) => {
  try {
    const sponsors = await db.query(
      'SELECT s.id, s.name, a.id AS application_id FROM sponsors s ' +
        'LEFT JOIN sponsor_applications a ON a.sponsor_id = s.id AND a.driver_id = ? ORDER BY s.name',
      [req.session.user.id]
    );
    const success = req.session.applicationSuccess || null;
    delete req.session.applicationSuccess;
    res.render('sponsors', { sponsors, error: null, success });
  } catch (err) { next(err); }
});

router.param('id', async (req, res, next, id) => {
  try {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return res.status(400).send('Please select a valid sponsor.');
    const sponsors = await db.query('SELECT id, name FROM sponsors WHERE id = ?', [Number(id)]);
    if (!sponsors.length) return res.status(404).send('This sponsor is no longer available.');
    req.sponsor = sponsors[0];
    next();
  } catch (err) { next(err); }
});

function draftFor(req) {
  const draft = req.session.applicationDraft;
  return draft && draft.sponsorId === req.sponsor.id ? draft : null;
}
function renderForm(req, res, values, error = null, status = 200) {
  return res.status(status).render('application', {
    sponsor: req.sponsor, values, error, token: req.session.applicationToken,
  });
}
router.get('/:id/apply', (req, res) => {
  renderForm(req, res, draftFor(req) || { fullName: '', contactEmail: '', reason: '' });
});
router.post('/:id/review', (req, res) => {
  const read = key => typeof req.body[key] === 'string' ? req.body[key].trim() : '';
  const values = { fullName: read('fullName'), contactEmail: read('contactEmail'), reason: read('reason') };
  // An edited application must be reviewed again, including in other open tabs.
  delete req.session.applicationDraft;
  if (!values.fullName || values.fullName.length > 128 ||
      values.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail) ||
      !values.reason || values.reason.length > 2000) {
    return renderForm(req, res, values,
      'Enter your full name (up to 128 characters), a valid contact email (up to 254 characters), and a reason (up to 2000 characters).', 400);
  }
  req.session.applicationDraft = { ...values, sponsorId: req.sponsor.id, reviewId: randomBytes(32).toString('hex') };
  res.redirect(303, `/sponsors/${req.sponsor.id}/review`);
});
router.get('/:id/review', (req, res) => {
  const draft = draftFor(req);
  if (!draft) return res.redirect(`/sponsors/${req.sponsor.id}/apply`);
  res.render('application-review', { sponsor: req.sponsor, draft, token: req.session.applicationToken });
});
router.post('/:id/apply', async (req, res, next) => {
  const draft = draftFor(req);
  if (!draft || req.body.reviewId !== draft.reviewId) {
    return res.status(400).send('Complete and review your application before submitting it.');
  }
  try {
    // Save reviewed session data, never replacement fields from the submit request.
    await db.query(
      'INSERT INTO sponsor_applications (driver_id, sponsor_id, full_name, contact_email, reason) VALUES (?, ?, ?, ?, ?)',
      [req.session.user.id, req.sponsor.id, draft.fullName, draft.contactEmail, draft.reason]
    );
    delete req.session.applicationDraft;
    req.session.applicationSuccess = `Your application to ${req.sponsor.name} was submitted.`;
    res.redirect(303, '/sponsors');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderForm(req, res, draft, 'You have already applied to this sponsor.', 409);
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return renderForm(req, res, draft, 'This sponsor is no longer available.', 404);
    next(err);
  }
});
module.exports = router;
