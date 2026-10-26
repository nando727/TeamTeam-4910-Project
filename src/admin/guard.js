const { rememberAndRedirect } = require('../auth/return-to');
const { denyAccess } = require('../auth/deny');
const { findUserById } = require('../users/store');

// Admin-only guard. The session only says who signed in, so the account is
// re-read on every request: an admin who was disabled, revoked, demoted, or
// deleted since then is cut off on their next admin request, not just at their
// next login.
async function requireActiveAdmin(req, res, next) {
  if (!req.session.user) return rememberAndRedirect(req, res);
  if (req.session.user.role !== 'admin') return denyAccess(req, res, { needs: 'admin' });
  try {
    const account = await findUserById(req.session.user.id);
    const reason = !account ? 'missing' : account.status !== 'active' ? account.status : account.role !== 'admin' ? 'role' : null;
    if (reason) {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect(`/login?reason=${encodeURIComponent(reason)}`);
      });
    }
    next();
  } catch (err) { next(err); }
}

module.exports = { requireActiveAdmin };
