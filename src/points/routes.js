const express = require('express');
const db = require('../db');
const { adjustPoints } = require('./store');
const { listDriversInScope } = require('../reports/store');
const { formToken, requireFormToken } = require('../auth/form-token');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const router = express.Router();

function role(required) {
  return (req, res, next) => {
    if (!req.session.user) return rememberAndRedirect(req, res);
    if (req.session.user.role !== required) return denyAccess(req, res, { needs: required });
    next();
  };
}

router.get('/', role('sponsor'), async (req, res, next) => {
  try {
    const sponsorId = req.session.user.sponsorId;
    const drivers = sponsorId ? await listDriversInScope({ sponsorId }) : [];
    const message = req.session.pointMessage || null;
    delete req.session.pointMessage;
    res.render('sponsor/points', { drivers, message, token: formToken(req) });
  } catch (error) { next(error); }
});

router.post('/', role('sponsor'), requireFormToken, async (req, res, next) => {
  try {
    const driverId = Number(req.body.driverId);
    if (!Number.isInteger(driverId) || driverId <= 0 || !req.session.user.sponsorId) {
      return res.status(400).send('Select a driver in your organization.');
    }
    const balance = await adjustPoints({ driverId, sponsorId: req.session.user.sponsorId,
      userId: req.session.user.id, amount: Number(req.body.amount), reason: req.body.reason });
    req.session.pointMessage = `Point adjustment saved. Current balance: ${balance} points.`;
    res.redirect('/points');
  } catch (error) {
    if (error.status) return res.status(error.status).send(error.message);
    next(error);
  }
});

router.get('/alerts', role('driver'), async (req, res, next) => {
  try {
    const alerts = await db.query(
      'SELECT t.id, t.points_change, t.reason, t.created_at, s.name AS sponsor_name ' +
      'FROM point_alerts a JOIN point_transactions t ON t.id = a.transaction_id ' +
      'JOIN sponsors s ON s.id = t.sponsor_id WHERE t.driver_id = ? AND a.dismissed_at IS NULL ORDER BY t.id DESC',
      [req.session.user.id]
    );
    res.set('Cache-Control', 'no-store');
    res.render('driver/point-alerts', { alerts, token: formToken(req) });
  } catch (error) { next(error); }
});

router.post('/alerts/:id/dismiss', role('driver'), requireFormToken, async (req, res, next) => {
  try {
    await db.query('UPDATE point_alerts a JOIN point_transactions t ON t.id = a.transaction_id ' +
      'SET a.dismissed_at = CURRENT_TIMESTAMP WHERE t.id = ? AND t.driver_id = ?',
    [req.params.id, req.session.user.id]);
    res.redirect('/');
  } catch (error) { next(error); }
});

module.exports = router;
