// Outbound mail. No email service is configured for this project yet, so the
// only transport prints to the server console. When one is added (SES,
// nodemailer, ...), implement sendMail() there and leave the callers alone.

async function sendMail({ to, subject, text }) {
  const lines = [
    '',
    '================ EMAIL (console transport, nothing was sent) ================',
    `To:      ${to || '(no email on file)'}`,
    `Subject: ${subject}`,
    '',
    text,
    '=============================================================================',
    '',
  ];
  console.log(lines.join('\n'));
}

async function sendPasswordResetLink({ username, email, link, expiryMinutes }) {
  return sendMail({
    to: email,
    subject: 'Good Driver Incentive Program: reset your password',
    text:
      `Hi ${username},\n\n` +
      `A password reset was requested for your account. Open this link within ${expiryMinutes} minutes to choose a new password:\n\n` +
      `  ${link}\n\n` +
      'The link works once. If you did not ask for this, you can ignore this message and your password will stay the same.',
  });
}

module.exports = { sendMail, sendPasswordResetLink };
