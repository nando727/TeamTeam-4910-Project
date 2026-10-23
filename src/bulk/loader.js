// Applies parsed bulk upload rows (RC#1). Shared by the admin page and the
// sponsor-side page: the difference is the `actor` scope.
//   admin   -> may create organizations and add users to any organization
//   sponsor -> may add users only to their own organization; O rows are refused
// Every row is handled on its own: a bad row is reported and skipped, and the
// next row is processed. Nothing here reads the whole file at once.
const db = require('../db');
const { createUser, DuplicateError } = require('../users/store');
const { listSponsors, createSponsor } = require('../sponsors/store');
const { issueSetupToken, linkLifetimeHours } = require('../auth/setup-tokens');
const { sendMail } = require('../mail/mailer');
const { adjustPoints } = require('../points/store');

// An O row carries only a name, but the sponsors table requires a unique
// contact email and an address. These placeholders mark what still needs to
// be filled in by the sponsor on their organization page.
function placeholderContact(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'organization';
  return { contactEmail: `bulk-${slug}-${Date.now().toString(36)}@placeholder.invalid`, address: 'Not provided (bulk upload)' };
}

// A username from the email's local part, made unique with a numeric suffix.
async function uniqueUsername(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user').slice(0, 40);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}${n + 1}`;
    const rows = await db.query('SELECT id FROM users WHERE username = ?', [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error(`Could not find a free username for ${email}.`);
}

class BulkLoader {
  // actor: { id, role, sponsorId }  linkFor: rawToken -> absolute setup URL
  constructor({ actor, linkFor }) {
    this.actor = actor;
    this.linkFor = linkFor;
    this.organizations = new Map(); // lower-cased name -> { id, name }
    this.summary = { lines: 0, organizations: 0, sponsorUsers: 0, driverUsers: 0, pointChanges: 0, skipped: 0, errors: 0 };
    this.results = [];
  }

  async start() {
    for (const sponsor of await listSponsors()) this.organizations.set(sponsor.name.toLowerCase(), { id: sponsor.id, name: sponsor.name });
  }

  record(item, status, message, extra = {}) {
    const result = { line: item.line, type: item.row ? item.row.type : (item.raw || '').split('|')[0].trim().toUpperCase() || '?', raw: item.raw, status, message, ...extra };
    this.results.push(result);
    if (status === 'error') this.summary.errors += 1;
    if (status === 'skipped') this.summary.skipped += 1;
    return result;
  }

  // Apply one parsed item. Never throws for a bad row; only for infrastructure failures.
  async apply(item) {
    this.summary.lines += 1;
    if (!item.ok) return this.record(item, 'error', item.error);
    const { row } = item;
    if (row.type === 'O') return this.organization(item);
    const organization = this.organizations.get(row.organization.toLowerCase());
    if (!organization) {
      return this.record(item, 'error', `Organization "${row.organization}" does not exist and was not created earlier in this file.`);
    }
    if (this.actor.role !== 'admin' && organization.id !== this.actor.sponsorId) {
      return this.record(item, 'error', 'You can only add users to your own organization.');
    }
    return row.type === 'S' ? this.sponsorUser(item, organization) : this.driverUser(item, organization);
  }

  async organization(item) {
    const { row } = item;
    if (this.actor.role !== 'admin') return this.record(item, 'error', 'Only administrators can create organizations.');
    const key = row.organization.toLowerCase();
    if (this.organizations.has(key)) {
      return this.record(item, 'skipped', `Organization "${this.organizations.get(key).name}" already exists; rows below can still use it.`);
    }
    try {
      const created = await createSponsor({ name: row.organization, ...placeholderContact(row.organization), contactPhone: null });
      this.organizations.set(key, { id: created.id, name: created.name });
      this.summary.organizations += 1;
      return this.record(item, 'created', `Created organization "${created.name}". Its contact email and address are placeholders until a sponsor edits them.`);
    } catch (err) {
      if (err instanceof DuplicateError) return this.record(item, 'error', err.message);
      throw err;
    }
  }

  async account(row, role, organization) {
    const username = await uniqueUsername(row.email);
    const created = await createUser({
      name: `${row.firstName} ${row.lastName}`.trim(), email: row.email, username, role,
      // No usable password: the setup link is the only way in.
      password: null,
      sponsorId: role === 'sponsor' ? organization.id : null,
    });
    const rawToken = await issueSetupToken(created.id);
    const setupLink = this.linkFor(rawToken);
    await sendMail({
      to: created.email,
      subject: 'Set up your Good Driver Incentive Program account',
      text: [
        `Hello ${created.name},`, '',
        `An account has been created for you as a ${role} with ${organization.name}.`,
        'Choose your password using the link below:', '', setupLink, '',
        `The link works once and expires in ${linkLifetimeHours()} hours.`,
      ].join('\n'),
    });
    return { ...created, setupLink };
  }

  async sponsorUser(item, organization) {
    try {
      const user = await this.account(item.row, 'sponsor', organization);
      this.summary.sponsorUsers += 1;
      return this.record(item, 'created', `Created sponsor user ${user.username} for ${organization.name}.`, { username: user.username, setupLink: user.setupLink });
    } catch (err) {
      if (err instanceof DuplicateError) return this.record(item, 'error', err.message);
      throw err;
    }
  }

  async driverUser(item, organization) {
    const { row } = item;
    let user;
    try {
      user = await this.account(row, 'driver', organization);
    } catch (err) {
      if (err instanceof DuplicateError) return this.record(item, 'error', err.message);
      throw err;
    }
    // Membership: the driver belongs to this organization from the start.
    await db.query('INSERT INTO driver_sponsors (driver_id, sponsor_id) VALUES (?, ?)', [user.id, organization.id]);
    this.summary.driverUsers += 1;
    const extra = { username: user.username, setupLink: user.setupLink };
    if (row.points === null) return this.record(item, 'created', `Created driver ${user.username} in ${organization.name}.`, extra);

    // Points: through the shared adjustment, which writes the transaction row,
    // the balance, and the driver alert together.
    try {
      const balance = await adjustPoints({ driverId: user.id, sponsorId: organization.id, userId: this.actor.id, amount: row.points, reason: row.reason });
      this.summary.pointChanges += 1;
      return this.record(item, 'created', `Created driver ${user.username} in ${organization.name} with ${row.points > 0 ? '+' : ''}${row.points} points (balance ${balance}).`, extra);
    } catch (err) {
      if (!err.status) throw err;
      return this.record(item, 'error', `Created driver ${user.username} in ${organization.name}, but the points were not applied: ${err.message}`, extra);
    }
  }
}

module.exports = { BulkLoader, placeholderContact, uniqueUsername };
