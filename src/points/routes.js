const express = require('express');
const db = require('../db');
const { adjustPoints } = require('./store');
const { removeDriverSponsor } = require('../memberships/store');
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
    const preferences = await db.query('SELECT point_alerts_enabled FROM driver_alert_preferences WHERE driver_id = ?', [req.session.user.id]);
    const enabled = !preferences.length || Boolean(preferences[0].point_alerts_enabled);
    const alerts = enabled ? await db.query(
      'SELECT t.id, t.points_change, t.reason, t.created_at, s.name AS sponsor_name ' +
      'FROM point_alerts a JOIN point_transactions t ON t.id = a.transaction_id ' +
      'JOIN sponsors s ON s.id = t.sponsor_id WHERE t.driver_id = ? AND a.dismissed_at IS NULL ORDER BY t.id DESC',
      [req.session.user.id]
    ) : [];
    const removals = await db.query('SELECT id, sponsor_name, created_at FROM sponsor_removal_alerts WHERE driver_id = ? AND acknowledged_at IS NULL ORDER BY id DESC', [req.session.user.id]);
    res.set('Cache-Control', 'no-store');
    res.render('driver/point-alerts', { alerts, removals, token: formToken(req) });
  } catch (error) { next(error); }
});

router.get('/drivers/:id/remove', role('sponsor'), async (req, res, next) => {
  try {
    if (!req.session.user.sponsorId) return res.status(404).send('Driver not found in your organization.');
    const drivers = await listDriversInScope({ sponsorId: req.session.user.sponsorId });
    const driver = drivers.find(driver => String(driver.id) === req.params.id);
    if (!driver) return res.status(404).send('Driver not found in your organization.');
    res.render('sponsor/remove-driver', { driver, token: formToken(req) });
  } catch (error) { next(error); }
});

router.post('/drivers/:id/remove', role('sponsor'), requireFormToken, async (req, res, next) => {
  const driverId = Number(req.params.id);
  if (!Number.isInteger(driverId) || driverId <= 0 || !req.session.user.sponsorId) return res.status(404).send('Driver not found in your organization.');
  if (req.body.confirm !== 'remove') return res.status(400).send('Confirm the removal before saving it.');
  try {
    const removed = await removeDriverSponsor(driverId, req.session.user.sponsorId);
    if (!removed) return res.status(404).send('Driver not found in your organization.');
    req.session.pointMessage = 'Driver removed from your organization. A sponsor-removal alert was saved for the driver.';
    res.redirect('/points');
  } catch (error) { next(error); }
});

router.get('/settings', role('driver'), async (req, res, next) => {
  try {
    const preferences = await db.query('SELECT point_alerts_enabled FROM driver_alert_preferences WHERE driver_id = ?', [req.session.user.id]);
    res.render('driver/alert-settings', { enabled: !preferences.length || Boolean(preferences[0].point_alerts_enabled), token: formToken(req) });
  } catch (error) { next(error); }
});

router.post('/settings', role('driver'), requireFormToken, async (req, res, next) => {
  if (!['0', '1'].includes(req.body.enabled)) return res.status(400).send('Choose enable or disable.');
  try {
    await db.query('INSERT INTO driver_alert_preferences (driver_id, point_alerts_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE point_alerts_enabled = ?',
      [req.session.user.id, Number(req.body.enabled), Number(req.body.enabled)]);
    res.redirect('/points/settings');
  } catch (error) { next(error); }
});

router.post('/removal-alerts/:id/acknowledge', role('driver'), requireFormToken, async (req, res, next) => {
  try {
    await db.query('UPDATE sponsor_removal_alerts SET acknowledged_at = CURRENT_TIMESTAMP WHERE id = ? AND driver_id = ?', [req.params.id, req.session.user.id]);
    res.redirect('/');
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
