// Story 22252: when a signed-in user reaches a page their role can't use, say
// so on a real page instead of returning a bare line of text.
//
// The guards decide *whether* to refuse; this decides what the refusal looks
// like, so all of them explain it the same way.

const ROLE_LABELS = {
  driver: 'driver',
  sponsor: 'sponsor user',
  admin: 'administrator',
};

// `needs` is the role (or roles) the page is for, used only to explain the
// refusal — never to decide it.
function denyAccess(req, res, { needs, detail = null } = {}) {
  const user = req.session.user || null;
  const needed = [].concat(needs || []).map((role) => ROLE_LABELS[role] || role);

  return res.status(403).render('403', {
    yourRole: user ? ROLE_LABELS[user.role] || user.role : null,
    needed,
    detail,
    attemptedPath: req.originalUrl,
  });
}

module.exports = { denyAccess, ROLE_LABELS };
