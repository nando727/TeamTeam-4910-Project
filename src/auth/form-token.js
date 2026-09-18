const { randomBytes } = require('crypto');

// Per-session token embedded in server-rendered forms so a POST must come from
// a page this app served (same idea as the sponsor application token).
function formToken(req) {
  if (!req.session.formToken) req.session.formToken = randomBytes(32).toString('hex');
  return req.session.formToken;
}

function requireFormToken(req, res, next) {
  if (req.method === 'POST' && req.body.token !== formToken(req)) {
    return res.status(403).send('Invalid form. Reload the page and try again.');
  }
  next();
}

module.exports = { formToken, requireFormToken };
