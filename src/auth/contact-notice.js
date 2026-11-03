// Story AA-25 (22227): the other half of "tell the owner when the password
// changes". The password notice is only worth anything if the address it goes
// to cannot be swapped in silence first.
//
// Without this, the alert can be routed away from the owner before it is ever
// needed: someone with a session changes the address on the account, then uses
// "forgot password", and both the reset link and the notice about it land in
// their own inbox. The owner is told nothing at any point, and the account is
// gone. So a changed address is announced to the address being replaced --
// the last moment the real owner can still be reached.
//
// Like src/auth/password-notice.js, this reads no database: updateUserContact
// already loads the account before and after the write and passes both rows.

const { sendMail } = require('../mail/mailer');

// Every path that changes an address is self-service (the profile page and the
// JSON profile endpoint), so there is no "an administrator did this" case to
// distinguish here the way the password notice has to.
function noticeText(previous, updated) {
  // Formatted in UTC from this process's clock, for the reason given in
  // password-notice.js: no MySQL DATETIME is allowed to cross into Node.
  const when = new Date().toUTCString();
  return [
    `Hi ${previous.name || previous.username},`,
    '',
    `The email address on your account (${previous.username}) was changed on ${when},`,
    'by someone signed in to the account.',
    '',
    `  was:  ${previous.email}`,
    `  now:  ${updated.email}`,
    '',
    'This message is going to the old address, because it is the last one that',
    'still reaches you. Everything else about the account, including password',
    'reset links, now goes to the new address.',
    '',
    'If you did not make this change, tell an administrator straight away:',
    'whoever did it can reset the password on your account from here.',
  ].join('\n');
}

// previous and updated are the account row before and after the write.
async function notifyEmailChanged(previous, updated) {
  if (!previous || !updated) return null;
  // Nothing to announce when the address did not change, and nowhere to send
  // it when the account had no address to begin with -- a seeded account
  // filling one in for the first time is not losing anything.
  if (!previous.email || previous.email === updated.email) return null;

  return sendMail({
    to: previous.email,
    subject: 'Good Driver Incentive Program: the email address on your account was changed',
    text: noticeText(previous, updated),
  });
}

module.exports = { notifyEmailChanged };
