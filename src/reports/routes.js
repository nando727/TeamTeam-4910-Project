const express = require('express');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { listSponsors } = require('../sponsors/store');
const {
  SORT_COLUMNS, SORT_DIRECTIONS, SALES_SORT_COLUMNS, SALES_VERSIONS,
  listDriversInScope, listPointChanges, countPointChanges, dailyPointTotals,
  monthlySponsorPurchases, listPurchaseMonths,
  salesSummary, countSponsorsInScope, salesDetail, countSales, salesTotals,
} = require('./store');
const {
  DAY_MS, isoDate, positiveInt, text, formatStamp, dollars, queryString,
  readDateRange, rangeLabel, datesSummary, quickRangeLinks, sendCsv,
} = require('./helpers');

const router = express.Router();

// Stories AD-18 to AD-24, AD-59 to AD-62: the Driver Point Tracking report, for
// sponsors and admins. A sponsor is pinned to their own organization by the
// session; an admin sees everyone and may narrow to one sponsor.
// Story AD-11: the admin-only monthly sponsor fee report.
const REPORT_ROLES = ['sponsor', 'admin'];
const PAGE_SIZE = 25;
const FEE_RATE = 0.01;

router.use((req, res, next) => {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (!REPORT_ROLES.includes(req.session.user.role)) {
    return denyAccess(req, res, { needs: REPORT_ROLES });
  }
  if (req.session.user.role === 'sponsor' && !req.session.user.sponsorId) {
    return denyAccess(req, res, {
      detail: 'Your account is not linked to a sponsor organization yet, so there are no drivers to report on. An administrator can link it.',
    });
  }
  next();
});

// Reads the filters from the query string and checks each one. The sponsor
// scope never comes from the form.
async function resolveFilters(req) {
  const me = req.session.user;
  const problems = [];

  let sponsorId = null;
  if (me.role === 'sponsor') {
    sponsorId = me.sponsorId;
  } else {
    const wanted = text(req.query.sponsor);
    if (wanted && wanted !== 'all') {
      sponsorId = positiveInt(wanted);
      if (!sponsorId) problems.push('Choose a sponsor from the list.');
    }
  }

  const drivers = await listDriversInScope({ sponsorId });

  let driverId = null;
  const wantedDriver = text(req.query.driver);
  if (wantedDriver && wantedDriver !== 'all') {
    driverId = positiveInt(wantedDriver);
    if (!driverId || !drivers.some(driver => driver.id === driverId)) {
      driverId = null;
      problems.push('Choose a driver from the list.');
    }
  }

  const { from, to } = readDateRange(req.query, problems);

  // Sort: unknown keys fall back to the default rather than erroring, so an
  // old bookmark still works.
  const sort = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, text(req.query.sort)) ? text(req.query.sort) : 'date';
  const dir = SORT_DIRECTIONS.includes(text(req.query.dir)) ? text(req.query.dir) : (sort === 'date' ? 'desc' : 'asc');

  return { sponsorId, driverId, from, to, sort, dir, drivers, problems };
}

const SORT_LABELS = {
  date: 'date', driver: 'driver', change: 'point change', sponsor: 'sponsor', madeBy: 'who made it', reason: 'reason',
};

// ---- Chart (story AD-23) ----------------------------------------------------
// Builds everything the inline SVG needs: one bar per day (or per week when
// the range is long) of net change, and a running total line. Pure numbers, no
// library; the template only draws what it is handed.

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

function buildChart(daily, { from, to }) {
  if (!daily.length) return null;
  const start = from || daily[0].day;
  const end = to || daily[daily.length - 1].day;
  const spanDays = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1);
  const bucketDays = spanDays > 120 ? 7 : 1;
  const bucketCount = Math.ceil(spanDays / bucketDays);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: isoDate(new Date(Date.parse(start) + i * bucketDays * DAY_MS)), net: 0, awarded: 0, deducted: 0,
  }));
  for (const row of daily) {
    const index = Math.floor((Date.parse(row.day) - Date.parse(start)) / (bucketDays * DAY_MS));
    if (index < 0 || index >= bucketCount) continue;
    buckets[index].net += Number(row.net);
    buckets[index].awarded += Number(row.awarded);
    buckets[index].deducted += Number(row.deducted);
  }
  let running = 0;
  const cumulative = buckets.map(bucket => (running += bucket.net));

  const W = 760; const H = 240; const L = 48; const R = 12; const T = 14; const B = 32;
  const plotW = W - L - R; const plotH = H - T - B;
  const values = [0, ...buckets.map(b => b.net), ...cumulative];
  let lo = Math.min(...values); let hi = Math.max(...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  const yMin = Math.floor(lo / step) * step;
  const yMax = Math.ceil(hi / step) * step;
  const y = value => T + ((yMax - value) / (yMax - yMin)) * plotH;
  const slot = plotW / bucketCount;
  const barW = Math.max(2, Math.min(28, slot * 0.6));
  const zeroY = y(0);

  const bars = buckets.map((bucket, i) => ({
    x: +(L + i * slot + (slot - barW) / 2).toFixed(1), w: +barW.toFixed(1),
    y: +Math.min(zeroY, y(bucket.net)).toFixed(1), h: +Math.max(bucket.net === 0 ? 0 : 1, Math.abs(y(bucket.net) - zeroY)).toFixed(1),
    kind: bucket.net < 0 ? 'neg' : 'pos', net: bucket.net, awarded: bucket.awarded, deducted: bucket.deducted,
    label: bucketDays === 1 ? bucket.start : `week of ${bucket.start}`,
  }));
  const linePoints = buckets.map((bucket, i) => `${(L + i * slot + slot / 2).toFixed(1)},${y(cumulative[i]).toFixed(1)}`).join(' ');
  const ticks = [];
  for (let value = yMin; value <= yMax + 1e-9; value += step) ticks.push({ y: +y(value).toFixed(1), label: Math.round(value).toLocaleString('en-US') });
  const every = Math.max(1, Math.ceil(bucketCount / 6));
  const xLabels = buckets.map((bucket, i) => ({ x: +(L + i * slot + slot / 2).toFixed(1), label: bucket.start.slice(5) }))
    .filter((_, i) => i % every === 0 || i === bucketCount - 1);
  const totals = buckets.reduce((acc, b) => ({ awarded: acc.awarded + b.awarded, deducted: acc.deducted + b.deducted, net: acc.net + b.net }), { awarded: 0, deducted: 0, net: 0 });

  return { W, H, L, R, T, B, plotW, plotH, zeroY: +zeroY.toFixed(1), bars, linePoints, ticks, xLabels, bucketDays, start, end, totals, finalCumulative: running };
}

// ---- Driver Point Tracking ----------------------------------------------------

router.get('/points', async (req, res, next) => {
  try {
    const me = req.session.user;
    const filters = await resolveFilters(req);
    const isAdmin = me.role === 'admin';
    const sponsors = isAdmin ? await listSponsors() : [];
    const invalid = filters.problems.length > 0;

    // Pagination (story AD-60): the count and the page share the filter.
    const total = invalid ? 0 : await countPointChanges(filters);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(positiveInt(text(req.query.page)) || 1, pageCount);
    const rows = invalid ? [] : await listPointChanges(filters, {
      sort: filters.sort, dir: filters.dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    });
    const chart = invalid ? null : buildChart(await dailyPointTotals(filters), filters);
    const totals = filters.driverId ? filters.drivers.filter(d => d.id === filters.driverId) : filters.drivers;

    const today = isoDate(new Date());
    const keep = { sponsor: isAdmin ? filters.sponsorId : null, driver: filters.driverId };
    const state = { ...keep, from: filters.from, to: filters.to, sort: filters.sort, dir: filters.dir };
    const quickRanges = quickRangeLinks('/reports/points', { ...keep, sort: filters.sort, dir: filters.dir }, filters);

    // Story AD-59: clicking the active column flips direction; a new column
    // starts ascending (dates start newest first). Sorting returns to page 1.
    const sortLinks = {};
    for (const key of Object.keys(SORT_COLUMNS)) {
      const active = filters.sort === key;
      const dir = active ? (filters.dir === 'asc' ? 'desc' : 'asc') : (key === 'date' ? 'desc' : 'asc');
      sortLinks[key] = { href: `/reports/points${queryString({ ...state, sort: key, dir })}`, active, dir: filters.dir };
    }
    const pageHref = n => `/reports/points${queryString({ ...state, page: n > 1 ? n : null })}`;

    const scopeSponsor = filters.sponsorId
      ? (filters.drivers[0] && filters.drivers[0].sponsorName) ||
        (sponsors.find(s => s.id === filters.sponsorId) || {}).name || null
      : null;
    const chosenDriver = filters.driverId ? filters.drivers.find(d => d.id === filters.driverId) : null;

    // Story AD-62: the header states exactly what the report covers.
    const summary = [
      { label: 'Sponsor', value: scopeSponsor || 'All sponsors' },
      { label: 'Driver', value: chosenDriver ? chosenDriver.displayName : 'All drivers' },
      { label: 'Dates', value: datesSummary(filters) },
      { label: 'Sorted by', value: `${SORT_LABELS[filters.sort]}, ${filters.dir === 'asc' ? 'ascending' : 'descending'}` },
      { label: 'Results', value: `${total.toLocaleString('en-US')} change${total === 1 ? '' : 's'}` },
    ];

    res.status(invalid ? 400 : 200).render('reports/points', {
      isAdmin, sponsors, drivers: filters.drivers, filters,
      error: invalid ? filters.problems.join(' ') : null,
      rows, totals, total, today, quickRanges, sortLinks, summary, chart, scopeSponsor,
      rangeLabel: rangeLabel(filters),
      page, pageCount, pageSize: PAGE_SIZE,
      pageStart: total ? (page - 1) * PAGE_SIZE + 1 : 0, pageEnd: Math.min(page * PAGE_SIZE, total),
      prevHref: page > 1 ? pageHref(page - 1) : null, nextHref: page < pageCount ? pageHref(page + 1) : null,
      csvHref: `/reports/points.csv${queryString(state)}`,
      formatStamp,
    });
  } catch (err) { next(err); }
});

// Story AD-22: the same query, filters, and sort as the page, every row (no paging).
router.get('/points.csv', async (req, res, next) => {
  try {
    const filters = await resolveFilters(req);
    if (filters.problems.length) return res.status(400).type('text/plain').send(filters.problems.join(' '));
    const rows = await listPointChanges(filters, { sort: filters.sort, dir: filters.dir });
    const balances = new Map(filters.drivers.map(driver => [driver.id, Number(driver.balance)]));
    const lines = [
      ['Driver', 'Username', 'Current total points', 'Date (UTC)', 'Point change', 'Sponsor', 'Made by', 'Reason'],
      ...rows.map(row => [
        row.driverName, row.driverUsername, balances.get(row.driverId) ?? '', formatStamp(row.changedAt),
        Number(row.pointsChange), row.sponsorName, row.changedBy || 'system', row.reason,
      ]),
    ];
    sendCsv(res, `point-report${filters.from ? `-from-${filters.from}` : ''}${filters.to ? `-to-${filters.to}` : ''}.csv`, lines);
  } catch (err) { next(err); }
});

// ---- Sponsor fees (story AD-11, admin only) -------------------------------

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthLabel = month => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nextMonth = month => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

async function resolveFees(req) {
  const wanted = text(req.query.month);
  const month = MONTH_PATTERN.test(wanted) ? wanted : isoDate(new Date()).slice(0, 7);
  const problems = wanted && !MONTH_PATTERN.test(wanted) ? ['Choose a month as YYYY-MM.'] : [];
  const rows = problems.length ? [] : (await monthlySponsorPurchases(`${month}-01`, `${nextMonth(month)}-01`)).map(row => {
    const totalCents = Number(row.totalCents);
    // 1% of the month's purchases, rounded to the cent.
    const feeCents = Math.round(totalCents * FEE_RATE);
    return { ...row, purchases: Number(row.purchases), totalCents, feeCents };
  });
  const sum = rows.reduce((acc, r) => ({ purchases: acc.purchases + r.purchases, totalCents: acc.totalCents + r.totalCents, feeCents: acc.feeCents + r.feeCents }), { purchases: 0, totalCents: 0, feeCents: 0 });
  return { month, rows, sum, problems };
}

router.get('/fees', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') return denyAccess(req, res, { needs: 'admin' });
    const fees = await resolveFees(req);
    const months = await listPurchaseMonths();
    const thisMonth = isoDate(new Date()).slice(0, 7);
    if (!months.includes(thisMonth)) months.unshift(thisMonth);
    res.status(fees.problems.length ? 400 : 200).render('reports/fees', {
      ...fees,
      error: fees.problems.length ? fees.problems.join(' ') : null,
      monthLabel: monthLabel(fees.month),
      months: months.map(m => ({ value: m, label: monthLabel(m), active: m === fees.month })),
      feePercent: FEE_RATE * 100,
      csvHref: `/reports/fees.csv?month=${fees.month}`,
      dollars,
    });
  } catch (err) { next(err); }
});

router.get('/fees.csv', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') return denyAccess(req, res, { needs: 'admin' });
    const fees = await resolveFees(req);
    if (fees.problems.length) return res.status(400).type('text/plain').send(fees.problems.join(' '));
    const lines = [
      ['Month', 'Sponsor', 'Sponsor status', 'Purchases', 'Purchase total (USD)', `Fee at ${FEE_RATE * 100}% (USD)`],
      ...fees.rows.map(r => [fees.month, r.name, r.status, r.purchases, +(r.totalCents / 100).toFixed(2), +(r.feeCents / 100).toFixed(2)]),
      [fees.month, 'All sponsors', '', fees.sum.purchases, +(fees.sum.totalCents / 100).toFixed(2), +(fees.sum.feeCents / 100).toFixed(2)],
    ];
    sendCsv(res, `sponsor-fees-${fees.month}.csv`, lines);
  } catch (err) { next(err); }
});

// ---- Sales by Sponsor (stories AD-25 to AD-29, admin only) -------------------

const SALES_LABELS = {
  summary: { sponsor: 'sponsor', status: 'status', sales: 'number of sales', dollars: 'total dollars', points: 'points spent' },
  detailed: { date: 'date', sponsor: 'sponsor', driver: 'driver', item: 'item', amount: 'amount', points: 'points spent' },
};
const DESC_FIRST = ['date', 'dollars', 'sales', 'amount'];

async function resolveSalesFilters(req) {
  const problems = [];
  const sponsors = await listSponsors();
  let sponsorId = null;
  const wanted = text(req.query.sponsor);
  if (wanted && wanted !== 'all') {
    sponsorId = positiveInt(wanted);
    if (!sponsorId || !sponsors.some(s => s.id === sponsorId)) { sponsorId = null; problems.push('Choose a sponsor from the list.'); }
  }
  const { from, to } = readDateRange(req.query, problems);
  // Story AD-28: summary (one row per sponsor) or detailed (one row per purchase).
  const version = SALES_VERSIONS.includes(text(req.query.version)) ? text(req.query.version) : 'summary';
  const columns = SALES_SORT_COLUMNS[version];
  const defaultSort = version === 'summary' ? 'sponsor' : 'date';
  const sort = Object.prototype.hasOwnProperty.call(columns, text(req.query.sort)) ? text(req.query.sort) : defaultSort;
  const dir = SORT_DIRECTIONS.includes(text(req.query.dir)) ? text(req.query.dir) : (DESC_FIRST.includes(sort) ? 'desc' : 'asc');
  return { sponsors, sponsorId, from, to, version, sort, dir, problems };
}

router.get('/sales', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') return denyAccess(req, res, { needs: 'admin' });
    const filters = await resolveSalesFilters(req);
    const invalid = filters.problems.length > 0;
    const isSummary = filters.version === 'summary';

    const total = invalid ? 0 : (isSummary ? await countSponsorsInScope(filters) : await countSales(filters));
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(positiveInt(text(req.query.page)) || 1, pageCount);
    const paging = { sort: filters.sort, dir: filters.dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
    const rows = invalid ? [] : (isSummary ? await salesSummary(filters, paging) : await salesDetail(filters, paging));
    // The grand total always covers the whole filtered set, never one page.
    const grand = invalid ? { sales: 0, totalCents: 0, points: 0 } : await salesTotals(filters);

    const keep = { sponsor: filters.sponsorId, version: filters.version };
    const state = { ...keep, from: filters.from, to: filters.to, sort: filters.sort, dir: filters.dir };
    const quickRanges = quickRangeLinks('/reports/sales', { ...keep, sort: filters.sort, dir: filters.dir }, filters, { thisMonth: true });
    const sortLinks = {};
    for (const key of Object.keys(SALES_SORT_COLUMNS[filters.version])) {
      const active = filters.sort === key;
      const dir = active ? (filters.dir === 'asc' ? 'desc' : 'asc') : (DESC_FIRST.includes(key) ? 'desc' : 'asc');
      sortLinks[key] = { href: `/reports/sales${queryString({ ...state, sort: key, dir })}`, active, dir: filters.dir };
    }
    const pageHref = n => `/reports/sales${queryString({ ...state, page: n > 1 ? n : null })}`;
    const versionHref = v => `/reports/sales${queryString({ sponsor: filters.sponsorId, from: filters.from, to: filters.to, version: v })}`;
    const chosenSponsor = filters.sponsorId ? filters.sponsors.find(s => s.id === filters.sponsorId) : null;

    // Story AD-62 pattern: the header states exactly what the report covers.
    const summary = [
      { label: 'Sponsor', value: chosenSponsor ? chosenSponsor.name : 'All sponsors' },
      { label: 'Dates', value: datesSummary(filters) },
      { label: 'Version', value: isSummary ? 'Summary, one row per sponsor' : 'Detailed, one row per purchase' },
      { label: 'Sorted by', value: `${SALES_LABELS[filters.version][filters.sort]}, ${filters.dir === 'asc' ? 'ascending' : 'descending'}` },
      { label: 'Results', value: isSummary
        ? `${total} sponsor${total === 1 ? '' : 's'}, ${grand.sales} sale${grand.sales === 1 ? '' : 's'}`
        : `${grand.sales} sale${grand.sales === 1 ? '' : 's'}` },
    ];

    res.status(invalid ? 400 : 200).render('reports/sales', {
      filters, sponsors: filters.sponsors, chosenSponsor, isSummary,
      error: invalid ? filters.problems.join(' ') : null,
      rows, grand, total, today: isoDate(new Date()), quickRanges, sortLinks, summary, versionHref,
      rangeLabel: rangeLabel(filters),
      page, pageCount,
      pageStart: total ? (page - 1) * PAGE_SIZE + 1 : 0, pageEnd: Math.min(page * PAGE_SIZE, total),
      prevHref: page > 1 ? pageHref(page - 1) : null, nextHref: page < pageCount ? pageHref(page + 1) : null,
      csvHref: `/reports/sales.csv${queryString(state)}`,
      formatStamp, dollars,
    });
  } catch (err) { next(err); }
});

// Same filters, version, and sort as the page; every row, no paging.
router.get('/sales.csv', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') return denyAccess(req, res, { needs: 'admin' });
    const filters = await resolveSalesFilters(req);
    if (filters.problems.length) return res.status(400).type('text/plain').send(filters.problems.join(' '));
    const order = { sort: filters.sort, dir: filters.dir };
    const grand = await salesTotals(filters);
    const money = cents => +(Number(cents) / 100).toFixed(2);
    let lines;
    if (filters.version === 'summary') {
      const rows = await salesSummary(filters, order);
      lines = [
        ['Sponsor', 'Sponsor status', 'Number of sales', 'Total (USD)', 'Points spent'],
        ...rows.map(r => [r.name, r.status, Number(r.sales), money(r.totalCents), Number(r.points)]),
        ['All sponsors', '', Number(grand.sales), money(grand.totalCents), Number(grand.points)],
      ];
    } else {
      const rows = await salesDetail(filters, order);
      lines = [
        ['Date (UTC)', 'Sponsor', 'Driver', 'Username', 'Item', 'Amount (USD)', 'Points spent'],
        ...rows.map(r => [formatStamp(r.purchasedAt), r.sponsorName, r.driverName, r.driverUsername, r.item, money(r.amountCents), Number(r.points)]),
        ['Total', '', '', '', `${Number(grand.sales)} sales`, money(grand.totalCents), Number(grand.points)],
      ];
    }
    const span = `${filters.from ? `-from-${filters.from}` : ''}${filters.to ? `-to-${filters.to}` : ''}`;
    sendCsv(res, `sales-by-sponsor-${filters.version}${span}.csv`, lines);
  } catch (err) { next(err); }
});

module.exports = router;
