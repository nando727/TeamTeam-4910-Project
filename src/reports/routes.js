const express = require('express');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { listSponsors } = require('../sponsors/store');
const {
  SORT_COLUMNS, SORT_DIRECTIONS,
  listDriversInScope, listPointChanges, countPointChanges, dailyPointTotals,
  monthlySponsorPurchases, listPurchaseMonths,
} = require('./store');

const router = express.Router();

// Stories AD-18 to AD-24, AD-59 to AD-62: the Driver Point Tracking report, for
// sponsors and admins. A sponsor is pinned to their own organization by the
// session; an admin sees everyone and may narrow to one sponsor.
// Story AD-11: the admin-only monthly sponsor fee report.
const REPORT_ROLES = ['sponsor', 'admin'];
const QUICK_RANGE_DAYS = [7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;
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

const isoDate = date => date.toISOString().slice(0, 10);
// A real calendar date in YYYY-MM-DD form (so 2026-13-40 is rejected, not rolled over).
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && isoDate(date) === value;
}
const positiveInt = value =>
  (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null);
const text = value => (typeof value === 'string' ? value.trim() : '');

// Shown on screen and written to the CSV; a stable, sortable form.
function formatStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

// Query string for links that must keep the current state (CSV, quick ranges,
// sort headers, pages). Empty values are dropped.
function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

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

  let from = text(req.query.from) || null;
  let to = text(req.query.to) || null;
  if (from && !isValidDate(from)) { problems.push('Enter the start date as YYYY-MM-DD.'); from = null; }
  if (to && !isValidDate(to)) { problems.push('Enter the end date as YYYY-MM-DD.'); to = null; }
  if (from && to && from > to) problems.push('The start date must be on or before the end date.');

  // Sort: unknown keys fall back to the default rather than erroring, so an
  // old bookmark still works.
  const sort = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, text(req.query.sort)) ? text(req.query.sort) : 'date';
  const dir = SORT_DIRECTIONS.includes(text(req.query.dir)) ? text(req.query.dir) : (sort === 'date' ? 'desc' : 'asc');

  return { sponsorId, driverId, from, to, sort, dir, drivers, problems };
}

function rangeLabel({ from, to }) {
  if (from && to) return from === to ? ` on ${from}` : ` from ${from} to ${to}`;
  if (from) return ` since ${from}`;
  if (to) return ` through ${to}`;
  return '';
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
    const quickRanges = QUICK_RANGE_DAYS.map(days => {
      const from = isoDate(new Date(Date.now() - (days - 1) * DAY_MS));
      return {
        label: `Last ${days} days`,
        href: `/reports/points${queryString({ ...keep, from, to: today, sort: filters.sort, dir: filters.dir })}`,
        active: filters.from === from && filters.to === today,
      };
    });
    quickRanges.push({
      label: 'All time',
      href: `/reports/points${queryString({ ...keep, sort: filters.sort, dir: filters.dir })}`,
      active: !filters.from && !filters.to,
    });

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
      { label: 'Dates', value: filters.from && filters.to ? `${filters.from} to ${filters.to}` : filters.from ? `since ${filters.from}` : filters.to ? `through ${filters.to}` : 'All time' },
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

// One CSV cell. Strings are quoted, and a leading formula character is
// neutralized so a spreadsheet opening the file cannot run it.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
function sendCsv(res, name, lines) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  // A byte-order mark so Excel reads the UTF-8 correctly.
  res.send(`﻿${lines.map(cells => cells.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

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
const dollars = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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

module.exports = router;
