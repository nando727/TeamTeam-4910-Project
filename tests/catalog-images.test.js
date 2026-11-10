// Sprint 8: catalog images were blocked by the content security policy. They
// may now load from the product service's host, and a missing or broken image
// shows a "No image" placeholder instead of the browser's broken-image icon.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const ejs = require('ejs');
const { POLICY, PRODUCT_IMAGE_HOST } = require('../src/security-headers');

const partial = new URL('../src/views/partials/product-image.ejs', import.meta.url).pathname;
const render = locals => ejs.renderFile(partial, locals);
const view = path => readFileSync(new URL(`../src/views/${path}`, import.meta.url), 'utf8');

describe('the policy', () => {
  test('allows images from the product service host, which every stored image URL uses', () => {
    expect(PRODUCT_IMAGE_HOST).toBe('https://fakestoreapi.com');
    expect(POLICY).toContain("img-src 'self' data: https://fakestoreapi.com;");
  });
});

describe('the product image partial', () => {
  test('an image URL becomes an image the fallback script watches', async () => {
    const html = await render({ url: 'https://fakestoreapi.com/img/a.png', alt: 'Safety "Jacket"', size: 'card' });
    expect(html).toContain('<img class="product-image product-image--card" src="https://fakestoreapi.com/img/a.png" alt="Safety &#34;Jacket&#34;" loading="lazy" data-fallback>');
  });

  test('no URL shows the placeholder, labelled for screen readers', async () => {
    const html = await render({ url: null, alt: 'Safety Jacket', size: 'detail' });
    expect(html).toContain('<span class="product-image product-image--detail product-image--missing" role="img" aria-label="No image available"><span class="product-image__label">No image</span></span>');
    expect(html).not.toContain('<img');
  });

  test('a thumbnail beside the product name is decorative', async () => {
    const withImage = await render({ url: 'https://fakestoreapi.com/img/a.png', alt: 'ignored', size: 'thumb' });
    expect(withImage).toContain('alt=""');
    const without = await render({ url: '', alt: 'ignored', size: 'thumb' });
    expect(without).toContain('aria-hidden="true"');
  });

  test('every catalog page uses the partial and loads the fallback script', () => {
    for (const path of ['driver/catalog.ejs', 'driver/product.ejs', 'sponsor/catalog.ejs', 'sponsor/buy.ejs']) {
      const source = view(path);
      expect(source).toContain("include('../partials/product-image'");
      expect(source).toContain('<script src="/product-images.js" defer></script>');
      expect(source).not.toMatch(/<img /);
    }
  });

  test('the fallback script swaps a failed image, including one that failed before it ran', () => {
    const script = readFileSync(new URL('../public/product-images.js', import.meta.url), 'utf8');
    expect(script).toContain("img.addEventListener('error'");
    expect(script).toContain('img.complete && img.naturalWidth === 0');
    expect(script).toContain('product-image--missing');
    expect(script).not.toContain('innerHTML');
  });
});
