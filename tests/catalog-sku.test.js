import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { productSchema } from '../src/modules/catalog/catalog.validation.js';
import { Product } from '../src/modules/catalog/product.model.js';
import {
  generateSku,
  isSkuDuplicateKeyError,
  prepareNewProductSkus,
  prepareProductUpdateSkus,
} from '../src/modules/catalog/catalog.sku.js';

function sequenceGenerator(values) {
  let index = 0;
  return () => values[index++];
}

test('backend replaces client SKUs and allocates a distinct SKU to every new variant', () => {
  const prepared = prepareNewProductSkus({
    name: 'Rice',
    sku: 'CLIENT-PRODUCT-SKU',
    variants: [
      { title: '1 kg', unit: '1 kg', sku: 'CLIENT-ONE', isDefault: true },
      { title: '5 kg', unit: '5 kg', sku: 'CLIENT-TWO' },
    ],
  }, { generator: sequenceGenerator(['7HK-FIRST', '7HK-SECOND']) });

  assert.equal(prepared.sku, '7HK-FIRST');
  assert.deepEqual(prepared.variants.map((variant) => variant.sku), ['7HK-FIRST', '7HK-SECOND']);
  assert.equal(new Set(prepared.variants.map((variant) => variant.sku)).size, 2);
});

test('product updates preserve existing SKUs and generate SKUs only for new variants', () => {
  const existingId = new mongoose.Types.ObjectId();
  const prepared = prepareProductUpdateSkus({
    sku: 'CLIENT-ROOT-CHANGE',
    variants: [
      { _id: String(existingId), title: '1 kg', unit: '1 kg', sku: 'CLIENT-CHANGE' },
      { _id: String(new mongoose.Types.ObjectId()), title: '5 kg', unit: '5 kg', sku: 'CLIENT-NEW' },
    ],
  }, [{ _id: existingId, sku: '7HK-EXISTING', reservedStock: 3 }], { generator: () => '7HK-NEWVARIANT' });

  assert.equal(Object.hasOwn(prepared, 'sku'), false);
  assert.equal(prepared.variants[0].sku, '7HK-EXISTING');
  assert.equal(prepared.variants[0].reservedStock, 3);
  assert.equal(prepared.variants[1].sku, '7HK-NEWVARIANT');
  assert.equal(Object.hasOwn(prepared.variants[1], '_id'), false);
});

test('catalog validation strips client-controlled product and variant SKUs', () => {
  const parsed = productSchema.parse({
    name: 'Test Rice',
    category: 'grains',
    mrp: 200,
    price: 180,
    unit: '1 kg',
    sku: 'CLIENT-SKU',
    variants: [{ title: '1 kg', unit: '1 kg', sku: 'CLIENT-VARIANT', mrp: 200, price: 180 }],
  });

  assert.equal(Object.hasOwn(parsed, 'sku'), false);
  assert.equal(Object.hasOwn(parsed.variants[0], 'sku'), false);
});

test('catalog validation explains search tag character and item limits', () => {
  const baseProduct = {
    name: 'Test Rice', category: 'grains', mrp: 200, price: 180, unit: '1 kg',
  };
  const longTag = productSchema.safeParse({ ...baseProduct, tags: ['x'.repeat(121)] });
  assert.equal(longTag.success, false);
  assert.equal(longTag.error.issues[0].message, 'Each search tag can contain at most 120 characters');

  const tooManyTags = productSchema.safeParse({
    ...baseProduct,
    tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
  });
  assert.equal(tooManyTags.success, false);
  assert.equal(tooManyTags.error.issues[0].message, 'You can add at most 20 search tags');
});

test('product model generates a SKU fallback and rejects duplicate SKUs inside one product', async () => {
  const generated = new Product({
    name: 'Generated SKU Product', slug: 'generated-sku-product', category: 'test',
    mrp: 10, price: 9, unit: '1 pc',
  });
  await generated.validate();
  assert.match(generated.sku, /^7HK-[23456789A-HJ-NP-Z]{14}$/);
  assert.equal(generated.variants[0].sku, generated.sku);

  const duplicated = new Product({
    name: 'Duplicate Variant Product', slug: 'duplicate-variant-product', category: 'test',
    mrp: 10, price: 9, unit: '1 pc', sku: '7HK-DUPLICATE',
    variants: [
      { title: 'One', unit: '1 pc', sku: '7HK-DUPLICATE', mrp: 10, price: 9 },
      { title: 'Two', unit: '2 pc', sku: '7hk-duplicate', mrp: 20, price: 18 },
    ],
  });
  await assert.rejects(duplicated.validate(), /Every product variant must have a unique SKU/);
});

test('SKU generator uses the stable inventory format and duplicate errors are scoped to SKU indexes', () => {
  assert.match(generateSku(), /^7HK-[23456789A-HJ-NP-Z]{14}$/);
  assert.equal(isSkuDuplicateKeyError({ code: 11000, keyPattern: { 'variants.sku': 1 } }), true);
  assert.equal(isSkuDuplicateKeyError({ code: 11000, keyPattern: { slug: 1 } }), false);
  const variantIndex = Product.schema.indexes().find(([fields]) => fields['variants.sku'] === 1);
  assert.equal(variantIndex?.[1]?.unique, true);
});
