import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTaxDefaults, normalizeCategoryTax, productNeedsTaxDefaults, resolveProductTax } from '../src/modules/catalog/catalog.tax.js';
import { categorySchema, productSchema } from '../src/modules/catalog/catalog.validation.js';
import { Category } from '../src/modules/catalog/category.model.js';
import { Product } from '../src/modules/catalog/product.model.js';
import { createProduct, updateProduct } from '../src/modules/catalog/catalog.service.js';

const defaults = { _id: '111111111111111111111111', parent: '222222222222222222222222', hsnCode: '0402', taxRate: 5 };

test('new products copy subcategory defaults and preserve leading-zero HSN', () => {
  const result = resolveProductTax({ name: 'Sample', subcategoryRef: defaults._id }, null, defaults);
  assert.equal(result.hsnCode, '0402');
  assert.equal(result.taxRate, 5);
  assert.equal(result.taxOrigin, 'subcategory');
  assert.equal(result.taxStatus, 'verified');
  assert.equal(result.taxMode, undefined);
});

test('explicit product overrides do not use category tax values', () => {
  const result = resolveProductTax({ taxMode: 'override', hsnCode: '1902', taxRate: 12 }, null, defaults);
  assert.equal(result.hsnCode, '1902');
  assert.equal(result.taxRate, 12);
  assert.equal(result.taxOrigin, 'override');
  const reset = resolveProductTax({ taxMode: 'subcategory', hsnCode: '1902', taxRate: 18 }, result, defaults);
  assert.equal(reset.hsnCode, '0402');
  assert.equal(reset.taxRate, 5);
});

test('zero GST is configured while absent defaults remain pending', () => {
  assert.equal(hasTaxDefaults({ hsnCode: '0402', taxRate: 0 }), true);
  assert.equal(hasTaxDefaults({ hsnCode: '0402', taxRate: null }), false);
  assert.equal(resolveProductTax({}, null, { ...defaults, taxRate: 0 }).taxStatus, 'verified');
  const pending = resolveProductTax({}, null, { hsnCode: '', taxRate: null });
  assert.equal(pending.taxStatus, 'review');
  assert.equal(pending.hsnCode, '');
  assert.equal(categorySchema.shape.taxRate.parse(null), null);
  assert.equal(productSchema.shape.taxRate.parse(undefined), undefined);
  assert.equal(new Category({ name: 'Empty', slug: 'empty' }).taxRate, null);
});

test('saved products and unrelated updates preserve their tax snapshots', () => {
  const existing = { subcategoryRef: defaults._id, hsnCode: '0402', taxRate: 5, taxOrigin: 'subcategory' };
  assert.deepEqual(resolveProductTax({ price: 20 }, existing, { ...defaults, taxRate: 18 }), { price: 20 });
  assert.deepEqual(resolveProductTax({ taxMode: 'preserve', hsnCode: '9999', taxRate: 18, price: 20 }, existing), { price: 20 });
  assert.equal(productNeedsTaxDefaults({ stock: 10 }, existing), false);
  assert.equal(productNeedsTaxDefaults({ subcategoryRef: 'other' }, existing), true);
  assert.equal(productNeedsTaxDefaults({ subcategoryRef: 'other' }, { ...existing, taxOrigin: 'override' }), false);
});

test('category updates validate complete defaults without overwriting product data', () => {
  assert.deepEqual(normalizeCategoryTax({ parent: defaults.parent, hsnCode: '0402', taxRate: 0 }), { parent: defaults.parent, hsnCode: '0402', taxRate: 0 });
  assert.deepEqual(normalizeCategoryTax({ isActive: false }, defaults), { isActive: false });
  assert.deepEqual(normalizeCategoryTax({ taxRate: 18 }, defaults), { taxRate: 18, hsnCode: '0402' });
  assert.throws(() => normalizeCategoryTax({ parent: defaults.parent, hsnCode: '0402', taxRate: null }), /HSN/);
  assert.throws(() => normalizeCategoryTax({ hsnCode: '0402', taxRate: 5 }), /subcategory/);
  assert.throws(() => resolveProductTax({ taxMode: 'override', hsnCode: 'abc', taxRate: 5 }), /HSN/);
  assert.throws(() => resolveProductTax({ taxMode: 'override', hsnCode: '1902', taxRate: -1 }), /GST/);
  assert.throws(() => resolveProductTax({ taxMode: 'preserve' }), /New products/);
});

test('product create/update services persist inheritance and do not reread defaults on price edits', async () => {
  const original = { find: Category.find, findById: Category.findById, create: Product.create, productFindById: Product.findById };
  const parent = { _id: defaults.parent, parent: null, slug: 'parent' };
  let saved;
  let taxReads = 0;
  Category.find = async () => [parent, defaults];
  Category.findById = async () => { taxReads += 1; return defaults; };
  Product.create = async (payload) => {
    saved = { ...payload, _id: '333333333333333333333333', variants: [], populate: async function () { return this; }, set(update) { Object.assign(this, update); }, async save() {} };
    return saved;
  };
  Product.findById = async () => saved;
  try {
    await createProduct(productSchema.parse({ name: 'Sample', category: 'parent', categoryRef: defaults.parent, subcategoryRef: defaults._id, mrp: 20, price: 20, unit: '1 pack' }));
    assert.equal(saved.hsnCode, '0402');
    assert.equal(saved.taxRate, 5);
    assert.equal(taxReads, 1);
    await updateProduct(String(saved._id), productSchema.partial().parse({ price: 19 }));
    assert.equal(saved.taxRate, 5);
    assert.equal(taxReads, 1);
    await updateProduct(String(saved._id), { taxMode: 'override', hsnCode: '1902', taxRate: 18 });
    assert.equal(saved.taxOrigin, 'override');
    assert.equal(saved.taxRate, 18);
  } finally {
    Category.find = original.find;
    Category.findById = original.findById;
    Product.create = original.create;
    Product.findById = original.productFindById;
  }
});
