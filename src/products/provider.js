// The product list the catalog pages read: every service in src/products/
// sources.js merged into one, searched here in memory. Neither service offers
// a text search worth relying on, and the whole list is a couple of hundred
// rows cached for a few minutes, so searching the cached list is both simpler
// and faster than a request per keystroke.
//
// Failure is per service. One that cannot be reached falls back to its stale
// cache (when allowed) and then to its snapshot; only when every service has
// nothing at all does the caller see an error. A service that is down with no
// snapshot simply contributes nothing for a while, and its products reappear
// when it answers again.

const { FakeStoreError, sources, DUMMYJSON_ID_OFFSET, IMAGE_HOSTS } = require('./sources');

async function listProducts(options = {}) {
  const results = await Promise.allSettled(sources.map(source => source.listProducts(options)));
  const products = [];
  const failures = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') products.push(...result.value);
    else failures.push({ source: sources[i].name, error: result.reason });
  });
  if (failures.length === results.length) {
    // Every service failed: the first error is as good a reason as any, and
    // it is already a message safe to show.
    const { error } = failures[0];
    throw error instanceof FakeStoreError ? error : new FakeStoreError('Could not reach the product service. Try again in a moment.');
  }
  for (const { source, error } of failures) console.warn(`[products] ${source} unavailable: ${error.message}`);
  return products;
}

async function listCategories() {
  const products = await listProducts();
  return [...new Set(products.map(p => p.category).filter(Boolean))].sort();
}

// q matches title, description or category (case-insensitive); category is an
// exact match. Both are optional and combine with AND. Sorted by title so the
// two services interleave rather than appearing one after the other.
async function searchProducts({ q = '', category = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return (await listProducts())
    .filter(p => {
      if (category && p.category !== category) return false;
      if (!needle) return true;
      return [p.title, p.description, p.category].some(field => field.toLowerCase().includes(needle));
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.productId - b.productId);
}

// One product by its catalog id. Asked of the service that owns the id, so a
// product can only be reported missing by the service it came from, never
// because another service happened to be down.
async function getProduct(productId, options) {
  const source = sources.find(s => s.owns(productId));
  if (!source) throw new FakeStoreError('That product is no longer available.', 404);
  const product = (await source.listProducts(options)).find(p => p.productId === productId);
  if (!product) throw new FakeStoreError('That product is no longer available.', 404);
  return product;
}

module.exports = {
  listProducts, listCategories, searchProducts, getProduct, FakeStoreError,
  DUMMYJSON_ID_OFFSET, IMAGE_HOSTS,
  _resetCache: () => sources.forEach(source => source.resetCache()),
};
