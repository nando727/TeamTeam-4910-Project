// Story 22208: send someone back to the page they asked for after they log in,
// instead of dumping them on their homepage.
//
// The stored value is only ever used as a redirect target, so it is checked
// before it is saved. Accepting an arbitrary string here would be an open
// redirect: a link like /sponsors?next=https://evil.example could bounce a
// freshly logged-in user off-site, with the app's own domain lending it
// credibility.

// A safe destination is a path on this site: one leading slash, and no
// protocol, host, backslash, or control characters.
function safeReturnPath(url) {
  if (typeof url !== 'string') return null;
  if (url.length === 0 || url.length > 512) return null;
  if (!url.startsWith('/')) return null;
  if (url.startsWith('//')) return null;        // protocol-relative: //evil.example
  if (url.includes('\\')) return null;          // some browsers treat \ as /
  if (/[\x00-\x1f\x7f]/.test(url)) return null; // control characters
  if (url.startsWith('/login') || url.startsWith('/logout')) return null;
  return url;
}

// Called by the guards when an anonymous visitor is turned away. Only GET
// requests are worth remembering: replaying a POST after login would submit a
// form the user never saw.
function rememberAndRedirect(req, res) {
  if (req.method === 'GET') {
    const target = safeReturnPath(req.originalUrl);
    if (target) req.session.returnTo = target;
  }
  return res.redirect('/login');
}

// Where to send someone once they have signed in. Reads the destination that
// was saved before the session was regenerated, then clears it so it is used
// once.
function takeReturnTo(savedPath) {
  return safeReturnPath(savedPath) || '/';
}

module.exports = { safeReturnPath, rememberAndRedirect, takeReturnTo };
