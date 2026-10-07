const express = require('express');
const db = require('../db');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
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

module.exports = router;
