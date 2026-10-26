// Small pure helpers shared by the report routes (points, fees, sales).

const DAY_MS = 24 * 60 * 60 * 1000;

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

// Shown on screen and written to CSVs; a stable, sortable form.
function formatStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

const dollars = cents => (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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

// Reads from/to from the query string. Invalid values become problems and are dropped.
function readDateRange(query, problems) {
  let from = text(query.from) || null;
  let to = text(query.to) || null;
  if (from && !isValidDate(from)) { problems.push('Enter the start date as YYYY-MM-DD.'); from = null; }
  if (to && !isValidDate(to)) { problems.push('Enter the end date as YYYY-MM-DD.'); to = null; }
  if (from && to && from > to) problems.push('The start date must be on or before the end date.');
  return { from, to };
}

function rangeLabel({ from, to }) {
  if (from && to) return from === to ? ` on ${from}` : ` from ${from} to ${to}`;
  if (from) return ` since ${from}`;
  if (to) return ` through ${to}`;
  return '';
}

function datesSummary({ from, to }) {
  if (from && to) return `${from} to ${to}`;
  if (from) return `since ${from}`;
  if (to) return `through ${to}`;
  return 'All time';
}

// Quick range links for a report. `keep` is the state every link preserves.
function quickRangeLinks(basePath, keep, { from, to }, { days = [7, 30, 90], thisMonth = false } = {}) {
  const today = isoDate(new Date());
  // Sort and direction go after the dates so links read filter-first.
  const { sort, dir, ...rest } = keep;
  const link = (label, start) => ({
    label, href: `${basePath}${queryString({ ...rest, from: start, to: today, sort, dir })}`, active: from === start && to === today,
  });
  const links = days.map(n => link(`Last ${n} days`, isoDate(new Date(Date.now() - (n - 1) * DAY_MS))));
  if (thisMonth) links.push(link('This month', `${today.slice(0, 7)}-01`));
  links.push({ label: 'All time', href: `${basePath}${queryString({ ...rest, sort, dir })}`, active: !from && !to });
  return links;
}

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

module.exports = {
  DAY_MS, isoDate, isValidDate, positiveInt, text, formatStamp, dollars, queryString,
  readDateRange, rangeLabel, datesSummary, quickRangeLinks, csvCell, sendCsv,
};
