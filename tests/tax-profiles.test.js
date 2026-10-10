import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestExistingProduct } from '../src/modules/catalog/tax-profiles.js';

test('classification excludes misleading names, bundles and medicines', () => {
  for (const name of ['Nut Cracker', 'Fiesta Chocolate Flavored Condoms', 'Comfort Fabric Conditioner', 'Godrej Shampoo Hair Colour', 'Mediker Anti-Lice Treatment Shampoo', 'Peanut Butter', 'Everest Paneer Butter Masala', 'Dant Kanti Toothpaste Free Brush', 'Baby Milk Powder Stage 1']) {
    assert.equal(suggestExistingProduct({ name }), null, name);
  }
  assert.equal(suggestExistingProduct({ name: '2-Minute Masala Noodles' }).hsnCode, '1902');
  assert.equal(suggestExistingProduct({ name: 'Streax Hair Serum' }).taxRate, 18);
  assert.equal(suggestExistingProduct({ name: 'Dove Shampoo' }).taxRate, 5);
});

