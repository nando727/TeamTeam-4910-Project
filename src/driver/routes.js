const express = require('express');
const { randomBytes } = require('crypto');
const db = require('../db');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { formToken, requireFormToken } = require('../auth/form-token');
const { listPointChanges, salesDetail, countSales, salesTotals, SALES_SORT_COLUMNS, SORT_DIRECTIONS } = require('../reports/store');
const {
  isoDate, positiveInt, text, formatStamp, dollars, queryString, readDateRange, rangeLabel, datesSummary, quickRangeLinks, sendCsv,
} = require('../reports/helpers');
const catalogStore = require('../catalog/store');
const provider = require('../products/provider');
const { availability, currentProduct } = require('../products/availability');
const { purchaseCart } = require('../points/store');
const { findUserById } = require('../users/store');
const { sendPurchaseConfirmation } = require('../mail/purchase-notice');
const { withFreshSession } = require('./cart-session');
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
    const byId = new Map(available.map(product => [product.productId, product]));
    const products = selections.filter(product => byId.has(product.product_id) && availability(byId.get(product.product_id)) !== 'unavailable')
      .map(product => ({ ...product, availability: availability(byId.get(product.product_id)) }));
    const catalogs = [];
    for (const product of products) {
      let catalog = catalogs.find(item => item.sponsorId === product.sponsorId);
      if (!catalog) {
        catalog = { sponsorId: product.sponsorId, sponsorName: product.sponsorName, products: [] };
        catalogs.push(catalog);
      }
      catalog.products.push(product);
    }
    res.render('driver/catalog', { catalogs, token: formToken(req), notice: takeCartNotice(req), points });
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
    const current = await currentProduct(product.product_id);
    res.render('driver/product', { product: { ...product, description: current.description, availability: availability(current) }, token: formToken(req), notice: takeCartNotice(req), points, maxQuantity: CART_MAX_QUANTITY });
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

// ---- Cart and checkout (sprint 9) -----------------------------------------
// The cart lives in the session, which is itself kept in the database, so it
// survives a deployment and ends with the session. It holds items from one
// sponsor only, because points never mix between sponsors: an item from a
// second sponsor can only replace the cart, never join it. Nothing about an
// item is trusted from the session beyond its id and quantity; the title,
// price and points cost are re-read from the sponsor's catalog on every page,
// and once more under lock at checkout.

const CART_MAX_LINES = 20;
const CART_MAX_QUANTITY = 10;

const points = n => `${Number(n).toLocaleString('en-US')} point${Number(n) === 1 ? '' : 's'}`;

function requireDriver(req, res, next) {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'driver') return denyAccess(req, res, { needs: 'driver' });
  next();
}

function cartOf(req) {
  const cart = req.session.cart;
  return cart && Number.isInteger(cart.sponsorId) && Array.isArray(cart.items) ? cart : null;
}
// A notice may carry a link, so a message shown on the catalog can offer the
// way to the cart without the driver hunting for it in the header.
function flashCart(req, kind, text, link = null) { req.session.cartNotice = { kind, text, link }; }
function takeCartNotice(req) {
  const notice = req.session.cartNotice || null;
  delete req.session.cartNotice;
  return notice;
}
const readInt = (value, max) => {
  const n = positiveInt(typeof value === 'string' ? value.trim() : '');
  return n && n <= max ? n : null;
};

// The cart with every line filled in from the catalog as it is right now.
// Lines whose item has gone from the catalog, and a cart whose membership has
// ended, are dropped here, with a notice saying so.
async function loadCart(req) {
  const cart = cartOf(req);
  if (!cart || !cart.items.length) return { cart: null, lines: [], total: 0, balance: null, sponsorName: null, dropped: 0 };
  const member = await catalogStore.driverBalance(req.session.user.id, cart.sponsorId);
  if (!member) {
    delete req.session.cart;
    return { cart: null, lines: [], total: 0, balance: null, sponsorName: null, dropped: cart.items.length, membershipEnded: true };
  }
  const items = await catalogStore.findDriverCatalogItems(req.session.user.id, cart.sponsorId, cart.items.map(line => line.id));
  const lines = [];
  for (const line of cart.items) {
    const item = items.find(i => i.id === line.id);
    if (item) lines.push({ ...item, quantity: line.quantity, lineTotal: item.points_cost * line.quantity });
  }
  const dropped = cart.items.length - lines.length;
  if (dropped) cart.items = lines.map(line => ({ id: line.id, quantity: line.quantity }));
  if (!lines.length) delete req.session.cart;
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  return { cart: lines.length ? cart : null, lines, total, balance: member.balance, sponsorName: member.sponsorName, dropped };
}

function droppedNotice(loaded) {
  if (loaded.membershipEnded) return { kind: 'error', text: 'You no longer belong to that sponsor, so your cart was emptied.' };
  if (loaded.dropped) return { kind: 'info', text: `${loaded.dropped} item${loaded.dropped === 1 ? ' is' : 's are'} no longer in the catalog and ${loaded.dropped === 1 ? 'was' : 'were'} removed from your cart.` };
  return null;
}

// Where an add came from, so the driver is put back there instead of being
// thrown out of the catalog. Only this app's own cart and catalog pages are
// accepted, so the field cannot become an open redirect.
const BACK_PATTERN = /^\/driver\/(cart|catalog(\/[1-9]\d{0,9}\/[1-9]\d{0,9})?)$/;
const backFrom = req => (typeof req.body.back === 'string' && BACK_PATTERN.test(req.body.back) ? req.body.back : '/driver/catalog');

const CART_LINK = { href: '/driver/cart', text: 'View your cart' };

router.post('/cart/add', requireDriver, requireFormToken, async (req, res, next) => {
  const itemId = readInt(req.body.itemId, 2147483647);
  const sponsorId = readInt(req.body.sponsorId, 2147483647);
  const quantity = readInt(req.body.quantity || '1', CART_MAX_QUANTITY);
  // Adding never navigates away from the page the driver was reading. Being
  // sent to the cart on every click meant losing your place in a catalog of
  // two hundred products to add a second one.
  const back = backFrom(req);
  if (!itemId || !sponsorId || !quantity) {
    flashCart(req, 'error', `Choose an item and a quantity from 1 to ${CART_MAX_QUANTITY}.`);
    return res.redirect(303, back);
  }
  try {
    const [item] = await catalogStore.findDriverCatalogItems(req.session.user.id, sponsorId, [itemId]);
    if (!item) {
      flashCart(req, 'error', 'That item is not in a catalog you can buy from.');
      return res.redirect(303, back);
    }

    if (availability(await currentProduct(item.product_id)) !== 'available') {
      flashCart(req, 'error', 'This offer is unavailable or its availability could not be confirmed. It was not added to your cart.');
      return res.redirect(303, back);
    }

    // The other sponsor's name, looked up ahead of the mutation because the
    // mutation itself must stay synchronous (see src/driver/cart-session.js).
    // Only a label: whether there really is a conflict is decided afresh.
    let currentSponsorName = null;
    const peek = cartOf(req);
    if (peek && peek.items.length && peek.sponsorId !== sponsorId && req.body.replace !== '1') {
      const current = await catalogStore.driverBalance(req.session.user.id, peek.sponsorId);
      currentSponsorName = current ? current.sponsorName : null;
    }

    // The decision and the write happen against the session as it is stored
    // right now, not as it was when this request began -- an add that raced a
    // slower request used to be overwritten by it. See cart-session.js.
    const result = await withFreshSession(req, session => {
      let cart = session.cart && Number.isInteger(session.cart.sponsorId) && Array.isArray(session.cart.items) ? session.cart : null;
      if (cart && cart.items.length && cart.sponsorId !== sponsorId) {
        if (req.body.replace !== '1') {
          // Points never mix between sponsors: ask before throwing the cart
          // away. This is the one add that does go to the cart, because the
          // question can only be answered there.
          session.cartConflict = {
            itemId, sponsorId, quantity, title: item.title, sponsorName: item.sponsorName,
            currentSponsorName: currentSponsorName || 'another sponsor', back,
          };
          return { outcome: 'conflict' };
        }
        cart = null;
      }
      delete session.cartConflict;
      if (!cart) cart = { sponsorId, items: [] };
      const line = cart.items.find(l => l.id === itemId);
      let capped = false;
      if (line) {
        const wanted = line.quantity + quantity;
        capped = wanted > CART_MAX_QUANTITY;
        line.quantity = Math.min(CART_MAX_QUANTITY, wanted);
      } else if (cart.items.length >= CART_MAX_LINES) {
        return { outcome: 'full' };
      } else {
        cart.items.push({ id: itemId, quantity });
      }
      session.cart = cart;
      return { outcome: capped ? 'capped' : 'added', held: cart.items.find(l => l.id === itemId).quantity, lines: cart.items.length };
    });

    if (result.outcome === 'conflict') return res.redirect(303, '/driver/cart');
    if (result.outcome === 'full') {
      flashCart(req, 'error', `Your cart can hold ${CART_MAX_LINES} different items. Remove one before adding another.`, CART_LINK);
      return res.redirect(303, back);
    }

    // What the cart holds now, so the driver can keep shopping without
    // opening it to find out what just happened.
    const summary = `Your cart has ${result.lines} item${result.lines === 1 ? '' : 's'} from ${item.sponsorName}.`;
    if (result.outcome === 'capped') {
      // Silently rounding the number down is how a driver ends up with a
      // quantity they did not ask for and cannot explain.
      flashCart(req, 'info', `You can have at most ${CART_MAX_QUANTITY} of one item, so "${item.title}" stays at ${CART_MAX_QUANTITY}. ${summary}`, CART_LINK);
    } else {
      flashCart(req, 'success', `Added "${item.title}"${result.held > 1 ? `, and you now have ${result.held}` : ''}. ${summary}`, CART_LINK);
    }
    res.redirect(303, back);
  } catch (err) { next(err); }
});

router.get('/cart', requireDriver, async (req, res, next) => {
  try {
    const loaded = await loadCart(req);
    // The question is asked once. Left unanswered it used to sit in the
    // session and reappear days later, offering to replace the cart with an
    // item the driver had long forgotten choosing.
    const conflict = req.session.cartConflict || null;
    delete req.session.cartConflict;
    // A line that vanished matters more than "added to your cart", and the
    // flash is spent either way so it cannot turn up on a later page.
    const flash = takeCartNotice(req);
    res.render('driver/cart', {
      ...loaded, conflict, notice: droppedNotice(loaded) || flash, token: formToken(req), points, dollars,
      maxQuantity: CART_MAX_QUANTITY, shortfall: loaded.cart && loaded.balance < loaded.total ? loaded.total - loaded.balance : 0,
    });
  } catch (err) { next(err); }
});

router.post('/cart/update', requireDriver, requireFormToken, async (req, res, next) => {
  const itemId = readInt(req.body.itemId, 2147483647);
  const quantity = typeof req.body.quantity === 'string' && /^\d{1,2}$/.test(req.body.quantity.trim()) ? Number(req.body.quantity) : null;
  if (!cartOf(req) || !itemId || quantity === null || quantity > CART_MAX_QUANTITY) {
    flashCart(req, 'error', `Choose a quantity from 0 to ${CART_MAX_QUANTITY}.`);
    return res.redirect(303, '/driver/cart');
  }
  try {
    await withFreshSession(req, session => {
      const cart = session.cart;
      if (!cart || !Array.isArray(cart.items)) return;
      cart.items = quantity === 0 ? cart.items.filter(l => l.id !== itemId) : cart.items.map(l => (l.id === itemId ? { ...l, quantity } : l));
      if (!cart.items.length) delete session.cart;
    });
    res.redirect(303, '/driver/cart');
  } catch (err) { next(err); }
});

router.post('/cart/remove', requireDriver, requireFormToken, async (req, res, next) => {
  const itemId = readInt(req.body.itemId, 2147483647);
  try {
    if (itemId) {
      await withFreshSession(req, session => {
        const cart = session.cart;
        if (!cart || !Array.isArray(cart.items)) return;
        cart.items = cart.items.filter(l => l.id !== itemId);
        if (!cart.items.length) delete session.cart;
      });
    }
    res.redirect(303, '/driver/cart');
  } catch (err) { next(err); }
});

router.post('/cart/clear', requireDriver, requireFormToken, async (req, res, next) => {
  try {
    await withFreshSession(req, session => {
      delete session.cart;
      delete session.cartConflict;
      delete session.cartConfirm;
    });
    res.redirect(303, '/driver/cart');
  } catch (err) { next(err); }
});

router.post('/cart/conflict/keep', requireDriver, requireFormToken, async (req, res, next) => {
  try {
    await withFreshSession(req, session => { delete session.cartConflict; });
    res.redirect(303, '/driver/cart');
  } catch (err) { next(err); }
});

// Step 1 of checkout: review. What is being bought, at what price, is pinned
// in the session with a one-time id; the confirmation must echo the id and
// the cart must still match, or nothing is bought.
router.get('/cart/checkout', requireDriver, async (req, res, next) => {
  try {
    const loaded = await loadCart(req);
    delete req.session.cartConfirm;
    if (!loaded.cart) {
      flashCart(req, 'info', 'Your cart is empty.');
      return res.redirect('/driver/cart');
    }
    const offers = await Promise.all(loaded.lines.map(line => currentProduct(line.product_id)));
    if (offers.some(offer => availability(offer) !== 'available')) {
      flashCart(req, 'error', 'An offer is unavailable or its availability cannot be confirmed. Nothing was bought.');
      return res.redirect('/driver/cart');
    }
    if (loaded.balance < loaded.total) {
      flashCart(req, 'error', `You have ${points(loaded.balance)} with ${loaded.sponsorName} and this cart costs ${points(loaded.total)}. Remove something to check out.`);
      return res.redirect('/driver/cart');
    }
    const confirmId = randomBytes(32).toString('hex');
    req.session.cartConfirm = {
      confirmId, sponsorId: loaded.cart.sponsorId, total: loaded.total,
      lines: loaded.lines.map(line => ({ id: line.id, quantity: line.quantity, pointsCost: line.points_cost })),
    };
    res.render('driver/checkout', { ...loaded, confirmId, after: loaded.balance - loaded.total, token: formToken(req), points, dollars });
  } catch (err) { next(err); }
});

// Step 2: confirmed. The draft is spent before anything else happens, so a
// second click finds nothing to confirm, and the server's refusal of a replay
// does not depend on the button being disabled.
router.post('/cart/checkout', requireDriver, requireFormToken, async (req, res, next) => {
  try {
    // Spent against the stored session, so even two confirmations racing each
    // other cannot both come away holding the draft.
    const draft = await withFreshSession(req, session => {
      const pinned = session.cartConfirm;
      delete session.cartConfirm;
      return pinned;
    });
    const loaded = await loadCart(req);
    const same = draft && loaded.cart && draft.confirmId === req.body.confirmId && draft.sponsorId === loaded.cart.sponsorId &&
      draft.lines.length === loaded.lines.length &&
      draft.lines.every(d => loaded.lines.some(l => l.id === d.id && l.quantity === d.quantity && l.points_cost === d.pointsCost));
    if (!same) {
      flashCart(req, 'error', draft
        ? 'Your cart changed since you reviewed it, so nothing was bought. Review it again before checking out.'
        : 'That order was not confirmed, or it has already been placed. Nothing was bought.');
      return res.redirect(303, '/driver/cart');
    }
    let result;
    const offers = await Promise.all(loaded.lines.map(line => currentProduct(line.product_id)));
    if (offers.some(offer => availability(offer) !== 'available')) {
      flashCart(req, 'error', 'An offer is unavailable or its availability cannot be confirmed. Nothing was bought.');
      return res.redirect(303, '/driver/cart');
    }
    try {
      result = await purchaseCart({
        driverId: req.session.user.id, sponsorId: loaded.cart.sponsorId, userId: req.session.user.id,
        lines: loaded.lines.map(line => ({ title: line.title, pointsCost: line.points_cost, priceValue: line.price_value, quantity: line.quantity })),
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_POINTS') {
        flashCart(req, 'error', `You have ${points(err.balance)} with ${loaded.sponsorName} and this cart costs ${points(err.cost)}, so nothing was bought.`);
        return res.redirect(303, '/driver/cart');
      }
      if (err.status) { flashCart(req, 'error', `${err.message} Nothing was bought.`); return res.redirect(303, '/driver/cart'); }
      throw err;
    }
    delete req.session.cart;
    const order = {
      sponsorName: loaded.sponsorName, total: result.total, balance: result.balance,
      lines: loaded.lines.map(line => ({ title: line.title, quantity: line.quantity, pointsCost: line.points_cost, imageUrl: line.image_url })),
    };
    console.log(`[cart] ${req.session.user.username} (id ${req.session.user.id}) bought ${order.lines.length} line(s) for ${result.total} points with sponsor ${loaded.cart.sponsorId}`);
    // After the commit, and never able to undo it: see src/mail/purchase-notice.js.
    const driver = await findUserById(req.session.user.id);
    const mail = await sendPurchaseConfirmation({
      driver, sponsorName: order.sponsorName, lines: order.lines, total: order.total, balance: order.balance,
      orderLink: `${process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`}/driver/orders`,
    });
    order.emailedTo = mail && mail.delivered && mail.transport === 'smtp' ? mail.to : null;
    await withFreshSession(req, session => {
      delete session.cart;
      delete session.cartConflict;
      session.orderComplete = order;
    });
    res.redirect(303, '/driver/cart/complete');
  } catch (err) { next(err); }
});

router.get('/cart/complete', requireDriver, (req, res) => {
  const order = req.session.orderComplete || null;
  delete req.session.orderComplete;
  if (!order) return res.redirect('/driver/orders');
  res.render('driver/order-complete', { order, points });
});

// ---- Order history (sprint 9) ----------------------------------------------
// Everything the signed-in driver has bought, newest first, read from the
// same purchases rows and the same query as the admin's Sales by Driver
// report, pinned to this driver. The sponsor filter offers every sponsor the
// driver belongs to or has bought from.

const ORDER_SORT_LABELS = { date: 'date', sponsor: 'sponsor', item: 'item', amount: 'amount', points: 'points spent' };
const ORDER_COLUMNS = { date: 1, sponsor: 1, item: 1, amount: 1, points: 1 };
const ORDER_PAGE_SIZE = 25;

async function resolveOrderFilters(req) {
  const problems = [];
  const sponsors = await catalogStore.listSponsorsForDriverOrders(req.session.user.id);
  let sponsorId = null;
  const wanted = text(req.query.sponsor);
  if (wanted && wanted !== 'all') {
    sponsorId = positiveInt(wanted);
    if (!sponsorId || !sponsors.some(s => s.id === sponsorId)) { sponsorId = null; problems.push('Choose a sponsor from the list.'); }
  }
  const { from, to } = readDateRange(req.query, problems);
  const sort = Object.prototype.hasOwnProperty.call(ORDER_COLUMNS, text(req.query.sort)) ? text(req.query.sort) : 'date';
  const dir = SORT_DIRECTIONS.includes(text(req.query.dir)) ? text(req.query.dir) : (['date', 'amount', 'points'].includes(sort) ? 'desc' : 'asc');
  return { driverId: req.session.user.id, sponsors, sponsorId, from, to, sort, dir, problems };
}

router.get('/orders', requireDriver, async (req, res, next) => {
  try {
    const filters = await resolveOrderFilters(req);
    const invalid = filters.problems.length > 0;
    const total = invalid ? 0 : await countSales(filters);
    const pageCount = Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE));
    const page = Math.min(positiveInt(text(req.query.page)) || 1, pageCount);
    const rows = invalid ? [] : await salesDetail(filters, { sort: filters.sort, dir: filters.dir, limit: ORDER_PAGE_SIZE, offset: (page - 1) * ORDER_PAGE_SIZE });
    const grand = invalid ? { sales: 0, totalCents: 0, points: 0 } : await salesTotals(filters);

    const basePath = '/driver/orders';
    const keep = { sponsor: filters.sponsorId };
    const state = { ...keep, from: filters.from, to: filters.to, sort: filters.sort, dir: filters.dir };
    const quickRanges = quickRangeLinks(basePath, { ...keep, sort: filters.sort, dir: filters.dir }, filters, { thisMonth: true });
    const sortLinks = {};
    for (const key of Object.keys(ORDER_COLUMNS)) {
      const active = filters.sort === key;
      const dir = active ? (filters.dir === 'asc' ? 'desc' : 'asc') : (['date', 'amount', 'points'].includes(key) ? 'desc' : 'asc');
      sortLinks[key] = { href: `${basePath}${queryString({ ...state, sort: key, dir })}`, active, dir: filters.dir };
    }
    const pageHref = n => `${basePath}${queryString({ ...state, page: n > 1 ? n : null })}`;
    const chosenSponsor = filters.sponsorId ? filters.sponsors.find(s => s.id === filters.sponsorId) : null;
    const summary = [
      { label: 'Sponsor', value: chosenSponsor ? chosenSponsor.name : 'All sponsors' },
      { label: 'Dates', value: datesSummary(filters) },
      { label: 'Sorted by', value: `${ORDER_SORT_LABELS[filters.sort]}, ${filters.dir === 'asc' ? 'ascending' : 'descending'}` },
      { label: 'Orders', value: `${total.toLocaleString('en-US')} item${total === 1 ? '' : 's'}` },
    ];
    const range = rangeLabel(filters);
    const emptyMessage = {
      title: `No orders${chosenSponsor ? ` with ${chosenSponsor.name}` : ''}${range}.`,
      detail: `Nothing you bought${chosenSponsor ? ` with ${chosenSponsor.name}` : ''}${range || ' at any time'} matched these filters.`,
    };

    res.status(invalid ? 400 : 200).render('driver/orders', {
      filters, sponsors: filters.sponsors, chosenSponsor, error: invalid ? filters.problems.join(' ') : null, emptyMessage,
      rows, grand, total, today: isoDate(new Date()), quickRanges, sortLinks, summary, rangeLabel: range,
      page, pageCount, pageStart: total ? (page - 1) * ORDER_PAGE_SIZE + 1 : 0, pageEnd: Math.min(page * ORDER_PAGE_SIZE, total),
      prevHref: page > 1 ? pageHref(page - 1) : null, nextHref: page < pageCount ? pageHref(page + 1) : null,
      csvHref: `${basePath}.csv${queryString(state)}`, formatStamp, dollars, notice: takeCartNotice(req),
    });
  } catch (err) { next(err); }
});

router.get('/orders.csv', requireDriver, async (req, res, next) => {
  try {
    const filters = await resolveOrderFilters(req);
    if (filters.problems.length) return res.status(400).type('text/plain').send(filters.problems.join(' '));
    const rows = await salesDetail(filters, { sort: filters.sort, dir: filters.dir });
    const grand = await salesTotals(filters);
    const money = cents => +(Number(cents) / 100).toFixed(2);
    const span = `${filters.from ? `-from-${filters.from}` : ''}${filters.to ? `-to-${filters.to}` : ''}`;
    sendCsv(res, `my-orders${span}.csv`, [
      ['Date (UTC)', 'Sponsor', 'Item', 'Amount (USD)', 'Points spent'],
      ...rows.map(r => [formatStamp(r.purchasedAt), r.sponsorName, r.item, money(r.amountCents), Number(r.points)]),
      ['Total', '', `${Number(grand.sales)} items`, money(grand.totalCents), Number(grand.points)],
    ]);
  } catch (err) { next(err); }
});

module.exports = router;
