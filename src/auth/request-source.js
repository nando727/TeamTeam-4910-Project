// Story AA-70: where a request came from, so failures can be counted per origin
// rather than only per username. Express is behind the load balancer with
// `trust proxy` set, so req.ip is the client rather than the proxy. An IPv4
// address arrives mapped into IPv6 form (::ffff:1.2.3.4) on a dual-stack
// listener; stripping the prefix keeps one address in one shape.
//
// Shared by the sign-in audit (src/auth/routes.js) and the sign-up throttle
// (src/auth/signup.js), so the two can never disagree about an origin.
function requestSource(req) {
  const address = (req && req.ip) || '';
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  // The login_attempts column holds 45 characters, the longest an IPv6 address can be.
  return plain ? plain.slice(0, 45) : null;
}

module.exports = { requestSource };
