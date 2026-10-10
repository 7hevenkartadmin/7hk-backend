import 'dotenv/config';
import mongoose from 'mongoose';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const backupPath = process.argv[2];
if (!backupPath) throw new Error('Supply the migration backup.json path');
const backup = JSON.parse(await readFile(backupPath, 'utf8'));
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 });
try {
  const db = mongoose.connection.db;
  if (db.databaseName !== backup.database) throw new Error('Backup belongs to another database');
  const products = await db.collection('products').find({}).toArray();
  const taxFields = new Set(['hsnCode', 'taxRate', 'taxProfile', 'taxStatus', 'taxSource', 'taxReviewedAt', 'taxReviewReason', 'updatedAt']);
  const strip = (row) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !taxFields.has(key)))));
  const before = new Map(backup.products.map((row) => [String(row._id), strip(row)]));
  const changed = products.filter((row) => JSON.stringify(strip(row)) !== JSON.stringify(before.get(String(row._id))));
  const report = {
    database: db.databaseName, total: products.length,
    verified: products.filter((row) => row.taxStatus === 'verified').length,
    review: products.filter((row) => row.taxStatus === 'review').length,
    unchangedNonTaxFields: changed.length === 0 && products.length === before.size,
    unexpectedChanges: changed.map((row) => String(row._id)),
    invalidClassifications: products.filter((row) => row.taxStatus === 'verified' && (!/^(?:\d{4}|\d{6}|\d{8})$/.test(row.hsnCode) || !Number.isFinite(row.taxRate))).map((row) => String(row._id)),
    reviewProducts: products.filter((row) => row.taxStatus === 'review').map((row) => ({ id: String(row._id), name: row.name, reason: row.taxReviewReason })),
  };
  await writeFile(resolve(backupPath, '../verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reviewProducts: report.reviewProducts.length }));
  if (!report.unchangedNonTaxFields || report.invalidClassifications.length) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
