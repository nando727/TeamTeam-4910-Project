// The one place the app sends mail from. Story 22255 needs it for setup links,
// and the password-reset, account-change, and driver-alert stories will need
// the same seam — so callers depend on sendMail(), never on a transport.


const transports = {
  // Writes to stdout, where `npm run dev` shows it.
  console(message) {
    const lines = [
      '--- email ---',
      `To:      ${message.to}`,
      `Subject: ${message.subject}`,
      '',
      message.text,
      '--- end email ---',
    ];
    console.log(lines.join('\n'));
  },

  // Used by tests and by any caller that wants silence.
  silent() {},
};

// Kept so tests (and a future "resend" feature) can see what was sent.
const outbox = [];
const MAX_OUTBOX = 50;

function activeTransport() {
  const name = process.env.MAIL_TRANSPORT || 'console';
  return transports[name] || transports.console;
}

// Callers await this, but a failure to send must never break the operation
// that triggered it: a user is still created even if the mail can't go out.
async function sendMail({ to, subject, text }) {
  if (!to || !subject) throw new Error('sendMail needs at least a "to" and a "subject".');

  const message = { to, subject, text: text || '', sentAt: new Date() };

  try {
    await activeTransport()(message);
    message.delivered = true;
  } catch (err) {
    message.delivered = false;
    message.error = err.message;
    console.error(`Could not send mail to ${to}: ${err.message}`);
  }

  outbox.push(message);
  if (outbox.length > MAX_OUTBOX) outbox.shift();
  return message;
}

function sentMessages() {
  return [...outbox];
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = { sendMail, sentMessages, clearOutbox };
