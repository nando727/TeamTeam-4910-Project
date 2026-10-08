const express = require('express');
const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { listSponsors } = require('../sponsors/store');
const { listDriversInScope, listPointChanges } = require('./store');

const router = express.Router();

// Stories AD-18 to AD-22: the Driver Point Tracking report, for sponsors and
// admins. A sponsor is pinned to their own organization by the session; an
// admin sees everyone and may narrow to one sponsor.
const REPORT_ROLES = ['sponsor', 'admin'];
const QUICK_RANGE_DAYS = [7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Query string for links that must keep the current filters (CSV, quick ranges).
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

  return { sponsorId, driverId, from, to, drivers, problems };
}

function rangeLabel({ from, to }) {
  if (from && to) return from === to ? ` on ${from}` : ` from ${from} to ${to}`;
  if (from) return ` since ${from}`;
  if (to) return ` through ${to}`;
  return '';
}

router.get('/points', async (req, res, next) => {
  try {
    const me = req.session.user;
    const filters = await resolveFilters(req);
    const isAdmin = me.role === 'admin';
    const sponsors = isAdmin ? await listSponsors() : [];
    const rows = filters.problems.length ? [] : await listPointChanges(filters);
    const totals = filters.driverId ? filters.drivers.filter(d => d.id === filters.driverId) : filters.drivers;

    const today = isoDate(new Date());
    const keep = { sponsor: isAdmin ? filters.sponsorId : null, driver: filters.driverId };
    const quickRanges = QUICK_RANGE_DAYS.map(days => {
      const from = isoDate(new Date(Date.now() - (days - 1) * DAY_MS));
      return {
        label: `Last ${days} days`,
        href: `/reports/points${queryString({ ...keep, from, to: today })}`,
        active: filters.from === from && filters.to === today,
      };
    });
    quickRanges.push({
      label: 'All time',
      href: `/reports/points${queryString(keep)}`,
      active: !filters.from && !filters.to,
    });

    const scopeSponsor = filters.sponsorId
      ? (filters.drivers[0] && filters.drivers[0].sponsorName) ||
        (sponsors.find(s => s.id === filters.sponsorId) || {}).name || null
      : null;

    res.status(filters.problems.length ? 400 : 200).render('reports/points', {
      isAdmin,
      sponsors,
      drivers: filters.drivers,
      filters,
      error: filters.problems.length ? filters.problems.join(' ') : null,
      rows,
      totals,
      today,
      quickRanges,
      rangeLabel: rangeLabel(filters),
      scopeSponsor,
      csvHref: `/reports/points.csv${queryString({ ...keep, from: filters.from, to: filters.to })}`,
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

// Story AD-22: the same query and the same filters as the page, as a download.
router.get('/points.csv', async (req, res, next) => {
  try {
    const filters = await resolveFilters(req);
    if (filters.problems.length) return res.status(400).type('text/plain').send(filters.problems.join(' '));
    const rows = await listPointChanges(filters);
    const balances = new Map(filters.drivers.map(driver => [driver.id, Number(driver.balance)]));

    const lines = [
      ['Driver', 'Username', 'Current total points', 'Date (UTC)', 'Point change', 'Sponsor', 'Made by', 'Reason'],
      ...rows.map(row => [
        row.driverName, row.driverUsername, balances.get(row.driverId) ?? '', formatStamp(row.changedAt),
        Number(row.pointsChange), row.sponsorName, row.changedBy || 'system', row.reason,
      ]),
    ].map(cells => cells.map(csvCell).join(','));

    const name = `point-report${filters.from ? `-from-${filters.from}` : ''}${filters.to ? `-to-${filters.to}` : ''}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    // A byte-order mark so Excel reads the UTF-8 correctly.
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  } catch (err) { next(err); }
});

module.exports = router;
