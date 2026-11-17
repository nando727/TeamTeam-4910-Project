/* aa-55 the audit log report, one page for admins and sponsors
 * the spec's filters: date range, category, and for an admin all or one sponsor
 * a sponsor is pinned to its own organization by the session, never the form
*/
const { CATEGORIES, EVENT_TYPES, findEvents, countEvents } = require('./log');
const { listSponsors } = require('../sponsors/store');
const { findUserById } = require('../users/store');
const {
  positiveInt, text, queryString, formatStamp, readDateRange, rangeLabel, isoDate, sendCsv,
} = require('../reports/helpers');

const PAGE_SIZE = 25;
const CSV_LIMIT = 10000;

// the filters in the query string, shared by the page and the CSV
async function readFilters(req) {
  const me = req.session.user;
  const pinned = me.role === 'admin' ? null : me.sponsorId;
  if (me.role !== 'admin' && !pinned) return null;
  const problems = [];
  const wanted = text(req.query.category);
  const category = Object.prototype.hasOwnProperty.call(CATEGORIES, wanted) ? wanted : '';
  // a sponsor gets no sponsor or account filter, so it can't look past its own drivers
  const sponsors = pinned ? [] : await listSponsors();
  const sponsor = sponsors.find(s => s.id === positiveInt(text(req.query.sponsor))) || null;
  const userId = pinned ? null : positiveInt(text(req.query.user));
  const { from, to } = readDateRange(req.query, problems);
  return {
    problems, sponsors, pinned,
    filters: { category: category || null, sponsorId: pinned || (sponsor ? sponsor.id : null), userId, from, to },
    // what links and the form carry forward
    state: { category, sponsor: sponsor ? String(sponsor.id) : '', user: userId ? String(userId) : '', from, to },
  };
}

// where a driver signed in from is for admins, a sponsor sees only that it happened
async function eventsFor({ filters, pinned }, paging) {
  const rows = await findEvents(filters, paging);
  return pinned ? rows.map(row => (row.type.startsWith('login.') ? { ...row, detail: null } : row)) : rows;
}

// base is where the page is mounted, /admin/audit-log or /reports/audit-log
function auditPages(base) {
  async function page(req, res, next) {
    try {
      const read = await readFilters(req);
      if (!read) return res.sendStatus(403);
      const { problems, sponsors, pinned, filters, state } = read;
      const total = await countEvents(filters);
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const number = Math.min(positiveInt(text(req.query.page)) || 1, pageCount);
      const rows = await eventsFor(read, { limit: PAGE_SIZE, offset: (number - 1) * PAGE_SIZE });
      const pageHref = n => base + queryString({ ...state, page: n > 1 ? n : null });

      res.status(problems.length ? 400 : 200).render('admin/audit-log', {
        base, pinned: Boolean(pinned), rows, sponsors, state, formatStamp,
        categories: Object.entries(CATEGORIES).map(([value, label]) => ({ value, label })),
        target: filters.userId ? await findUserById(filters.userId) : null,
        error: problems.length ? problems.join(' ') : null,
        rangeLabel: rangeLabel(filters), today: isoDate(new Date()),
        csvHref: `${base}.csv${queryString(state)}`,
        total, page: number, pageCount,
        pageStart: total ? (number - 1) * PAGE_SIZE + 1 : 0, pageEnd: Math.min(number * PAGE_SIZE, total),
        prevHref: number > 1 ? pageHref(number - 1) : null, nextHref: number < pageCount ? pageHref(number + 1) : null,
        filtered: Boolean(state.category || state.sponsor || state.user || state.from || state.to),
      });
    } catch (err) { next(err); }
  }

  // the same filters as the page, every row instead of one page
  async function csv(req, res, next) {
    try {
      const read = await readFilters(req);
      if (!read) return res.sendStatus(403);
      if (read.problems.length) return res.status(400).type('text/plain').send(read.problems.join(' '));
      const { from, to } = read.filters;
      const rows = await eventsFor(read, { limit: CSV_LIMIT });
      sendCsv(res, `audit-log${from ? `-from-${from}` : ''}${to ? `-to-${to}` : ''}.csv`, [
        ['Date (UTC)', 'Category', 'Event', 'Account', 'By', 'Sponsor', 'Detail'],
        ...rows.map(row => [
          formatStamp(row.occurredAt), CATEGORIES[(EVENT_TYPES[row.type] || EVENT_TYPES.unknown).category],
          row.label, row.subject, row.actor, row.sponsor, row.detail,
        ]),
      ]);
    } catch (err) { next(err); }
  }

  return { page, csv };
}

module.exports = { auditPages };
