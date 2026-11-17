// Story AD-46: the invoice as an email. The mailer sends plain text and only
// plain text, deliberately (src/mail/mailer.js is not modified for this), so
// the email IS the invoice: every number on the page, laid out in fixed-width
// columns that read correctly in any mail client's monospace view. A PDF
// stays what it was -- the browser's own "Print or save as PDF" button.

const left = (value, width) => String(value).slice(0, width).padEnd(width);
const right = (value, width) => String(value).slice(0, width).padStart(width);
const rule = width => '-'.repeat(width);

// Plain-text mail reads best kept within 72 columns: wider lines get wrapped
// by the client, and a wrapped table row lands in the wrong column.
const WIDTH = 72;

function wrap(text, width = WIDTH) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line.length + 1 + word.length) > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function invoiceEmailSubject({ number, issuer, monthLabel }) {
  return `Invoice ${number} from ${issuer}, ${monthLabel}`;
}

function invoiceEmailText({ number, issuer, monthLabel, period, sponsor, drivers, items, totals, feePercent, dollars, formatStamp }) {
  const lines = [];
  lines.push(`${issuer} - Good Driver Incentive Program`);
  lines.push(`Invoice ${number}`);
  lines.push('');
  lines.push(`Billing period: ${period.label}`);
  lines.push(`Issued:         ${period.issued}`);
  lines.push(`Amount due:     ${dollars(totals.feeCents)}`);
  lines.push('');
  lines.push('Bill to:');
  lines.push(`  ${sponsor.name}`);
  lines.push(`  ${sponsor.address}`);
  lines.push(`  ${sponsor.contactEmail}${sponsor.contactPhone ? `, ${sponsor.contactPhone}` : ''}`);
  lines.push('');
  lines.push(...wrap(`This invoice is the ${feePercent}% program fee on the points purchases ` +
    `${sponsor.name}'s drivers made during ${monthLabel}, rounded to the cent.`));
  lines.push('');

  if (!items.length) {
    lines.push(`No purchases in ${monthLabel}: nothing is due.`);
    return lines.join('\n');
  }

  lines.push(`Fee by driver (${feePercent}% of each driver's purchases; odd cents are`);
  lines.push('spread so the fees sum exactly to the amount due):');
  lines.push('');
  lines.push(`  ${left('Driver', 28)} ${right('Purchases', 9)} ${right('Total', 12)} ${right('Fee', 9)}`);
  lines.push(`  ${rule(28)} ${rule(9)} ${rule(12)} ${rule(9)}`);
  for (const driver of drivers) {
    lines.push(`  ${left(driver.driverName, 28)} ${right(driver.purchases, 9)} ${right(dollars(driver.totalCents), 12)} ${right(dollars(driver.feeCents), 9)}`);
  }
  lines.push(`  ${left('All drivers', 28)} ${right(totals.purchases, 9)} ${right(dollars(totals.totalCents), 12)} ${right(dollars(totals.feeCents), 9)}`);
  lines.push('');

  lines.push('Purchases:');
  lines.push('');
  // 2 + 16 + 1 + 18 + 1 + 22 + 1 + 10 = 71 columns. Longer names and items
  // are cut to fit; the page and the CSV carry them in full.
  lines.push(`  ${left('Date (UTC)', 16)} ${left('Driver', 18)} ${left('Item', 22)} ${right('Amount', 10)}`);
  lines.push(`  ${rule(16)} ${rule(18)} ${rule(22)} ${rule(10)}`);
  for (const item of items) {
    lines.push(`  ${left(formatStamp(item.purchasedAt), 16)} ${left(item.driverName, 18)} ${left(item.item, 22)} ${right(dollars(item.amountCents), 10)}`);
  }
  lines.push('');
  lines.push(`  Purchases subtotal, ${totals.purchases} purchase${totals.purchases === 1 ? '' : 's'}: ${dollars(totals.totalCents)}`);
  lines.push(`  Program fee, ${feePercent}% of purchases:   ${dollars(totals.feeCents)}`);
  lines.push(`  AMOUNT DUE:                     ${dollars(totals.feeCents)}`);
  return lines.join('\n');
}

// RFC-reserved documentation and testing domains. An address here was typed
// to fill a required field, not to be billed, and the confirm page says so.
function looksLikePlaceholder(address) {
  const domain = String(address || '').split('@')[1];
  if (!domain) return true;
  const lower = domain.toLowerCase();
  return /\.(example|invalid|test|localhost)$/.test(lower) ||
    ['example.com', 'example.net', 'example.org', 'placeholder.invalid'].includes(lower);
}

module.exports = { invoiceEmailSubject, invoiceEmailText, looksLikePlaceholder };
