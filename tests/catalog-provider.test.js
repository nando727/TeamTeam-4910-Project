// The product provider: FakeStore and DummyJSON merged, cached for a few
// minutes, with a stale cache or a local snapshot standing in when a service
// cannot be reached. Sprint 9 added DummyJSON with offset ids and a committed
// snapshot; the FakeStore behaviour below is unchanged from sprint 7.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const provider = require('../src/fakestore/client');
const { DUMMYJSON_ID_OFFSET, allowedImage, normalizeProduct } = require('../src/products/sources');

const FAKESTORE = [{ id: 3, title: 'Reward', price: 5, category: 'gear', image: 'https://fakestoreapi.com/img/3.png' }];
const DUMMY = { products: [{ id: 3, title: 'Mascara', price: 9.99, category: 'beauty', thumbnail: 'https://cdn.dummyjson.com/x/thumbnail.webp' }] };

// fetch answers per service, so one can fail while the other works.
let answers;
let fetchMock;
beforeEach(() => {
  provider._resetCache();
  answers = { fakestore: () => ({ ok: true, json: async () => FAKESTORE }), dummyjson: () => ({ ok: true, json: async () => DUMMY }) };
  fetchMock = vi.fn(async url => {
    const which = url.includes('dummyjson') ? 'dummyjson' : 'fakestore';
    const answer = answers[which]();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { provider._resetCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('merges both services, offsetting DummyJSON ids so they never collide with FakeStore ids', async () => {
  const products = await provider.listProducts({ allowStale: false });
  expect(products.map(p => p.productId).sort((a, b) => a - b)).toEqual([3, 3 + DUMMYJSON_ID_OFFSET]);
  expect(DUMMYJSON_ID_OFFSET).toBe(1000);
  const mascara = products.find(p => p.productId === 1003);
  expect(mascara).toMatchObject({ title: 'Mascara', category: 'beauty', imageUrl: 'https://cdn.dummyjson.com/x/thumbnail.webp', priceValue: 9.99, source: 'dummyjson' });
  expect(await provider.getProduct(3)).toMatchObject({ title: 'Reward', source: 'fakestore' });
  expect(await provider.getProduct(1003)).toMatchObject({ title: 'Mascara' });
  await expect(provider.getProduct(4)).rejects.toMatchObject({ status: 404 });
  await expect(provider.getProduct(1004)).rejects.toMatchObject({ status: 404 });
  // The list is cached: nothing was fetched again for the lookups.
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('search covers both services and categories are merged', async () => {
  expect((await provider.searchProducts({ q: 'masc' })).map(p => p.productId)).toEqual([1003]);
  expect((await provider.searchProducts({ category: 'gear' })).map(p => p.productId)).toEqual([3]);
  expect((await provider.searchProducts({})).map(p => p.title)).toEqual(['Mascara', 'Reward']);
  expect(await provider.listCategories()).toEqual(['beauty', 'gear']);
});

test('drivers reject expired FakeStore data during outages while sponsor fallback remains supported', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  // DummyJSON unreachable from the start, with its snapshot standing in: a
  // FakeStore outage alone must then still be reported for allowStale: false.
  answers.dummyjson = () => new Error('offline');
  const first = await provider.listProducts({ allowStale: false });
  expect(first.some(p => p.productId === 3)).toBe(true);
  expect(first.filter(p => p.source === 'dummyjson').length).toBeGreaterThan(100);
  clock.mockReturnValue(1000000 + 6 * 60 * 1000);
  answers.fakestore = () => new Error('offline');
  await expect(provider.getProduct(3, { allowStale: false })).rejects.toMatchObject({ status: 502 });
  expect(await provider.getProduct(3)).toMatchObject({ title: 'Reward' });
  answers.fakestore = () => ({ ok: false, status: 503 });
  await expect(provider.getProduct(3, { allowStale: false })).rejects.toMatchObject({ status: 502 });
});

test('provider removals are recognized after refreshing the cache', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  await provider.getProduct(3, { allowStale: false });
  clock.mockReturnValue(1000000 + 6 * 60 * 1000);
  answers.fakestore = () => ({ ok: true, json: async () => [] });
  await expect(provider.getProduct(3, { allowStale: false })).rejects.toMatchObject({ status: 404 });
});

test('one service down means its products are missing, not an error; both down is an error', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  answers.fakestore = () => new Error('offline');
  const products = await provider.listProducts({ allowStale: false });
  expect(products.map(p => p.productId)).toEqual([1003]);
  // DummyJSON unreachable too: the committed snapshot answers for it.
  provider._resetCache();
  answers.dummyjson = () => new Error('offline');
  const fromSnapshot = await provider.listProducts({ allowStale: false });
  expect(fromSnapshot.length).toBeGreaterThan(100);
  expect(fromSnapshot.every(p => p.productId > DUMMYJSON_ID_OFFSET && p.imageUrl.startsWith('https://cdn.dummyjson.com/'))).toBe(true);
});

test('the committed DummyJSON snapshot is complete and only uses the allowed image host', () => {
  const rows = JSON.parse(readFileSync(new URL('../src/products/dummyjson-products.json', import.meta.url), 'utf8'));
  expect(rows.length).toBeGreaterThan(150);
  for (const row of rows) {
    expect(Number.isInteger(row.id) && row.id > 0).toBe(true);
    expect(typeof row.title).toBe('string');
    expect(Number.isFinite(row.price)).toBe(true);
    expect(row.thumbnail.startsWith('https://cdn.dummyjson.com/')).toBe(true);
  }
});

test('an image from anywhere but the allowed hosts is dropped, so the policy never blocks a stored URL', () => {
  expect(allowedImage('https://fakestoreapi.com/img/a.png')).toBe('https://fakestoreapi.com/img/a.png');
  expect(allowedImage('https://cdn.dummyjson.com/p/1.webp')).toBe('https://cdn.dummyjson.com/p/1.webp');
  expect(allowedImage('http://fakestoreapi.com/img/a.png')).toBeNull();
  expect(allowedImage('https://fakestoreapi.com.evil.example/a.png')).toBeNull();
  expect(allowedImage('https://i.imgur.com/a.png')).toBeNull();
  expect(normalizeProduct({ id: 1, title: 'x', price: 1, image: 'https://i.imgur.com/a.png' }).imageUrl).toBeNull();
  expect(normalizeProduct({ id: 1, title: ' ', price: 1 })).toBeNull();
  expect(normalizeProduct({ id: 1, title: 'x', price: -1 })).toBeNull();
});
