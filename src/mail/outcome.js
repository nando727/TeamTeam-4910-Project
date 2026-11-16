// What to tell the person who just created an account about its setup email,
// from the message sendMail() returned. The setup link is always shown on the
// page as well, so a failed or unsent email never leaves them stuck.
function setupMailNotice(message) {
  if (!message) return null;
  if (message.transport === 'smtp' && message.delivered) {
    return { kind: 'sent', text: `The setup link was emailed to ${message.to}.` };
  }
  if (message.transport === 'smtp') {
    return { kind: 'failed', text: `The setup email to ${message.to} could not be sent. Copy the link below and pass it on yourself.` };
  }
  return { kind: 'logged', text: 'No email service is connected here, so the setup email was written to the server log. Copy the link below and pass it on yourself.' };
}

module.exports = { setupMailNotice };
