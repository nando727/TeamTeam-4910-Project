// The two product services the catalog draws from, and what is shared between
// them: the error type, the image rule, and the cache-then-snapshot fallback.
//
// Sprint 9: FakeStoreAPI has about twenty products, which was too few for a
// sponsor to build a catalog from. DummyJSON has about two hundred with real
// images on its own CDN. Both are kept: sponsors have already saved FakeStore
// products, and purchases have been made from them, so FakeStore ids stay
// exactly what they are. DummyJSON ids are offset by DUMMYJSON_ID_OFFSET so
// the two sets can share catalog_items.product_id without colliding, and the
// offset is how a product id is routed back to its service.
//
// Neither service needs an API key.

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60 * 1000;
// While serving a snapshot, try the live service again after a minute.
const SNAPSHOT_RETRY_MS = 60 * 1000;

const DUMMYJSON_ID_OFFSET = 1000;

// Messages are safe to show a sponsor or a driver.
class FakeStoreError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FakeStoreError';
    this.status = status;
  }
}

// Only these hosts may serve a catalog image: they are the ones the content
// security policy allows (src/security-headers.js). Anything else becomes
// "no image" rather than a blocked request the browser logs as an error.
const IMAGE_HOSTS = ['https://fakestoreapi.com', 'https://cdn.dummyjson.com'];
function allowedImage(url) {
  if (typeof url !== 'string') return null;
  return IMAGE_HOSTS.some(host => url === host || url.startsWith(`${host}/`)) ? url : null;
}

// Keeps only what the catalog needs; drops anything missing an id, title or a
// usable price so the page never shows half a product.
function normalizeProduct({ id, title, category, description, price, image, stock, availabilityStatus }) {
  if (!Number.isInteger(id) || id < 1) return null;
  const value = Number(price);
  if (typeof title !== 'string' || !title.trim() || !Number.isFinite(value) || value < 0) return null;
  return {
    productId: id,
    title: title.trim().slice(0, 500),
    category: typeof category === 'string' ? category.slice(0, 100) : '',
    description: typeof description === 'string' ? description : '',
    imageUrl: allowedImage(image),
    priceValue: value,
    availability: (typeof stock === 'number' && stock <= 0) || /out of stock|unavailable|removed/i.test(availabilityStatus || '') ? 'unavailable' : 'available',
  };
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; GoodDriverProgram/1.0)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FakeStoreError('Could not reach the product service. Try again in a moment.');
  }
  if (!res.ok) throw new FakeStoreError(`The product service returned an error (${res.status}).`);
  try { return await res.json(); } catch (err) { return null; }
}

// One service: how to fetch its list, how to read each row, where its
// snapshot lives, and which product ids are its own.
//
// listProducts(allowStale):
//   fresh list from the service when the cache has expired;
//   else the cached list;
//   on failure, the stale cache if allowStale, then the snapshot, then throw.
function createSource({ name, url, pick, snapshotPath, owns, toLocalId = id => id, toProductId = id => id }) {
  let cache = { products: null, expiresAt: 0 };

  function readSnapshot() {
    try {
      const body = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const products = Array.isArray(body) ? body.map(row => normalizeRow(row)).filter(Boolean) : [];
      return products.length ? products : null;
    } catch (err) {
      return null;
    }
  }

  function normalizeRow(row) {
    const product = normalizeProduct(pick(row));
    return product ? { ...product, productId: toProductId(product.productId), source: name } : null;
  }

  function fallbackOrThrow(error, allowStale) {
    if (allowStale && cache.products) return cache.products.map(product => ({ ...product, availability: 'unknown' }));
    const snapshot = readSnapshot();
    if (snapshot) {
      console.warn(`[products] ${name}: live request failed (${error.message}); serving the local snapshot`);
      cache = { products: snapshot.map(product => ({ ...product, availability: 'unknown' })), expiresAt: Date.now() + SNAPSHOT_RETRY_MS };
      return cache.products;
    }
    throw error;
  }

  async function listProducts({ allowStale = true } = {}) {
    if (cache.products && Date.now() < cache.expiresAt) return cache.products;
    let body;
    try {
      body = await fetchJson(url);
    } catch (err) {
      return fallbackOrThrow(err, allowStale);
    }
    const rows = Array.isArray(body) ? body : body && Array.isArray(body.products) ? body.products : null;
    if (!rows) return fallbackOrThrow(new FakeStoreError('The product service returned an unexpected response.'), allowStale);
    cache = { products: rows.map(normalizeRow).filter(Boolean), expiresAt: Date.now() + CACHE_MS };
    return cache.products;
  }

  return {
    name, owns, toLocalId, listProducts,
    resetCache() { cache = { products: null, expiresAt: 0 }; },
  };
}

// FakeStoreAPI: https://fakestoreapi.com/products, an array. Ids 1 and up,
// kept as they are. An optional local copy at src/fakestore/products.json is
// the outage fallback, as before.
const fakestore = createSource({
  name: 'fakestore',
  url: `${(process.env.FAKESTORE_URL || 'https://fakestoreapi.com').replace(/\/+$/, '')}/products`,
  pick: row => ({ id: row.id, title: row.title, category: row.category, description: row.description, price: row.price, image: row.image }),
  snapshotPath: path.join(__dirname, '..', 'fakestore', 'products.json'),
  owns: productId => productId < DUMMYJSON_ID_OFFSET,
});

// DummyJSON: https://dummyjson.com/products, {products: [...]} with
// limit=0 for every product and select= to keep the response small. Ids 1 to
// about 200, stored as 1001 and up. The committed snapshot
// (dummyjson-products.json) is the outage fallback, so this source is almost
// never empty.
const dummyjson = createSource({
  name: 'dummyjson',
  url: `${(process.env.DUMMYJSON_URL || 'https://dummyjson.com').replace(/\/+$/, '')}/products?limit=0&select=id,title,description,category,price,thumbnail,stock,availabilityStatus`,
  pick: row => ({ id: row.id, title: row.title, category: row.category, description: row.description, price: row.price, image: row.thumbnail, stock: row.stock, availabilityStatus: row.availabilityStatus }),
  snapshotPath: path.join(__dirname, 'dummyjson-products.json'),
  owns: productId => productId >= DUMMYJSON_ID_OFFSET,
  toProductId: id => id + DUMMYJSON_ID_OFFSET,
  toLocalId: id => id - DUMMYJSON_ID_OFFSET,
});

module.exports = {
  FakeStoreError, IMAGE_HOSTS, DUMMYJSON_ID_OFFSET, allowedImage, normalizeProduct, createSource,
  sources: [fakestore, dummyjson],
};
