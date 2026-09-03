import test from 'node:test';
import assert from 'node:assert/strict';
import { Product } from '../src/modules/catalog/product.model.js';
import { searchSuggestions } from '../src/modules/catalog/catalog.service.js';

function withStubs(stubs, callback) {
  const originals = stubs.map(({ object, method }) => ({ object, method, value: object[method] }));
  stubs.forEach(({ object, method, implementation }) => { object[method] = implementation; });
  return Promise.resolve().then(callback).finally(() => {
    originals.forEach(({ object, method, value }) => { object[method] = value; });
  });
}

test('search suggestions use the matching active variant image', async () => {
  let pipeline;
  const product = {
    _id: 'product-1',
    name: 'Rose Falooda Mix',
    brand: 'Weikfield',
    image: 'rose.webp',
    tags: ['kesar pista'],
    isActive: true,
    variants: [
      { _id: 'rose', title: 'Rose', unit: '200 g', sku: 'ROSE-200', price: 80, mrp: 90, stock: 4, reservedStock: 0, images: ['rose.webp'], isActive: true, isDefault: true },
      { _id: 'kesar', title: 'Kesar Pista Flavoured', unit: '200 g', sku: 'KESAR-200', price: 85, mrp: 95, stock: 3, reservedStock: 0, images: ['kesar.webp'], isActive: true },
    ],
  };

  await withStubs([
    { object: Product, method: 'aggregate', implementation: async (value) => { pipeline = value; return [product]; } },
    { object: Product, method: 'countDocuments', implementation: async () => 1 },
    { object: Product, method: 'populate', implementation: async (items) => items },
  ], async () => {
    const result = await searchSuggestions({ q: 'kesar pista', limit: 8 });
    const tag = result.suggestions.find((suggestion) => suggestion.keyword === 'kesar pista');
    const variant = result.suggestions.find((suggestion) => suggestion.kind === 'variant');

    assert.equal(tag.image, 'kesar.webp');
    assert.equal(variant.keyword, 'Kesar Pista Flavoured');
    assert.equal(variant.image, 'kesar.webp');
    assert.equal(JSON.stringify(pipeline).includes('variants.title'), true);
  });
});

