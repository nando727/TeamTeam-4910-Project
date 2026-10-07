const express = require('express');
const db = require('../db');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { listPointChanges } = require('../reports/store');
const router = express.Router();

router.get('/programs', async (req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  try {
    const programs = await db.query(
      'SELECT s.id, s.name, s.status, ds.point_balance FROM driver_sponsors ds ' +
        'JOIN sponsors s ON s.id = ds.sponsor_id ' +
        'JOIN sponsor_applications a ON a.driver_id = ds.driver_id AND a.sponsor_id = ds.sponsor_id ' +
        "WHERE ds.driver_id = ? AND a.status = 'approved' ORDER BY s.name",
      [req.session.user.id]
    );
    res.render('driver/programs', { programs });
  } catch (err) { next(err); }
});

router.get('/points/history', async (req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  try {
    // Use the signed-in driver only. No date or sponsor filter: include all
    // recorded history, even if the driver no longer has that membership.
    const rows = await listPointChanges({ driverId: req.session.user.id });
    res.render('driver/point-history', {
      rows,
      formatStamp: value => new Date(value).toISOString().slice(0, 19).replace('T', ' '),
    });
  } catch (err) { next(err); }
});

module.exports = router;
