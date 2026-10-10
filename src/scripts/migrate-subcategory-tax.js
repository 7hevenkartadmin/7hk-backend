import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findTaxProfile } from '../modules/catalog/tax-profiles.js';

// Converts the previous suggestion keys into explicit defaults, without touching products/orders.
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
try {
  const db = mongoose.connection.db;
  const categories = await db.collection('categories').find({}).toArray();
  const productTax = await db.collection('products').find({}, { projection: { hsnCode: 1, taxRate: 1, taxStatus: 1, taxProfile: 1 } }).toArray();
  const changes = categories.map((category) => {
    const profile = category.parent && findTaxProfile(category.defaultTaxProfile);
    const unconfigured = !category.hsnCode && (category.taxRate === null || category.taxRate === undefined);
    const set = profile && unconfigured ? { hsnCode: profile.hsnCode, taxRate: profile.taxRate } : {};
    return { category, set, removeProfile: Object.hasOwn(category, 'defaultTaxProfile') };
  }).filter((row) => Object.keys(row.set).length || row.removeProfile);
  const dir = resolve('../tmp/tax-catalog', `subcategory-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'backup.json'), JSON.stringify({ database: db.databaseName, categories, productTax }, null, 2));
  await writeFile(resolve(dir, 'preview.json'), JSON.stringify(changes.map((row) => ({ id: String(row.category._id), name: row.category.name, defaults: row.set })), null, 2));
  const summary = { database: db.databaseName, defaultsConverted: changes.filter((row) => Object.keys(row.set).length).length, retiredKeys: changes.filter((row) => row.removeProfile).length, backup: dir };
  if (process.argv.includes('--apply')) {
    for (const { category, set, removeProfile } of changes) {
      const update = {};
      if (Object.keys(set).length) update.$set = { ...set, updatedAt: new Date() };
      if (removeProfile) update.$unset = { defaultTaxProfile: '' };
      const result = await db.collection('categories').updateOne({ _id: category._id, updatedAt: category.updatedAt ?? { $exists: false } }, update);
      if (!result.matchedCount) throw new Error(`Concurrent category change: ${category._id}`);
    }
    const afterTax = await db.collection('products').find({}, { projection: { hsnCode: 1, taxRate: 1, taxStatus: 1, taxProfile: 1 } }).toArray();
    const unchanged = JSON.stringify(productTax) === JSON.stringify(afterTax);
    if (!unchanged) throw new Error('Product classifications changed during migration; inspect the saved backup');
    await db.collection('auditlogs').insertOne({ action: 'category.tax-defaults.migrate', entityType: 'Category', entityId: 'catalogue', actorRole: 'migration', after: summary, createdAt: new Date(), updatedAt: new Date() });
    await writeFile(resolve(dir, 'verification.json'), JSON.stringify({ ...summary, productClassificationsUnchanged: unchanged }, null, 2));
    summary.productClassificationsUnchanged = unchanged;
  }
  console.log(JSON.stringify({ ...summary, applied: process.argv.includes('--apply') }));
} finally { await mongoose.disconnect(); }
