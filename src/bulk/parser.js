// Bulk upload file format (RC#1). THE FORMAT IS DEFINED ONLY HERE: change the
// FORMAT object below and the parser, the on-page instructions, the sample
// file, and the tests all follow.
//
//   O|organization name
//   S|organization name|first name|last name|email
//   D|organization name|first name|last name|email|points|reason
//
// No header line. Blank lines are ignored. On D rows, points and reason are
// optional, but points without a reason is an error. There is deliberately no
// row type for admin users: administrative access is never granted by upload.
const readline = require('readline');

const FORMAT = {
  delimiter: '|',
  headerLine: false,
  rows: {
    O: { label: 'organization', fields: ['organization'], required: 1 },
    S: { label: 'sponsor user', fields: ['organization', 'firstName', 'lastName', 'email'], required: 4 },
    D: { label: 'driver user', fields: ['organization', 'firstName', 'lastName', 'email', 'points', 'reason'], required: 4 },
  },
  limits: { organization: 255, firstName: 100, lastName: 100, email: 255, reason: 255 },
};

const FIELD_LABELS = {
  organization: 'organization name', firstName: 'first name', lastName: 'last name', email: 'email', points: 'points', reason: 'reason',
};
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Human-readable layout lines for the upload page and the README.
function describeFormat() {
  return Object.entries(FORMAT.rows).map(([type, spec]) =>
    [type, ...spec.fields.map((f, i) => (i >= spec.required ? `[${FIELD_LABELS[f]}]` : FIELD_LABELS[f]))].join(FORMAT.delimiter));
}

function failure(line, raw, message) {
  return { ok: false, line, raw, error: message };
}

// One line -> { ok: true, row } | { ok: false, error } | null for a blank line.
function parseLine(rawLine, line) {
  const raw = String(rawLine).replace(/\r$/, '');
  if (!raw.trim()) return null;
  const parts = raw.split(FORMAT.delimiter).map(part => part.trim());
  const type = parts[0].toUpperCase();
  const spec = FORMAT.rows[type];
  if (!spec) {
    if (type === 'A' || type === 'ADMIN') return failure(line, raw, 'Admin users cannot be created by upload.');
    return failure(line, raw, `Unknown row type "${parts[0]}". Use ${Object.keys(FORMAT.rows).join(', ')}.`);
  }
  const values = parts.slice(1);
  if (values.length < spec.required) {
    return failure(line, raw, `A ${spec.label} row needs at least ${spec.required} field${spec.required === 1 ? '' : 's'} after the type: ${describeFormat()[Object.keys(FORMAT.rows).indexOf(type)]}.`);
  }
  if (values.length > spec.fields.length) {
    return failure(line, raw, `A ${spec.label} row has at most ${spec.fields.length} fields after the type; this row has ${values.length}.`);
  }
  const row = { line, type, label: spec.label };
  spec.fields.forEach((field, i) => { row[field] = values[i] === undefined ? '' : values[i]; });

  for (const field of spec.fields.slice(0, spec.required)) {
    if (!row[field]) return failure(line, raw, `Missing ${FIELD_LABELS[field]}.`);
  }
  for (const [field, max] of Object.entries(FORMAT.limits)) {
    if (row[field] && row[field].length > max) return failure(line, raw, `${FIELD_LABELS[field]} is longer than ${max} characters.`);
  }
  if (row.email !== undefined && !EMAIL_PATTERN.test(row.email)) return failure(line, raw, `"${row.email}" is not a valid email address.`);

  if (type === 'D') {
    const hasPoints = row.points !== '';
    const hasReason = row.reason !== '';
    if (hasPoints) {
      if (!/^-?\d+$/.test(row.points)) return failure(line, raw, `Points must be a whole number, not "${row.points}".`);
      row.points = Number(row.points);
      if (row.points === 0) return failure(line, raw, 'Points must not be zero.');
      if (Math.abs(row.points) > 2147483647) return failure(line, raw, 'Points value is too large.');
      if (!hasReason) return failure(line, raw, 'Points were given without a reason. Every point change needs a reason.');
    } else {
      if (hasReason) return failure(line, raw, 'A reason was given but no points.');
      row.points = null;
      row.reason = null;
    }
  }
  return { ok: true, line, raw, row };
}

// Parse a whole string (tests, small files).
function parseText(text) {
  const items = [];
  String(text).split('\n').forEach((rawLine, i) => {
    const item = parseLine(rawLine, i + 1);
    if (item) items.push(item);
  });
  return items;
}

// Parse a readable stream line by line without buffering the file, so a very
// large upload uses constant memory.
async function* parseStream(stream) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  for await (const rawLine of lines) {
    line += 1;
    const item = parseLine(rawLine, line);
    if (item) yield item;
  }
}

module.exports = { FORMAT, FIELD_LABELS, describeFormat, parseLine, parseText, parseStream };
