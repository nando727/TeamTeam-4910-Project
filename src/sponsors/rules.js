const db = require('../db');

// Sponsor rules: what a sponsor awards (or deducts) points for. Every query
// takes the sponsor from the session, never from the request, so one sponsor
// can't read or change another's rules.

const MAX_POINTS = 1000000;

// Thrown when a sponsor already has a rule with that name. The message is safe
// to show to the sponsor.
class DuplicateRuleError extends Error {
  constructor(title) {
    super(`You already have a rule named "${title}". Choose a different name, or change the points on the existing rule.`);
    this.name = 'DuplicateRuleError';
  }
}

function parseRuleTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && title.length <= 255 ? title : null;
}

function parseRuleDescription(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 2000 ? text : null;
}

// A whole number, not zero, up to 1,000,000 either way. Negative values are
// allowed so a rule can take points away (for example a speeding violation).
// Returns null for anything else.
function parseRulePoints(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+-]?\d{1,7}$/.test(text)) return null;
  const points = Number(text);
  if (points === 0 || Math.abs(points) > MAX_POINTS) return null;
  return points;
}

// What one point is worth, as a dollar string ("$0.01"), or null if no rate.
function dollarsPerPoint(pointsPerDollar) {
  const rate = Number(pointsPerDollar);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  let text = (1 / rate).toFixed(4).replace(/0+$/, '');
  if ((text.split('.')[1] || '').length < 2) text = (1 / rate).toFixed(2);
  return `$${text}`;
}

async function listRules(sponsorId) {
  return db.query(
    'SELECT id, title, points, description FROM rules WHERE sponsor_id = ? ORDER BY title, id',
    [sponsorId]
  );
}

async function findRule(sponsorId, ruleId) {
  const rows = await db.query(
    'SELECT id, title, points FROM rules WHERE id = ? AND sponsor_id = ?',
    [ruleId, sponsorId]
  );
  return rows[0] || null;
}

// Checks first so the message is friendly even before the unique index exists,
// and still catches the index's own error if two requests race.
async function addRule(sponsorId, { title, points, description }) {
  const existing = await db.query(
    'SELECT id FROM rules WHERE sponsor_id = ? AND title = ? LIMIT 1',
    [sponsorId, title]
  );
  if (existing.length) throw new DuplicateRuleError(title);
  try {
    await db.query(
      'INSERT INTO rules (sponsor_id, title, points, description) VALUES (?, ?, ?, ?)',
      [sponsorId, title, points, description]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new DuplicateRuleError(title);
    throw err;
  }
}

// Returns the rule as it was before the change (so the page can name it), or
// null when it isn't one of this sponsor's rules.
async function updateRulePoints(sponsorId, ruleId, points) {
  const rule = await findRule(sponsorId, ruleId);
  if (!rule) return null;
  await db.query('UPDATE rules SET points = ? WHERE id = ? AND sponsor_id = ?', [points, ruleId, sponsorId]);
  return rule;
}

async function removeRule(sponsorId, ruleId) {
  const result = await db.query('DELETE FROM rules WHERE id = ? AND sponsor_id = ?', [ruleId, sponsorId]);
  return result.affectedRows > 0;
}

// The organization a driver belongs to, or null if they haven't joined one.
async function findDriverSponsor(driverId) {
  const rows = await db.query(
    `SELECT s.id, s.name
     FROM driver_sponsors ds
     JOIN sponsors s ON s.id = ds.sponsor_id
     WHERE ds.driver_id = ?
     LIMIT 1`,
    [driverId]
  );
  return rows[0] || null;
}

module.exports = {
  DuplicateRuleError, parseRuleTitle, parseRuleDescription, parseRulePoints, dollarsPerPoint,
  listRules, findRule, addRule, updateRulePoints, removeRule, findDriverSponsor,
};
