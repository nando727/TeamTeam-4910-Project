// Story 22204: a session dies after a period of inactivity, so an unattended
// browser can't be used to reach someone's account.
//
// The server is authoritative here rather than the cookie. A cookie maxAge
// would make the browser drop the cookie silently, leaving no way to tell an
// expired session apart from a visitor who was never signed in — which is what
// story 22208 has to explain. Instead the session carries a lastActivity
// timestamp that this middleware checks.

const DEFAULT_IDLE_MINUTES = 30;

// Read per call, so a demo or a test can use a short window without a restart.
function idleLimitMs() {
  const minutes = Number.parseFloat(process.env.SESSION_IDLE_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES;
  return safe * 60 * 1000;
}

function idleLimitLabel() {
  const minutes = idleLimitMs() / 60000;
  if (minutes >= 1) {
    const rounded = Math.round(minutes);
    return `${rounded} ${rounded === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = Math.max(1, Math.round(minutes * 60));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function sessionTimeout(req, res, next) {
  if (!req.session || !req.session.user) return next();

  const lastActivity = req.session.lastActivity || 0;
  if (Date.now() - lastActivity <= idleLimitMs()) {
    // Still active: slide the window forward so the limit measures inactivity,
    // not time since login.
    req.session.lastActivity = Date.now();
    return next();
  }

  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    if (req.path.startsWith('/api')) {
      return res.status(401).json({
        success: false,
        error: 'Your session expired. Please log in again.',
      });
    }
    res.redirect('/login?expired=1');
  });
}

module.exports = { sessionTimeout, idleLimitMs, idleLimitLabel };
