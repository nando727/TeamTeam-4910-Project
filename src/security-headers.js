// Product images in the catalog come from the product services' own hosts, so
// those hosts are allowed for images and nothing else. Every other outside
// image is still refused. The list lives with the product sources, which also
// refuse to store an image URL from anywhere else.
const { IMAGE_HOSTS } = require('./products/sources');
const PRODUCT_IMAGE_HOSTS = IMAGE_HOSTS;

const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${PRODUCT_IMAGE_HOSTS.join(' ')}`,
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', POLICY);
  // frame-ancestors above is the rule browsers read now; this is the same
  // refusal for an older one that does not.
  res.setHeader('X-Frame-Options', 'DENY');
  // Stops a browser from deciding a response is a script because of how its
  // bytes look, when the Content-Type says it is not.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Reset and setup links are secrets that live in a URL. Without this, the
  // first click on any link in a page reached from one hands that URL to
  // whoever owns the destination.
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

module.exports = { securityHeaders, POLICY, PRODUCT_IMAGE_HOSTS };
