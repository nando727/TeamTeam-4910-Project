// The one place the app sends mail from. Story 22255 needs it for setup links,
// and the password-reset, account-change, and driver-alert stories will need
// the same seam — so callers depend on sendMail(), never on a transport.

const nodemailer = require('nodemailer');

// Story AA-20 (22222): a reset link has to reach the person's inbox, so there
// is a real transport now. MAIL_TRANSPORT chooses; the default stays 'console'
// so a checkout with no mail settings still works and still shows the link.
const DEFAULT_PORT = 587;

// Read per call, so a test or a demo can change them without a restart.
function smtpSettings() {
  const port = Number.parseInt(process.env.MAIL_PORT, 10);
  return {
    host: process.env.MAIL_HOST,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
    from: process.env.MAIL_FROM,
  };
}

// Which settings are missing, by name. Only the names are ever reported: the
// password is one of these values and must not reach a log.
function missingSmtpSettings() {
  const { host, user, password, from } = smtpSettings();
  return Object.entries({ MAIL_HOST: host, MAIL_USER: user, MAIL_PASSWORD: password, MAIL_FROM: from })
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

// One transporter, rebuilt only when the settings it was built from change.
let cached = { key: null, transporter: null };

function smtpTransporter(settings) {
  const key = `${settings.host}:${settings.port}:${settings.user}`;
  if (cached.key !== key) {
    cached = {
      key,
      transporter: nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        // 465 is TLS from the first byte; 587 starts plain and upgrades, which
        // nodemailer negotiates on its own.
        secure: settings.port === 465,
        auth: { user: settings.user, pass: settings.password },
        // A sign-in or a user being created waits on this, so a server that
        // accepts the connection and then says nothing must not hold the page
        // open for minutes. sendMail() below turns a timeout into a logged
        // failure.
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      }),
    };
  }
  return cached.transporter;
}

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

  // Real delivery. Configured for SES in the deployed environment, but any
  // SMTP server works, which is what makes a demo inbox possible.
  async smtp(message) {
    const settings = smtpSettings();
    await smtpTransporter(settings).sendMail({
      from: settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  },
};

// Kept so tests (and a future "resend" feature) can see what was sent.
const outbox = [];
const MAX_OUTBOX = 50;

function activeTransport() {
  const name = process.env.MAIL_TRANSPORT || 'console';

  // Asking for real delivery without the settings for it would drop every
  // message silently. A reset link nobody receives and nobody can read in the
  // log is the worst of both, so this says what is missing and falls back.
  if (name === 'smtp') {
    const missing = missingSmtpSettings();
    if (missing.length) {
      console.error(
        `MAIL_TRANSPORT=smtp but ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set; writing mail to the log instead.`
      );
      return transports.console;
    }
  }

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

// The transporter is cached across calls, so a test that changes the settings
// needs the next call to build a new one.
function resetTransport() {
  cached = { key: null, transporter: null };
}

module.exports = { sendMail, sentMessages, clearOutbox, resetTransport, missingSmtpSettings };
