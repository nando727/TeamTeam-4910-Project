// Story 22251: the JSON API enforces the same permissions as the pages.
//
// Pages redirect an anonymous visitor to /login and render a 403 page for the
// wrong role. An API client wants neither: it gets a status code and a JSON
// body, so a stray fetch never receives a login page it cannot read.

function requireApiLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'You must be signed in to use this endpoint.' });
  }
  next();
}

// Checked after requireApiLogin, so req.session.user is set by the time this runs.
function requireApiRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!allowed.includes(req.session.user.role)) {
      return res.status(403).json({
        error: `This endpoint is for ${allowed.join(' or ')} accounts.`,
      });
    }
    next();
  };
}

module.exports = { requireApiLogin, requireApiRole };
