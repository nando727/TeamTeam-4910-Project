// Story AD-40: printable monthly invoices per sponsor, admin only. The amount
// due comes from the sponsor_monthly_fees procedure, so it always matches the
// Sponsor fees page.
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');
const { sentMessages, clearOutbox } = require('../src/mail/mailer');

const users = {
  admin1: { id: 3, role: 'admin', status: 'active', sponsor_id: null },
  sponsor1: { id: 2, role: 'sponsor', status: 'active', sponsor_id: 1 },
  driver1: { id: 1, role: 'driver', status: 'active', sponsor_id: null },
};
const sponsors = [
  { id: 1, name: 'Demo Sponsor', status: 'active', contactEmail: 'billing@demo.example', contactPhone: '864-555-0100', address: '100 Main St, Clemson, SC' },
  { id: 2, name: 'Northstar Freight', status: 'active', contactEmail: 'billing@northstar.example', contactPhone: null, address: '1200 Harbor Way, Charleston, SC' },
  { id: 3, name: 'Quiet <Logistics>', status: 'inactive', contactEmail: 'quiet@example.com', contactPhone: null, address: '1 Quiet Rd' },
];
const purchases = [
  { id: 6, sponsorId: 1, driver: ['Dana Driver', 'driver2'], item: 'Cooler', cents: 4999, points: 500, day: '2026-09-30' },
  { id: 1, sponsorId: 1, driver: ['John Doe', 'driver1'], item: 'Dash camera', cents: 8999, points: 900, day: '2026-10-03' },
  { id: 2, sponsorId: 1, driver: ['Dana Driver', 'driver2'], item: 'Wireless "pro" earbuds', cents: 5900, points: 590, day: '2026-10-11' },
  { id: 4, sponsorId: 2, driver: ['Theo Trucker', 'driver3'], item: 'Headset', cents: 12999, points: 1300, day: '2026-10-19' },
  { id: 3, sponsorId: 1, driver: ['John Doe', 'driver1'], item: 'Tire gauge', cents: 1299, points: 130, day: '2026-10-31' },
  { id: 5, sponsorId: 1, driver: ['John Doe', 'driver1'], item: 'Mug', cents: 2499, points: 250, day: '2026-11-01' },
];
let hash;
let extraLineItem;
let auditRows;

beforeAll(async () => { hash = await hashPassword('Password1!'); });

beforeEach(() => {
  extraLineItem = null;
  auditRows = [];
  clearOutbox();
  vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
    if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
    if (sql.startsWith('INSERT INTO login_attempts')) return {};
    if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
    if (sql.includes('FROM users WHERE username')) {
      const user = users[params[0]];
      return user ? [{ ...user, username: params[0], password_hash: hash }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const [name, user] = Object.entries(users).find(([, u]) => u.id === params[0]) || [];
      return user ? [{ ...user, username: name, name: null, email: null }] : [];
    }
    if (sql.startsWith('CALL sponsor_monthly_fees(?, ')) {
      const month = params[0].slice(0, 7);
      const scope = sql.includes('NULL') ? sponsors : sponsors.filter(s => s.id === params[1]);
      const rows = scope.map(s => {
        const mine = purchases.filter(p => p.sponsorId === s.id && p.day.startsWith(month));
        const total = mine.reduce((a, p) => a + p.cents, 0);
        return { id: s.id, name: s.name, status: s.status, purchases: mine.length, totalCents: String(total), feeCents: String(Math.round(total / 100)) };
      });
      return [rows, { affectedRows: 0 }];
    }
    if (sql.startsWith('SELECT p.id, p.purchased_at AS purchasedAt, COALESCE')) {
      expect(sql).toContain('p.purchased_at < DATE_ADD(?, INTERVAL 1 MONTH)');
      const [sponsorId, start, start2] = params;
      expect(start2).toBe(start);
      const rows = purchases.filter(p => p.sponsorId === sponsorId && p.day.startsWith(start.slice(0, 7)))
        .sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id)
        .map(p => ({ id: p.id, purchasedAt: new Date(`${p.day}T15:00:00Z`), driverName: p.driver[0], driverUsername: p.driver[1], item: p.item, points: p.points, amountCents: p.cents }));
      return extraLineItem ? [...rows, extraLineItem] : rows;
    }
    if (sql.startsWith('SELECT id, name, contact_email AS contactEmail')) return sponsors.filter(s => s.id === params[0]);
    if (sql.startsWith("SELECT DISTINCT DATE_FORMAT(purchased_at, '%Y-%m')")) {
      return [...new Set(purchases.map(p => p.day.slice(0, 7)))].sort().reverse().map(month => ({ month }));
    }
    if (sql.startsWith('SELECT team_name')) return [{ team_name: 'F26-Team13', app_version: '1.0.0', release_date: '2026-09-15', description: 'x' }];
    if (sql.startsWith('INSERT INTO admin_actions')) { auditRows.push(params); return { insertId: auditRows.length }; }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

afterEach(() => { vi.restoreAllMocks(); clearOutbox(); });

async function login(username) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username, password: 'Password1!' }).expect(302);
  return agent;
}
const csvLines = res => res.text.replace(/^﻿/, '').trim().split('\r\n');
const callParams = () => db.query.mock.calls.filter(([sql]) => sql.startsWith('CALL sponsor_monthly_fees')).map(([sql, params]) => [sql, params]);

describe('access', () => {
  test('admins only, from the Reports menu and the home page', async () => {
    for (const path of ['/reports/invoices', '/reports/invoices.csv', '/reports/invoices/1', '/reports/invoices/1.csv']) {
      await request(app).get(path).expect(302).expect('Location', '/login');
    }
    const sponsor = await login('sponsor1');
    for (const path of ['/reports/invoices', '/reports/invoices/1', '/reports/invoices/1.csv']) await sponsor.get(path).expect(403);
    const driver = await login('driver1');
    await driver.get('/reports/invoices/1').expect(403);
    const admin = await login('admin1');
    const home = await admin.get('/').expect(200);
    expect(home.text).toContain('<a class="site-menu__item" href="/reports/invoices">Invoices');
    expect(home.text).toContain('<a class="action" href="/reports/invoices">');
  });
});

describe('the invoice list', () => {
  test('a month lists every sponsor with its invoice number, purchases, and amount due', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices?month=2026-10').expect(200);
    expect(callParams().pop()).toEqual(['CALL sponsor_monthly_fees(?, NULL)', ['2026-10-01']]);
    for (const line of ['Month</dt><dd>October 2026</dd>', 'Status</dt><dd>Complete, ready to bill</dd>', 'Sponsors</dt><dd>3</dd>', 'Total due</dt><dd>$2.92</dd>']) {
      expect(page.text).toContain(line);
    }
    expect(page.text).toMatch(/<a href="\/reports\/invoices\/1\?month=2026-10"[^>]*>INV-202610-0001<\/a><\/td>\s*<td class="cell-strong">Demo Sponsor<\/td>[\s\S]*?<td class="num">3<\/td>\s*<td class="num">\$161\.98<\/td>\s*<td class="num cell-strong">\$1\.62<\/td>/);
    expect(page.text).toMatch(/INV-202610-0002<\/a>[\s\S]*?<td class="num cell-strong">\$1\.30<\/td>/);
    expect(page.text).toMatch(/<tr class="is-muted">\s*<td class="nowrap"><a href="\/reports\/invoices\/3\?month=2026-10"/);
    expect(page.text).toContain('Quiet &lt;Logistics&gt;');
    expect(page.text).toMatch(/All sponsors<\/th>\s*<td class="num">4<\/td>\s*<td class="num">\$291\.97<\/td>\s*<td class="num cell-strong">\$2\.92<\/td>/);
    expect(page.text).toContain('id="report-status"');
    expect(page.text).toContain('href="/reports/invoices?month=2026-09"');
  });

  test('with no month it shows the last complete month, the one being billed', async () => {
    const admin = await login('admin1');
    await admin.get('/reports/invoices').expect(200);
    const now = new Date();
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    expect(callParams().pop()[1]).toEqual([`${previous}-01`]);
  });

  test('the current month is marked as not final', async () => {
    const admin = await login('admin1');
    const month = new Date().toISOString().slice(0, 7);
    const page = await admin.get(`/reports/invoices?month=${month}`).expect(200);
    expect(page.text).toContain('Status</dt><dd>In progress, not final</dd>');
    expect(page.text).toContain('is still in progress, so these invoices are not final.');
  });

  test('a month with no purchases says so plainly', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices?month=2026-01').expect(200);
    expect(page.text).toContain('No purchases in January 2026.');
    expect(page.text).toContain("Every sponsor's invoice for this month is for $0.00.");
  });

  test('a bad month is refused', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices?month=2026-13').expect(400);
    expect(page.text).toContain('Choose a month as YYYY-MM.');
    await admin.get('/reports/invoices.csv?month=nope').expect(400);
  });

  test('the CSV lists the same invoices with a total row', async () => {
    const admin = await login('admin1');
    const res = await admin.get('/reports/invoices.csv?month=2026-10').expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="invoices-2026-10.csv"');
    const lines = csvLines(res);
    expect(lines[0]).toBe('"Invoice","Month","Sponsor","Sponsor status","Purchases","Purchase total (USD)","Amount due, 1% (USD)"');
    expect(lines[1]).toBe('"INV-202610-0001","2026-10","Demo Sponsor","active",3,161.98,1.62');
    expect(lines[4]).toBe('"","2026-10","All sponsors","",4,291.97,2.92');
  });
});

describe('one invoice', () => {
  test('bills the sponsor for the month, line by line, with the fee from the procedure as the amount due', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/1?month=2026-10').expect(200);
    expect(callParams().pop()).toEqual(['CALL sponsor_monthly_fees(?, ?)', ['2026-10-01', 1]]);
    // The id carries the sponsor so the print-all page can hold many invoices.
    expect(page.text).toContain('<h1 id="invoice-title-1">Invoice INV-202610-0001</h1>');
    expect(page.text).toContain('From F26-Team13');
    expect(page.text).toContain('<dt>Billing period</dt><dd>October 1, 2026 to October 31, 2026</dd>');
    expect(page.text).toContain('<dt>Issued</dt><dd>November 1, 2026</dd>');
    expect(page.text).toContain('<dt>Amount due</dt><dd class="invoice__due">$1.62</dd>');
    expect(page.text).toMatch(/<strong>Demo Sponsor<\/strong><br>\s*100 Main St, Clemson, SC<br>\s*billing@demo\.example<br>864-555-0100/);
    // Line items in date order, including the last day of the month, excluding the neighbors.
    const rows = [...page.text.matchAll(/<tr>\s*<td class="nowrap">([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>/g)].map(m => [m[1], m[2], m[3]]);
    expect(rows).toEqual([
      ['2026-10-03 15:00', 'John Doe', 'Dash camera'],
      ['2026-10-11 15:00', 'Dana Driver', 'Wireless &#34;pro&#34; earbuds'],
      ['2026-10-31 15:00', 'John Doe', 'Tire gauge'],
    ]);
    expect(page.text).not.toContain('Cooler');
    expect(page.text).not.toContain('>Mug<');
    expect(page.text).toMatch(/Purchases subtotal, 3 purchases<\/th>\s*<td class="num">1,620<\/td>\s*<td class="num">\$161\.98<\/td>/);
    expect(page.text).toMatch(/Program fee, 1% of purchases<\/th>\s*<td class="num">\$1\.62<\/td>/);
    expect(page.text).toMatch(/<tr class="invoice__total">\s*<th scope="row" colspan="4">Amount due<\/th>\s*<td class="num">\$1\.62<\/td>/);
    expect(page.text).toContain('<button type="button" class="button--small" data-print>Print or save as PDF</button>');
    expect(page.text).toContain('<script src="/report.js" defer></script>');
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(page.text).not.toContain('A purchase was recorded while this invoice');
  });

  test('a sponsor with no purchases that month owes nothing, and the invoice says so', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/3?month=2026-10').expect(200);
    expect(page.text).toContain('Quiet &lt;Logistics&gt;');
    expect(page.text).toContain('<span class="status-badge status-inactive">inactive</span>');
    expect(page.text).toContain('No purchases in October 2026.');
    expect(page.text).toContain('<dt>Amount due</dt><dd class="invoice__due">$0.00</dd>');
  });

  test('the current month is marked as not final', async () => {
    const admin = await login('admin1');
    const month = new Date().toISOString().slice(0, 7);
    const page = await admin.get(`/reports/invoices/1?month=${month}`).expect(200);
    expect(page.text).toContain('<strong>Not final.</strong>');
  });

  test('if the line items and the total disagree, it warns instead of printing a wrong bill silently', async () => {
    extraLineItem = { id: 77, purchasedAt: new Date('2026-10-20T15:00:00Z'), driverName: 'Late Arrival', driverUsername: 'late', item: 'Gloves', points: 10, amountCents: 100 };
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/1?month=2026-10').expect(200);
    expect(page.text).toContain('A purchase was recorded while this invoice was being prepared');
  });

  test('an unknown sponsor or a bad month is refused', async () => {
    const admin = await login('admin1');
    expect((await admin.get('/reports/invoices/99?month=2026-10').expect(404)).text).toContain('There is no sponsor with that id.');
    await admin.get('/reports/invoices/abc?month=2026-10').expect(404);
    expect((await admin.get('/reports/invoices/1?month=2026-13').expect(400)).text).toContain('Choose a month as YYYY-MM.');
    await admin.get('/reports/invoices/99.csv?month=2026-10').expect(404);
  });

  test('the invoice CSV has every line, the subtotal, the fee, and the amount due', async () => {
    const admin = await login('admin1');
    const res = await admin.get('/reports/invoices/1.csv?month=2026-10').expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="invoice-INV-202610-0001.csv"');
    const lines = csvLines(res);
    expect(lines).toEqual([
      '"Date (UTC)","Driver","Username","Item","Points spent","Amount (USD)"',
      '"2026-10-03 15:00","John Doe","driver1","Dash camera",900,89.99',
      '"2026-10-11 15:00","Dana Driver","driver2","Wireless ""pro"" earbuds",590,59',
      '"2026-10-31 15:00","John Doe","driver1","Tire gauge",130,12.99',
      '"Purchases subtotal","","","3 purchases",1620,161.98',
      '"Program fee (1% of purchases)","","","","",1.62',
      '"Amount due","","","","",1.62',
    ]);
  });
});

describe('the fee by driver (AD-43)', () => {
  test('each driver\'s purchases, total, and fee, summing to the cent to the amount due', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/1?month=2026-10').expect(200);
    expect(page.text).toContain('Fee by driver');
    // Alphabetical: Dana, then John. Exact fees are 59.00c and 102.98c; the
    // procedure bills 162c, so the odd cent lands on the larger remainder.
    const rows = [...page.text.matchAll(/<td class="cell-strong">([^<]+)<span class="muted small">\(([^)]+)\)<\/span><\/td>\s*<td class="num">(\d+)<\/td>\s*<td class="num">([^<]+)<\/td>\s*<td class="num">([^<]+)<\/td>/g)]
      .map(m => [m[1].trim(), m[2], m[3], m[4], m[5]]);
    expect(rows).toEqual([
      ['Dana Driver', 'driver2', '1', '$59.00', '$0.59'],
      ['John Doe', 'driver1', '2', '$102.98', '$1.03'],
    ]);
    expect(page.text).toMatch(/All drivers<\/th>\s*<td class="num">3<\/td>\s*<td class="num">\$161\.98<\/td>\s*<td class="num cell-strong">\$1\.62<\/td>/);
    expect(page.text).toContain('Odd cents are spread across the drivers');
    // The line items are still there in full.
    expect(page.text).toContain('Dash camera');
    expect(page.text).toContain('Tire gauge');
  });

  test('an invoice with no purchases shows no driver section', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/3?month=2026-10').expect(200);
    expect(page.text).not.toContain('Fee by driver');
  });
});

describe('print all invoices (AD-41)', () => {
  test('one page holds every billable sponsor\'s full invoice, page-broken, skipping zero months', async () => {
    const admin = await login('admin1');
    const list = await admin.get('/reports/invoices?month=2026-10').expect(200);
    expect(list.text).toContain('href="/reports/invoices/print?month=2026-10"');
    const page = await admin.get('/reports/invoices/print?month=2026-10').expect(200);
    // Both full invoices, with their own headers, driver fees, and totals.
    expect(page.text).toContain('<h1 id="invoice-title-1">Invoice INV-202610-0001</h1>');
    expect(page.text).toContain('<h1 id="invoice-title-2">Invoice INV-202610-0002</h1>');
    expect(page.text.match(/class="invoice-sheet"/g)).toHaveLength(2);
    expect(page.text.match(/Fee by driver/g)).toHaveLength(2);
    expect(page.text).toContain('Theo Trucker');
    // Quiet Logistics had no purchases in October: not billed, not printed.
    expect(page.text).not.toContain('Quiet &lt;Logistics&gt;');
    expect(page.text).toContain('2 invoices for October 2026, $2.92 due in total');
    expect(page.text).toContain('Each one starts on its own printed page.');
    expect(page.text).toContain('data-print');
  });

  test('a month with nothing to bill says so instead of printing blank sheets', async () => {
    const admin = await login('admin1');
    const page = await admin.get('/reports/invoices/print?month=2026-01').expect(200);
    expect(page.text).toContain('No purchases in January 2026.');
    expect(page.text).not.toContain('class="invoice-sheet"');
  });

  test('admins only, and a bad month is refused', async () => {
    await request(app).get('/reports/invoices/print?month=2026-10').expect(302);
    const sponsor = await login('sponsor1');
    await sponsor.get('/reports/invoices/print?month=2026-10').expect(403);
    const admin = await login('admin1');
    await admin.get('/reports/invoices/print?month=2026-13').expect(400);
  });
});

describe('emailing an invoice (AD-46)', () => {
  const tokenOf = page => page.text.match(/name="token" value="([a-f0-9]+)"/)[1];

  test('the invoice page offers it, and the confirm page shows exactly what will be sent', async () => {
    const admin = await login('admin1');
    const invoice = await admin.get('/reports/invoices/1?month=2026-10').expect(200);
    expect(invoice.text).toContain('href="/reports/invoices/1/email?month=2026-10"');
    expect(invoice.text).toContain('Email this invoice');
    const page = await admin.get('/reports/invoices/1/email?month=2026-10').expect(200);
    expect(page.text).toContain('<strong>billing@demo.example</strong>');
    expect(page.text).toContain('Invoice INV-202610-0001 from F26-Team13, October 2026');
    // The .example domain is reserved for documentation, and the page says so.
    expect(page.text).toContain('This address looks like a placeholder.');
    // The full text body is on the page, driver fees and all.
    expect(page.text).toContain('Fee by driver');
    expect(page.text).toContain('AMOUNT DUE');
    expect(page.text).toContain('Send to billing@demo.example');
    // Looking at the page sends nothing.
    expect(sentMessages()).toHaveLength(0);
  });

  test('confirming sends the text invoice through sendMail and reports what happened', async () => {
    const admin = await login('admin1');
    const confirm = await admin.get('/reports/invoices/1/email?month=2026-10').expect(200);
    const res = await admin.post('/reports/invoices/1/email?month=2026-10').type('form')
      .send({ token: tokenOf(confirm) }).expect(303);
    expect(res.headers.location).toBe('/reports/invoices/1?month=2026-10');

    const [mail] = sentMessages();
    expect(mail.to).toBe('billing@demo.example');
    expect(mail.subject).toBe('Invoice INV-202610-0001 from F26-Team13, October 2026');
    expect(mail.transport).toBe('console');
    expect(mail.text).toContain('Invoice INV-202610-0001');
    expect(mail.text).toContain('Billing period: October 1, 2026 to October 31, 2026');
    expect(mail.text).toContain('Amount due:     $1.62');
    expect(mail.text).toMatch(/Dana Driver\s+1\s+\$59\.00\s+\$0\.59/);
    expect(mail.text).toMatch(/John Doe\s+2\s+\$102\.98\s+\$1\.03/);
    expect(mail.text).toContain('Dash camera');
    // Plain text stays within 72 columns, so no client wraps a table row
    // into the wrong column.
    const wide = mail.text.split('\n').filter(line => line.length > 72);
    expect(wide).toEqual([]);

    // The tests run on the console transport, so the page says the truth:
    // written to the log, not sent.
    const invoice = await admin.get(res.headers.location).expect(200);
    expect(invoice.text).toContain('No email service is connected here, so invoice INV-202610-0001 was written to the server log');
    // One-shot: a reload does not claim it again.
    const again = await admin.get(res.headers.location).expect(200);
    expect(again.text).not.toContain('written to the server log');

    // And the audit log knows billing went out.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0][0]).toBe(3);
    expect(auditRows[0][2]).toBe('invoice-emailed');
    expect(auditRows[0][3]).toContain('INV-202610-0001 for Demo Sponsor (October 2026) to billing@demo.example: written to the server log');
  });

  test('needs the form token, an admin, and a real sponsor', async () => {
    const admin = await login('admin1');
    await admin.post('/reports/invoices/1/email?month=2026-10').type('form').send({ token: 'nope' }).expect(403);
    const sponsor = await login('sponsor1');
    await sponsor.get('/reports/invoices/1/email?month=2026-10').expect(403);
    await sponsor.post('/reports/invoices/1/email?month=2026-10').type('form').send({}).expect(403);
    await request(app).get('/reports/invoices/1/email?month=2026-10').expect(302);
    await admin.get('/reports/invoices/99/email?month=2026-10').expect(404);
    expect(sentMessages()).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
