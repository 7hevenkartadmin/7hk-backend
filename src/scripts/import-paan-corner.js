import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import 'dotenv/config';
import { Category } from '../modules/catalog/category.model.js';
import { Product } from '../modules/catalog/product.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogDirectory = path.resolve(__dirname, '../modules/catalog');
const applyChanges = process.argv.includes('--apply');
const CATEGORY_SLUG = 'paan-corner';

function categoryDocument(source, parent = null) {
  return {
    name: source.name,
    slug: source.slug,
    description: source.description || '',
    icon: source.icon || 'ShoppingBasket',
    image: source.image || '',
    parent,
    isActive: source.isActive !== false,
    sortOrder: Number(source.sortOrder || 0),
  };
}

function productDocument(source, categoryRef, subcategoryRef) {
  const product = { ...source, categoryRef, subcategoryRef };
  delete product._id;
  delete product.categorySlug;
  delete product.subcategorySlug;
  return product;
}

async function loadSources() {
  const [categories, products] = await Promise.all([
    fs.readFile(path.join(catalogDirectory, 'categories.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(catalogDirectory, 'products.json'), 'utf8').then(JSON.parse),
  ]);
  const root = categories.find((category) => category.slug === CATEGORY_SLUG && !category.parent);
  if (!root) throw new Error('Paan Corner root category is missing from categories.json');
  const selectedProducts = products.filter((product) => product.categorySlug === CATEGORY_SLUG);
  if (!selectedProducts.length) throw new Error('No Paan Corner products were found in products.json');
  const subcategories = root.subcategories || [];
  const subcategorySlugs = new Set(subcategories.map((subcategory) => subcategory.slug));
  const invalidProducts = selectedProducts.filter((product) => !subcategorySlugs.has(product.subcategorySlug));
  if (invalidProducts.length) {
    throw new Error(`Products reference missing Paan Corner subcategories: ${invalidProducts.map((product) => product.slug).join(', ')}`);
  }
  return { root, subcategories, products: selectedProducts };
}

async function preflight(sources) {
  const sourceSlugs = sources.products.map((product) => product.slug);
  const sourceSkus = sources.products.flatMap((product) => [product.sku, ...(product.variants || []).map((variant) => variant.sku)]).filter(Boolean);
  const [root, subcategories, matchingProducts] = await Promise.all([
    Category.findOne({ slug: CATEGORY_SLUG }).lean(),
    Category.find({ slug: { $in: sources.subcategories.map((subcategory) => subcategory.slug) } }).lean(),
    Product.find({
      $or: [
        { slug: { $in: sourceSlugs } },
        { sku: { $in: sourceSkus } },
        { 'variants.sku': { $in: sourceSkus } },
      ],
    }).select('slug sku variants.sku categoryRef subcategoryRef').lean(),
  ]);

  const conflicts = [];
  const bySlug = new Map(matchingProducts.map((product) => [product.slug, product]));
  const skuOwners = new Map();
  for (const product of matchingProducts) {
    for (const sku of [product.sku, ...(product.variants || []).map((variant) => variant.sku)].filter(Boolean)) {
      skuOwners.set(sku, product.slug);
    }
  }
  for (const product of sources.products) {
    const existing = bySlug.get(product.slug);
    if (existing && existing.sku !== product.sku) conflicts.push(`Slug ${product.slug} already uses SKU ${existing.sku}`);
    for (const sku of [product.sku, ...(product.variants || []).map((variant) => variant.sku)].filter(Boolean)) {
      const owner = skuOwners.get(sku);
      if (owner && owner !== product.slug) conflicts.push(`SKU ${sku} already belongs to ${owner}`);
    }
  }
  if (root?.parent) conflicts.push('Existing paan-corner category is not a root category');
  for (const subcategory of subcategories) {
    if (root && String(subcategory.parent || '') !== String(root._id)) {
      conflicts.push(`Existing subcategory ${subcategory.slug} belongs to another root category`);
    }
  }
  return {
    root,
    existingSubcategories: subcategories,
    existingProducts: sources.products.filter((product) => bySlug.has(product.slug)).length,
    missingProducts: sources.products.filter((product) => !bySlug.has(product.slug)).length,
    conflicts,
  };
}

async function insertMissing(sources) {
  const session = await mongoose.startSession();
  let insertedCategories = 0;
  let insertedProducts = 0;
  try {
    await session.withTransaction(async () => {
      let root = await Category.findOne({ slug: CATEGORY_SLUG }).session(session);
      if (!root) {
        [root] = await Category.create([categoryDocument(sources.root)], { session });
        insertedCategories += 1;
      }

      const categoryBySlug = new Map([[CATEGORY_SLUG, root]]);
      for (const source of sources.subcategories) {
        let subcategory = await Category.findOne({ slug: source.slug }).session(session);
        if (subcategory && String(subcategory.parent || '') !== String(root._id)) {
          throw new Error(`Subcategory ${source.slug} belongs to another root category`);
        }
        if (!subcategory) {
          [subcategory] = await Category.create([categoryDocument(source, root._id)], { session });
          insertedCategories += 1;
        }
        categoryBySlug.set(source.slug, subcategory);
      }

      for (const source of sources.products) {
        if (await Product.exists({ slug: source.slug }).session(session)) continue;
        const conflictingSku = await Product.exists({
          $or: [
            { sku: source.sku },
            { 'variants.sku': { $in: (source.variants || []).map((variant) => variant.sku) } },
          ],
        }).session(session);
        if (conflictingSku) throw new Error(`A SKU for ${source.slug} was inserted concurrently by another process`);
        await Product.create([productDocument(
          source,
          root._id,
          categoryBySlug.get(source.subcategorySlug)._id,
        )], { session });
        insertedProducts += 1;
      }
    });
  } finally {
    await session.endSession();
  }
  return { insertedCategories, insertedProducts };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('Missing MONGODB_URI or MONGO_URI');
  const sources = await loadSources();
  await mongoose.connect(uri);
  const check = await preflight(sources);
  console.log(`Database: ${mongoose.connection.db.databaseName}`);
  console.log(`Source: 1 root, ${sources.subcategories.length} subcategories, ${sources.products.length} products`);
  console.log(`Existing matching products: ${check.existingProducts}`);
  console.log(`Missing products: ${check.missingProducts}`);
  if (check.conflicts.length) {
    throw new Error(`Import blocked by conflicts:\n- ${check.conflicts.join('\n- ')}`);
  }
  if (!applyChanges) {
    console.log('Dry run passed. No database changes were made.');
    console.log('Run again with --apply to insert only missing Paan Corner records.');
    return;
  }
  const result = await insertMissing(sources);
  const verification = await preflight(sources);
  if (verification.conflicts.length || verification.missingProducts) {
    throw new Error('Post-import verification failed');
  }
  console.log(`Inserted categories: ${result.insertedCategories}`);
  console.log(`Inserted products: ${result.insertedProducts}`);
  console.log('Verified: all Paan Corner source products exist; existing catalog records were not overwritten.');
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
