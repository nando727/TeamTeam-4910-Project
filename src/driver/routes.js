const express = require('express');
const db = require('../db');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { listPointChanges } = require('../reports/store');
const catalogStore = require('../catalog/store');
const provider = require('../fakestore/client');
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

router.get('/catalog', async (req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  try {
    const selections = await catalogStore.listCatalogForDriver(req.session.user.id);
    const available = selections.length ? await provider.listProducts({ allowStale: false }) : [];
    const availableIds = new Set(available.map(product => product.productId));
    const products = selections.filter(product => availableIds.has(product.product_id));
    const catalogs = [];
    for (const product of products) {
      let catalog = catalogs.find(item => item.sponsorId === product.sponsorId);
      if (!catalog) {
        catalog = { sponsorId: product.sponsorId, sponsorName: product.sponsorName, products: [] };
        catalogs.push(catalog);
      }
      catalog.products.push(product);
    }
    res.render('driver/catalog', { catalogs });
  } catch (err) {
    if (err instanceof provider.FakeStoreError) return res.status(err.status).render('driver/catalog-error', { message: err.message });
    next(err);
  }
});

router.get('/catalog/:sponsorId/:productId', async (req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  if (![req.params.sponsorId, req.params.productId].every(id => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)))) return res.sendStatus(404);
  try {
    const selections = await catalogStore.listCatalogForDriver(req.session.user.id);
    const product = selections.find(item => String(item.sponsorId) === req.params.sponsorId && String(item.id) === req.params.productId);
    if (!product) return res.sendStatus(404);
    const current = await provider.getProduct(Number(product.product_id), { allowStale: false });
    res.render('driver/product', { product: { ...product, description: current.description } });
  } catch (err) {
    if (err instanceof provider.FakeStoreError) return res.status(err.status).render('driver/catalog-error', { message: err.message });
    next(err);
  }
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
