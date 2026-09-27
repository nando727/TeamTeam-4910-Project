// Password-reset email, composed here and sent through the shared mail seam in
// src/mail/mailer.js (console transport by default, see MAIL_TRANSPORT). With
// no email service configured the link ends up in the server console.
const { sendMail } = require('../mail/mailer');

async function sendPasswordResetLink({ username, email, link, expiryMinutes }) {
  return sendMail({
    // Seeded accounts have no address yet; say so instead of failing, so the
    // console transport still shows the link during development.
    to: email || '(no email on file)',
    subject: 'Good Driver Incentive Program: reset your password',
    text:
      `Hi ${username},\n\n` +
      `A password reset was requested for your account. Open this link within ${expiryMinutes} minutes to choose a new password:\n\n` +
      `  ${link}\n\n` +
      'The link works once. If you did not ask for this, you can ignore this message and your password will stay the same.',
  });
}

module.exports = { sendPasswordResetLink };
