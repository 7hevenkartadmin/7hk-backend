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
  assert.equal(result.maxOrderableQuantity, 0);
  assert.equal(result.defaultVariantMaxOrderableQuantity, 0);
  assert.equal(result.variants[0].stock, undefined);
  assert.equal(result.variants[0].isAvailable, false);
  assert.equal(result.variants[0].maxOrderableQuantity, 0);
  assert.equal(result.variants[1].stock, undefined);
  assert.equal(result.variants[1].isAvailable, true);
  assert.equal(result.variants[1].maxOrderableQuantity, 7);
  assert.equal(product.variants[0].stock, 0);
});

test('public products without variants expose aggregate and default availability', () => {
  assert.deepEqual(toPublicProduct({ stock: 19, reservedStock: 2, variants: [] }), {
    isAvailable: true,
    maxOrderableQuantity: 10,
    defaultVariantId: undefined,
    defaultVariantAvailable: true,
    defaultVariantMaxOrderableQuantity: 10,
    variants: [],
  });
});

test('inactive public variants are never orderable even when on-hand stock exists', () => {
  const result = toPublicProduct({
    isActive: true,
    stock: 50,
    reservedStock: 0,
    variants: [{ _id: 'inactive', isDefault: true, isActive: false, stock: 50, reservedStock: 0 }],
  });

  assert.equal(result.isAvailable, false);
  assert.equal(result.variants[0].isAvailable, false);
  assert.equal(result.variants[0].maxOrderableQuantity, 0);
  assert.equal(result.maxOrderableQuantity, 0);
});
