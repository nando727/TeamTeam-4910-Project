// Sprint 9: the product list now comes from more than one service, so the
// client moved to src/products/. This path is kept so existing imports, and
// the tests that stub this module's functions, keep working: it is the very
// same object, not a copy.
module.exports = require('../products/provider');
