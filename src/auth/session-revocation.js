// Backlog AA-13: refuse sessions that were issued before the account's
// revocation cutoff, so "sign out everywhere" reaches sessions this request
// knows nothing about.
//
// Each session records when it was issued (req.session.issuedAt, set at
// login); an account carries a cutoff (users.sessions_valid_from). A session
// outlives the cutoff only if it was issued strictly after it. That makes the
// check work across devices and across server instances without having to find
// those sessions.
//
// This was originally the only option, because sessions lived in the web
// server's memory and could not be listed or deleted by user. Story AA-71 moved
// them into a sessions table, so deleting a user's rows is now possible too —
// the cutoff is kept anyway: it is one check that also covers a session saved
// between the delete and the reply, and a signed-out session is refused even if
// its row is somehow still there.
//
// Both timestamps come from MySQL, so they cannot disagree about the time.

const { sessionsRevokedSince } = require('../users/store');

function wantsJson(req) {
  return req.path.startsWith('/api') || req.path.startsWith('/session/');
}

async function check(req, res, next) {
  if (!req.session || !req.session.user) return next();

  // While an admin is impersonating, the session is still the admin's: it is
  // their revocations that should end it, not the account they are acting as.
  const owner = req.session.impersonator || req.session.user;
  // The database compares the two times; see sessionsRevokedSince. MySQL
  // DATETIME keeps whole seconds, so a session issued in the same second as
  // the cutoff is refused rather than trusted.
  const revoked = await sessionsRevokedSince(owner.id, req.session.issuedAt || 0);
  if (!revoked) return next();

  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    if (wantsJson(req)) {
      return res.status(401).json({
        success: false,
        error: 'You were signed out of all sessions. Please log in again.',
      });
    }
    res.redirect('/login?reason=everywhere');
  });
}

function sessionRevocation(req, res, next) {
  check(req, res, next).catch(next);
}

module.exports = { sessionRevocation };
