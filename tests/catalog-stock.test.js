import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicProduct } from '../src/modules/catalog/catalog.service.js';

test('public products expose availability without leaking exact inventory', () => {
  const product = {
    stock: 18,
    variants: [
      { _id: 'default', isDefault: true, isActive: true, stock: 0 },
      { _id: 'large', isActive: true, stock: 7 },
    ],
  };

  const result = toPublicProduct(product);

  assert.equal(result.stock, undefined);
  assert.equal(result.reservedStock, undefined);
  assert.equal(result.isAvailable, true);
  assert.equal(result.variants[0].stock, undefined);
  assert.equal(result.variants[0].isAvailable, false);
  assert.equal(result.variants[1].stock, undefined);
  assert.equal(result.variants[1].isAvailable, true);
  assert.equal(product.variants[0].stock, 0);
});

test('public products without variants expose aggregate and default availability', () => {
  assert.deepEqual(toPublicProduct({ stock: 9, reservedStock: 2, variants: [] }), {
    isAvailable: true,
    defaultVariantId: undefined,
    defaultVariantAvailable: true,
    variants: [],
  });
});
