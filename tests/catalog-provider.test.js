import { createRequire } from 'node:module';
import { afterEach, test, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const provider = require('../src/fakestore/client');
afterEach(() => { provider._resetCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('drivers reject expired provider data during outages while sponsor fallback remains supported', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 3, title: 'Reward', price: 5 }] });
  vi.stubGlobal('fetch', fetch);
  expect(await provider.listProducts({ allowStale: false })).toHaveLength(1);
  clock.mockReturnValue(1000000 + 6 * 60 * 1000);
  fetch.mockRejectedValue(new Error('offline'));
  await expect(provider.listProducts({ allowStale: false })).rejects.toMatchObject({ status: 502 });
  expect(await provider.listProducts()).toHaveLength(1);
  fetch.mockResolvedValue({ ok: false, status: 503 });
  await expect(provider.getProduct(3, { allowStale: false })).rejects.toMatchObject({ status: 502 });
});

test('provider removals are recognized after refreshing the cache', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 3, title: 'Reward', price: 5 }] });
  vi.stubGlobal('fetch', fetch);
  await provider.getProduct(3, { allowStale: false });
  clock.mockReturnValue(1000000 + 6 * 60 * 1000);
  fetch.mockResolvedValue({ ok: true, json: async () => [] });
  await expect(provider.getProduct(3, { allowStale: false })).rejects.toMatchObject({ status: 404 });
});
