import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
try {
  if (!process.env.MONGODB_URI) throw new Error('Database configuration missing');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const [products, categories] = await Promise.all([
    db.collection('products').find({}, { projection: { name: 1, description: 1, brand: 1, category: 1, categoryRef: 1, subcategoryRef: 1, unit: 1, hsnCode: 1, taxRate: 1, taxProfile: 1, taxStatus: 1, variants: 1, isActive: 1 } }).toArray(),
    db.collection('categories').find({}, { projection: { name: 1, slug: 1, parent: 1, hsnCode: 1, taxRate: 1 } }).toArray(),
  ]);
  await mkdir('../tmp/tax-catalog', { recursive: true });
  await writeFile('../tmp/tax-catalog/catalog.json', JSON.stringify({ database: db.databaseName, exportedAt: new Date(), products, categories }, null, 2));
  const names = new Map(categories.map((item) => [String(item._id), item.name]));
  const groups = {};
  for (const product of products) {
    const key = names.get(String(product.subcategoryRef)) || product.category;
    (groups[key] ||= []).push(product.name);
  }
  await writeFile('../tmp/tax-catalog/groups.json', JSON.stringify(groups, null, 2));
  console.log(JSON.stringify({ database: db.databaseName, products: products.length, groups: Object.fromEntries(Object.entries(groups).map(([name, values]) => [name, values.length])) }, null, 2));
} catch (error) {
  console.error(`Catalog export failed (${error.name}); check database connectivity.`);
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
