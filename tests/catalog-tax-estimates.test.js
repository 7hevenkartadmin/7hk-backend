import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCatalogProductTax, buildCatalogTaxBackfillPlan } from '../src/modules/catalog/catalog-tax-estimates.js';
import { Product } from '../src/modules/catalog/product.model.js';

const classify = (name, group) => estimateCatalogProductTax({ name }, group);

test('mixed subcategories classify product exceptions rather than using one category rate', () => {
  for (const [name, group, hsn, rate] of [
    ['Dove Shampoo', 'Shampoo & Conditioner', '3305', 5],
    ['Pantene Conditioner', 'Shampoo & Conditioner', '3305', 18],
    ['Godrej Shampoo Hair Colour', 'Hair Color & Hair Dye', '3305', 18],
    ['Dettol Bathing Soap Bar', 'Soap & Baby Soap', '3401', 5],
    ['Godrej Mr. Magic Handwash', 'Handwash', '3401', 18],
    ['Surf Excel Detergent Bar', 'Dishwash & Dishwash Bar', '3402', 18],
    ['Cadbury Bournvita', 'Growing-Up Nutrition', '1806', 5],
    ['Fiesta Chocolate Flavored Condoms', 'Condoms', '40141000', 0],
    ['Red Bull Energy Drink', 'Glucose & Energy Drinks', '220299', 40],
    ['Amul Badam Shakers', 'Fruit Juice & Cold Drink And Ors', '220299', 5],
    ['Cipla Prolyte ORS', 'Fruit Juice & Cold Drink And Ors', '3004', 5],
    ['Nilon Vinegar', 'Vinegar & Continental Sauce', '2209', 18],
    ['Cooking Soda', 'Besan & Other Flours', '283630', 18],
    ['Harpic Toilet Cleaner', 'Toilet & Bathroom Cleaner', '3402', 18],
    ['Moksh Metal Shining Powder', 'Agarbatti / Incense Sticks', '3405', 18],
    ['Home Light Matchbox', 'Agarbatti / Incense Sticks', '36050010', 5],
    ['Hydroquinone Tretinoin Cream', 'Cosmetics & Skincare And Eye Makeup', '3004', 5],
    ['Shaving Brush', 'Shaving & Grooming', '9603', 18],
    ['Shaving Cream', 'Shaving & Grooming', '3307', 5],
    ['Whisper Sanitary Pads', 'Sanitary Pads', '96190010', 0],
    ['Pampers Diapers', 'Baby Diapers', '96190030', 5],
  ]) {
    const result = classify(name, group);
    assert.equal(result.hsnCode, hsn, name); assert.equal(result.taxRate, rate, name);
    assert.equal(result.blocked, false, name);
  }
});

test('unknown groups fail closed and cigarettes retain the special valuation block', () => {
  assert.equal(classify('Unknown', 'Future mixed category'), null);
  assert.throws(() => buildCatalogTaxBackfillPlan([{ _id: 'p1', name: 'Unknown', category: 'Future' }], []), /No reviewed catalog rule/);
  const cigarette = classify('Classic Cigarettes', 'Cigarettes');
  assert.equal(cigarette.hsnCode, '2402'); assert.equal(cigarette.taxRate, 40); assert.equal(cigarette.blocked, true);
});

test('backfill preserves verified classifications, corrects noodles test rate, and is idempotent', () => {
  const categories = [{ _id: 'c1', parent: 'root', name: 'Instant Noodles', hsnCode: '1902', taxRate: 12 },
    { _id: 'c2', parent: 'root', name: 'Shampoo & Conditioner', hsnCode: '', taxRate: null }];
  const products = [{ _id: 'p1', name: 'Maggie Noodles', subcategoryRef: 'c1', hsnCode: '1902', taxRate: 12, taxStatus: 'verified' },
    { _id: 'p2', name: 'Dove Shampoo', subcategoryRef: 'c2', hsnCode: '33051000', taxRate: 5, taxStatus: 'verified' },
    { _id: 'p3', name: 'Hair Conditioner', subcategoryRef: 'c2', hsnCode: '', taxRate: 0, taxStatus: 'review' }];
  const original = structuredClone({ products, categories });
  const plan = buildCatalogTaxBackfillPlan(products, categories);
  assert.deepEqual({ products, categories }, original);
  assert.deepEqual(plan.categoryChanges.map((row) => row.set), [{ hsnCode: '1902', taxRate: 5 }]);
  assert.equal(plan.productChanges.length, 2);
  assert.equal(plan.coverage.find((row) => row.id === 'p2').hsnCode, '33051000');
  assert.equal(plan.coverage.find((row) => row.id === 'p2').status, 'verified');
  assert.equal(plan.productChanges.find((row) => row.id === 'p1').set.taxOrigin, 'subcategory');
  assert.equal(plan.productChanges.find((row) => row.id === 'p3').set.taxOrigin, 'override');
  for (const change of plan.productChanges) Object.assign(products.find((row) => row._id === change.id), change.set);
  for (const change of plan.categoryChanges) Object.assign(categories.find((row) => row._id === change.id), change.set);
  const rerun = buildCatalogTaxBackfillPlan(products, categories);
  assert.equal(rerun.productChanges.length, 0); assert.equal(rerun.categoryChanges.length, 0);
  assert.ok(Product.schema.path('taxStatus').enumValues.includes('estimated'));
});
