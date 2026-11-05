// Read-only client for FakeStoreAPI (https://fakestoreapi.com). No API key.
//
// The API has no text search, so the whole product list (about 20 items) is
// fetched once, cached for a few minutes, and searched here in memory.

const fs = require('fs');
const path = require('path');

const BASE_URL =(process.env.FAKESTORE_URL || 'https://fakestoreapi.com').replace(/\/+$/, '');
const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60 * 1000;

// Messages are safe to show a sponsor.
class FakeStoreError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FakeStoreError';
    this.status = status;
  }
}

let cache = { products: null, expiresAt: 0 };

// Optional local copy of the product list (fakestore/products.json), used only
// when the live service can't be reached or refuses the request. Save it from
// a machine where the API works:  curl https://fakestoreapi.com/products -o fakestore/products.json
const SNAPSHOT_PATH = path.join(__dirname, 'products.json');
const SNAPSHOT_RETRY_MS = 60 * 1000; // while on the snapshot, try the live service again after a minute

function readSnapshot() {
  try {
    const body = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const products = Array.isArray(body) ? body.map(normalize).filter(Boolean) : [];
    return products.length ? products : null;
  } catch (err) {
    return null;
  }
}

// Called when the live fetch fails: a still-held cache wins, then the local
// snapshot, and only then does the caller see the error.
function fallbackOrThrow(error) {
  if (cache.products) return cache.products;
  const snapshot = readSnapshot();
  if (snapshot) {
    console.warn(`[fakestore] live request failed (${error.message}); serving products.json`);
    cache = { products: snapshot, expiresAt: Date.now() + SNAPSHOT_RETRY_MS };
    return snapshot;
  }
  throw error;
}

const httpsOnly = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

// Keeps only what the catalogue needs; drops anything missing an id, title or
// a usable price so the page never shows half a product.
function normalize(raw) {
  if (!raw || !Number.isInteger(raw.id) || raw.id < 1) return null;
  const price = Number(raw.price);
  if (typeof raw.title !== 'string' || !raw.title.trim() || !Number.isFinite(price) || price < 0) return null;
  return {
    productId: raw.id,
    title: raw.title.trim().slice(0, 500),
    category: typeof raw.category === 'string' ? raw.category.slice(0, 100) : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    imageUrl: httpsOnly(raw.image),
    priceValue: price,
  };
}

async function listProducts() {
  if (cache.products && Date.now() < cache.expiresAt) return cache.products;

  let res;
  try {
    res = await fetch(`${BASE_URL}/products`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; GoodDriverProgram/1.0)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fallbackOrThrow(new FakeStoreError('Could not reach the product service. Try again in a moment.'));
  }
  if (!res.ok) {
    return fallbackOrThrow(new FakeStoreError(`The product service returned an error (${res.status}).`));
  }

  let body;
  try { body = await res.json(); } catch (err) { body = null; }
  if (!Array.isArray(body)) return fallbackOrThrow(new FakeStoreError('The product service returned an unexpected response.'));

  cache = { products: body.map(normalize).filter(Boolean), expiresAt: Date.now() + CACHE_MS };
  return cache.products;
}

async function listCategories() {
  const products = await listProducts();
  return [...new Set(products.map((p) => p.category).filter(Boolean))].sort();
}

// q matches title, description or category (case-insensitive); category is an
// exact match. Both are optional and combine with AND.
async function searchProducts({ q = '', category = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return (await listProducts()).filter((p) => {
    if (category && p.category !== category) return false;
    if (!needle) return true;
    return [p.title, p.description, p.category].some((field) => field.toLowerCase().includes(needle));
  });
}

async function getProduct(productId) {
  const product = (await listProducts()).find((p) => p.productId === productId);
  if (!product) throw new FakeStoreError('That product is no longer available.', 404);
  return product;
}

module.exports = {
  listProducts, listCategories, searchProducts, getProduct, FakeStoreError,
  _resetCache: () => { cache = { products: null, expiresAt: 0 }; },
};
