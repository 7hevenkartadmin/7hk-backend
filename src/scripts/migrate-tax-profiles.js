import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { suggestExistingProduct } from '../modules/catalog/tax-profiles.js';

if (process.argv.includes('--apply')) throw new Error('Profile migration is retired. Use migrate:subcategory-tax for the current HSN/GST defaults workflow.');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
try {
  const db = mongoose.connection.db;
  const products = await db.collection('products').find({}).toArray();
  const categories = await db.collection('categories').find({}).toArray();
  const changes = products.map((product) => {
    const profile = suggestExistingProduct(product);
    const conflict = product.hsnCode && (product.hsnCode !== profile?.hsnCode || product.taxRate !== profile?.taxRate);
    const set = product.taxStatus === 'verified' ? { taxStatus: 'verified', taxProfile: product.taxProfile || '', taxReviewReason: '' } : profile && !conflict ? {
      hsnCode: profile.hsnCode, taxRate: profile.taxRate, taxProfile: profile.key,
      taxStatus: 'verified', taxSource: profile.sourceUrl, taxReviewedAt: new Date(), taxReviewReason: '',
    } : { taxStatus: 'review', taxReviewReason: conflict ? 'Existing manual classification conflicts with suggested profile' : 'Verify composition, packaging and supplier invoice before classification' };
    return { id: String(product._id), name: product.name, before: { hsnCode: product.hsnCode, taxRate: product.taxRate }, set };
  });
  const dir = resolve('../tmp/tax-catalog', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'backup.json'), JSON.stringify({ database: db.databaseName, products, categories }, null, 2));
  await writeFile(resolve(dir, 'preview.json'), JSON.stringify(changes, null, 2));
  const verified = changes.filter((row) => row.set.taxStatus === 'verified').length;
  console.log(JSON.stringify({ database: db.databaseName, products: changes.length, verified, review: changes.length - verified, backup: dir, applied: process.argv.includes('--apply') }));
  if (process.argv.includes('--apply')) {
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      const filter = { _id: product._id, updatedAt: product.updatedAt ?? { $exists: false } };
      const result = await db.collection('products').updateOne(filter, { $set: { ...changes[index].set, updatedAt: new Date() } });
      if (!result.matchedCount) throw new Error(`Concurrent change: ${product._id}`);
    }
    let suggestions = 0;
    for (const category of categories.filter((item) => item.parent)) {
      const children = changes.filter((row, index) => String(products[index].subcategoryRef) === String(category._id));
      const keys = new Set(children.map((row) => row.set.taxProfile).filter(Boolean));
      if (children.length && children.every((row) => row.set.taxStatus === 'verified') && keys.size === 1) {
        await db.collection('categories').updateOne({ _id: category._id }, { $set: { defaultTaxProfile: [...keys][0] } });
        suggestions += 1;
      }
    }
    await db.collection('auditlogs').insertOne({ action: 'catalog.tax.migrate', entityType: 'Product', entityId: 'catalogue', actorRole: 'migration', createdAt: new Date(), metadata: { backup: dir, verified, review: changes.length - verified, suggestions } });
    console.log(JSON.stringify({ updated: changes.length, subcategorySuggestions: suggestions }));
  }
} finally { await mongoose.disconnect(); }
