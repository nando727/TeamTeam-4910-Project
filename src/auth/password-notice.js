// Story AA-25 (22227): the account is told when its password changes, so a
// change the owner did not make does not pass unnoticed.
//
// This hangs off updateUserPassword (src/users/store.js) rather than off the
// four routes that set a password. A notice each route has to remember is a
// notice that goes missing the first time a fifth path appears, and the one
// path that forgets is the one an attacker would rather use.
//
// Nothing here reads the database: the caller passes the account row it has
// already loaded. That keeps the module free of db.js (which would be a
// require cycle, since the store requires this file) and makes the wording
// testable on its own.

const { sendMail } = require('../mail/mailer');

// How the password came to be set, in words for the person reading. The method
// names are the same ones the audit log records -- see PASSWORD_CHANGE_METHODS
// in src/users/store.js.
//
// Saying which route did it is the part that makes this story work: "was that
// reset mine?" is only answerable if a reset the owner performed reads
// differently from one performed for them.
const SOURCE_WORDING = {
  profile: 'The change was made from your profile page, by someone already signed in to your account.',
  'admin-reset': 'The password was reset for you by an administrator.',
  'reset-link': 'The password was reset using a password reset link.',
};

// A first password is not news: whoever used the setup link is the person
// choosing the password, and they are still sitting in front of the form. Every
// other method is announced, including one this file does not recognise -- a
// password change nobody can account for is exactly what the owner needs to
// hear about, so silence must never be the default.
const QUIET_METHODS = ['setup-link'];

function notifiesFor(method) {
  return !QUIET_METHODS.includes(method);
}

// There is no request here to borrow a host from, the way the reset-link mail
// does, so a link can only be offered when APP_BASE_URL is configured. Without
// it the mail names the link on the sign-in page instead of pointing at a
// localhost URL the reader cannot open.
function recoveryAdvice() {
  const base = process.env.APP_BASE_URL;
  const where = base
    ? `reset your password now:\n\n  ${base.replace(/\/+$/, '')}/forgot-password\n`
    : 'use the "Forgot password" link on the sign-in page to set a new one.';
  return `If this was not you, ${where}\nThen tell an administrator, so the account can be checked.`;
}

function noticeText({ name, username, method }) {
  // Formatted from this process's clock, in UTC, and labelled as such. The
  // alternative is reading changed_at back out of the audit row, which means a
  // MySQL DATETIME crossing into Node -- the bug that has already cost this
  // app two fixes. The mail is composed within a second of the write, which is
  // close enough for a human deciding whether they recognise the change.
  const when = new Date().toUTCString();
  const source = SOURCE_WORDING[method] || 'How the change was made was not recorded.';
  return [
    `Hi ${name || username},`,
    '',
    `The password for your account (${username}) was changed on ${when}.`,
    source,
    '',
    'Any other devices signed in to your account were signed out.',
    '',
    recoveryAdvice(),
  ].join('\n');
}

// Never the new password, never its hash, and never a token: this says that
// something changed and how, which is all the owner needs to recognise it.
async function notifyPasswordChanged(account, { method } = {}) {
  if (!account || !notifiesFor(method)) return null;

  // Seeded accounts have no address yet. Mailing the placeholder the other
  // senders use would mean a guaranteed SMTP failure on a path a user is
  // waiting on, so this says so in the log and stops.
  if (!account.email) {
    console.log(`[password-notice] no email on file for ${account.username}; no notice sent`);
    return null;
  }

  return sendMail({
    to: account.email,
    subject: 'Good Driver Incentive Program: your password was changed',
    text: noticeText({ name: account.name, username: account.username, method }),
  });
}

module.exports = { notifyPasswordChanged, notifiesFor, SOURCE_WORDING, QUIET_METHODS };
