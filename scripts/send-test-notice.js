// Sends the account notices (story AA-25 / 22227) to a real inbox, so the
// wording and the SMTP settings can be checked against an actual mail client.
//
// This touches no database and changes nobody's password: it hands the notice
// functions a made-up account row whose address is the recipient, so what
// arrives is the same text the app sends, composed by the same code.
//
// The deployed site sends through Gmail. If Gmail refuses the sign-in, the
// password is almost always the cause: it must be a Google app password.
require('dotenv').config();

const { missingSmtpSettings } = require('../src/mail/mailer');
const { notifyPasswordChanged } = require('../src/auth/password-notice');
const { notifyEmailChanged } = require('../src/auth/contact-notice');

const KINDS = ['password', 'email', 'both'];
const USAGE = 'Usage: npm run mail:test -- you@example.com [password|email|both]';

// Deliberately a .invalid address: it is shown inside the email-change notice
// as the "new" address, and that TLD can never be delivered to by anyone.
const PRETEND_NEW_ADDRESS = 'someone-else@nowhere.invalid';

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [recipient, kind = 'both'] = process.argv.slice(2);

  if (!recipient) fail(USAGE);
  // Not a validation of what addresses exist -- just enough to catch the
  // argument being in the wrong place.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) fail(`"${recipient}" does not look like an email address.\n${USAGE}`);
  if (!KINDS.includes(kind)) fail(`Unknown notice "${kind}". Pick one of: ${KINDS.join(', ')}.\n${USAGE}`);

  // sendMail falls back to writing the message to the log when the SMTP
  // settings are incomplete, which for this script would look like success
  // and deliver nothing. Refuse up front instead. Only the names are printed:
  // one of these values is the password.
  const missing = missingSmtpSettings();
  if (missing.length) {
    fail(
      `Cannot send: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in .env.\n` +
      'Fill them in (see .env.example) and run this again.'
    );
  }

  // The app defaults to the console transport so a fresh checkout needs no
  // mail settings; the whole point here is a real send.
  process.env.MAIL_TRANSPORT = 'smtp';

  if (!process.env.APP_BASE_URL) {
    console.warn('APP_BASE_URL is not set, so the password notice will name the');
    console.warn('"Forgot password" link instead of carrying a URL.\n');
  }

  console.log(`Sending via ${process.env.MAIL_HOST}:${process.env.MAIL_PORT || 587} as ${process.env.MAIL_FROM}`);
  console.log(`To: ${recipient}\n`);

  const account = { id: 0, name: 'Test Recipient', username: 'test-account', email: recipient };
  const sent = [];

  if (kind === 'password' || kind === 'both') {
    // reset-link is the method worth seeing: it is the one that arrives when
    // somebody else has asked for a reset on your account.
    sent.push(['password changed', await notifyPasswordChanged(account, { method: 'reset-link' })]);
  }
  if (kind === 'email' || kind === 'both') {
    sent.push(['email address changed', await notifyEmailChanged(account, { ...account, email: PRETEND_NEW_ADDRESS })]);
  }

  // sendMail never throws -- a failed send is recorded on the message it
  // returns, so a script that only awaited it would always look successful.
  let failures = 0;
  for (const [label, message] of sent) {
    if (message && message.delivered) {
      console.log(`  sent: ${label}`);
      continue;
    }
    failures += 1;
    console.error(`  FAILED: ${label}${message && message.error ? ` -- ${message.error}` : ''}`);
    if (message && /535|Username and Password not accepted|Invalid login|BadCredentials/i.test(message.error || '')) {
      console.error('  Gmail refused the sign-in. MAIL_PASSWORD must be a Google app password for MAIL_USER,');
      console.error('  not the normal password, and changing the Google password revokes app passwords.');
    }
  }

  if (failures) process.exit(1);
  console.log(`\nDone. Check ${recipient} -- it may take a minute, and look in spam.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
