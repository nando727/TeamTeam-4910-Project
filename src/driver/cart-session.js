// The cart lives in the session, and the session is saved whole: whatever a
// request loaded, plus its changes, written back at the end. Two requests in
// flight at once each hold their own copy, and the one that finishes last
// wins. For most of the session that never matters. For a cart it does: an
// add that lands while another request is still open can be undone by that
// request writing back the cart it loaded a moment earlier.
//
// Two things close that gap. Background requests no longer write the session
// at all (see isBackgroundRequest in src/auth/session-timeout.js). And every
// cart change goes through here: the session is re-read from the store right
// before the change, the change is made, and the result is saved at once --
// so the window in which a stale copy exists is the change itself, not the
// whole request with its catalog lookups. A true simultaneous pair of writes
// from two tabs can still race; the page-level guard in public/site.js stops
// the common case, and a cart table would be the way to close it entirely.

function reload(req) {
  return new Promise((resolve, reject) => req.session.reload(err => (err ? reject(err) : resolve())));
}

function save(req) {
  return new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));
}

// Runs `mutate` against the freshest copy of the session and saves straight
// away. `mutate` is given the session and may return anything; the return
// value is handed back. It must be synchronous: an await inside it would
// reopen the window this exists to close.
async function withFreshSession(req, mutate) {
  await reload(req);
  // Reloading replaces the session with the stored copy, including the idle
  // clock the timeout middleware had just moved. This is a real action by the
  // user, so the clock moves again.
  if (req.session.user) req.session.lastActivity = Date.now();
  const result = mutate(req.session);
  await save(req);
  return result;
}

module.exports = { withFreshSession };
