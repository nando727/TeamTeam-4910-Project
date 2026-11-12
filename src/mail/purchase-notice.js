// Sprint 9: the email a driver gets after checking out a cart. Sent after the
// purchase has been committed, never before, so it can only describe something
// that happened. sendMail turns a dead mail server into a logged failure, so
// a purchase that is made stays made whether or not the notice goes out.
const { sendMail } = require('./mailer');

const points = n => `${Number(n).toLocaleString('en-US')} point${Number(n) === 1 ? '' : 's'}`;

async function sendPurchaseConfirmation({ driver, sponsorName, lines, total, balance, orderLink }) {
  if (!driver || !driver.email) return null;
  const items = lines.map(line => {
    const cost = line.pointsCost * line.quantity;
    return `  ${line.quantity} × ${line.title} — ${points(cost)}`;
  });
  return sendMail({
    to: driver.email,
    subject: `Your order with ${sponsorName}`,
    text: [
      `Hello ${driver.name || driver.username},`,
      '',
      `Thanks for your order. You spent ${points(total)} with ${sponsorName} on:`,
      '',
      ...items,
      '',
      `Your balance with ${sponsorName} is now ${points(balance)}.`,
      '',
      `See all your orders: ${orderLink}`,
    ].join('\n'),
  });
}

module.exports = { sendPurchaseConfirmation };
