import 'dotenv/config';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildCatalogTaxBackfillPlan, CATALOG_TAX_SOURCES } from '../modules/catalog/catalog-tax-estimates.js';

const apply = process.argv.includes('--apply');
const previewArgument = process.argv.find((arg) => arg.startsWith('--preview='));
if (apply && !previewArgument) throw new Error('Apply requires --preview=<directory> from a completed dry run');
const productTaxFields = new Set(['hsnCode', 'taxRate', 'taxOrigin', 'taxProfile', 'taxStatus', 'taxSource', 'taxReviewedAt', 'taxReviewReason', 'updatedAt']);
const categoryTaxFields = new Set(['hsnCode', 'taxRate', 'updatedAt']);
const json = (value) => EJSON.stringify(value, { relaxed: false });
const digest = (value) => createHash('sha256').update(json(value)).digest('hex');
const without = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.has(key)));
const financialProjection = { items: 1, pricingVersion: 1, subtotal: 1, discount: 1, total: 1,
  tax: 1, productTax: 1, deliveryTax: 1, deliveryTaxRate: 1, deliveryFee: 1,
  taxableValue: 1, cgst: 1, sgst: 1, invoice: 1, invoiceNumber: 1 };
const snapshot = (rows) => Object.fromEntries(rows.map((row) => [String(row._id), digest(row)]));

async function readCatalog(db, session) {
  const options = session ? { session } : {};
  const products = await db.collection('products').find({}, options).sort({ _id: 1 }).toArray();
  const categories = await db.collection('categories').find({}, options).sort({ _id: 1 }).toArray();
  return { products, categories };
}

async function readHistoricalFingerprints(db, session) {
  const options = session ? { session } : {};
  const orders = await db.collection('orders').find({}, { ...options, projection: financialProjection }).sort({ _id: 1 }).toArray();
  const documents = await db.collection('taxdocuments').find({}, options).sort({ _id: 1 }).toArray();
  return { orders: snapshot(orders), documents: snapshot(documents) };
}

function assertSnapshotsUnchanged(before, after, label) {
  for (const [id, value] of Object.entries(before)) assert.equal(after[id], value, `${label} changed: ${id}`);
}

function summarize(plan, database, directory) {
  const rates = {};
  for (const row of plan.coverage) rates[row.taxRate] = (rates[row.taxRate] || 0) + 1;
  return { database, totalProducts: plan.coverage.length, productsToUpdate: plan.productChanges.length,
    verifiedRetained: plan.coverage.filter((row) => row.status === 'verified').length,
    estimated: plan.coverage.filter((row) => row.status === 'estimated').length,
    blockedSpecialValuation: plan.coverage.filter((row) => row.status === 'review').length,
    subcategoryDefaultsToUpdate: plan.categoryChanges.length, rates, preview: directory, applied: apply };
}

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
try {
  const db = mongoose.connection.db;
  const directory = previewArgument ? resolve(previewArgument.slice('--preview='.length))
    : resolve(fileURLToPath(new URL('../../../tmp/tax-catalog/', import.meta.url)), `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let backup;
  let plan;
  if (!apply) {
    const catalog = await readCatalog(db);
    const historical = await readHistoricalFingerprints(db);
    plan = buildCatalogTaxBackfillPlan(catalog.products, catalog.categories);
    assert.equal(new Set(plan.coverage.map((row) => row.id)).size, catalog.products.length);
    for (const row of plan.coverage) {
      assert.match(row.hsnCode, /^(?:\d{4}|\d{6}|\d{8})$/);
      assert.ok([0, 5, 18, 40].includes(row.taxRate), `Unexpected estimated rate: ${row.name}`);
    }
    backup = { database: db.databaseName, createdAt: new Date(), ...catalog, historical };
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'backup.ejson'), EJSON.stringify(backup, null, 2, { relaxed: false }));
    await writeFile(resolve(directory, 'preview.json'), JSON.stringify({ ...plan, sources: CATALOG_TAX_SOURCES }, null, 2));
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ database: db.databaseName,
      catalogHash: digest(catalog), planHash: digest(plan) }, null, 2));
    console.log(JSON.stringify(summarize(plan, db.databaseName, directory)));
  } else {
    backup = EJSON.parse(await readFile(resolve(directory, 'backup.ejson'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    const savedPreview = JSON.parse(await readFile(resolve(directory, 'preview.json'), 'utf8'));
    const savedPlan = { ...savedPreview };
    delete savedPlan.sources;
    assert.equal(db.databaseName, backup.database, 'Backup belongs to a different database');
    assert.equal(db.databaseName, manifest.database);
    plan = buildCatalogTaxBackfillPlan(backup.products, backup.categories);
    assert.equal(digest(plan), manifest.planHash, 'Classification rules changed after preview; create a new dry run');
    assert.deepEqual(plan, savedPlan, 'Preview was changed after dry run');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const catalog = await readCatalog(db, session);
        assert.equal(digest(catalog), manifest.catalogHash, 'Catalog changed after preview; create a new dry run');
        const beforeProducts = new Map(catalog.products.map((row) => [String(row._id), row]));
        const beforeCategories = new Map(catalog.categories.map((row) => [String(row._id), row]));
        const now = new Date();
        if (plan.categoryChanges.length) {
          const result = await db.collection('categories').bulkWrite(plan.categoryChanges.map((row) => ({ updateOne: {
            filter: { _id: beforeCategories.get(row.id)._id }, update: { $set: { ...row.set, updatedAt: now } },
          } })), { session, ordered: true });
          assert.equal(result.matchedCount, plan.categoryChanges.length);
        }
        if (plan.productChanges.length) {
          const result = await db.collection('products').bulkWrite(plan.productChanges.map((row) => ({ updateOne: {
            filter: { _id: beforeProducts.get(row.id)._id }, update: { $set: { ...row.set, updatedAt: now } },
          } })), { session, ordered: true });
          assert.equal(result.matchedCount, plan.productChanges.length);
        }
        const after = await readCatalog(db, session);
        assert.equal(after.products.length, catalog.products.length);
        assert.equal(after.categories.length, catalog.categories.length);
        for (const row of after.products) {
          assert.equal(digest(without(row, productTaxFields)), digest(without(beforeProducts.get(String(row._id)), productTaxFields)), `Non-tax product fields changed: ${row._id}`);
          assert.match(row.hsnCode, /^(?:\d{4}|\d{6}|\d{8})$/);
          assert.ok([0, 5, 18, 40].includes(row.taxRate));
          const expected = plan.coverage.find((item) => item.id === String(row._id));
          assert.equal(row.hsnCode, expected.hsnCode);
          assert.equal(row.taxRate, expected.taxRate);
          assert.equal(row.taxStatus, expected.status);
        }
        for (const row of after.categories) assert.equal(digest(without(row, categoryTaxFields)), digest(without(beforeCategories.get(String(row._id)), categoryTaxFields)), `Non-tax category fields changed: ${row._id}`);
        const historical = await readHistoricalFingerprints(db, session);
        assertSnapshotsUnchanged(backup.historical.orders, historical.orders, 'Historical order amounts');
        assertSnapshotsUnchanged(backup.historical.documents, historical.documents, 'Issued tax document');
        assert.equal(buildCatalogTaxBackfillPlan(after.products, after.categories).productChanges.length, 0, 'Backfill must be idempotent');
        await db.collection('auditlogs').insertOne({ action: 'catalog.tax.estimated-backfill', actorRole: 'migration',
          entityType: 'Product', entityId: 'catalogue', after: summarize(plan, db.databaseName, directory),
          metadata: { version: plan.version, planHash: manifest.planHash, backup: resolve(directory, 'backup.ejson'),
            historicalOrdersUnchanged: true, taxDocumentsUnchanged: true, pricesAndStockUnchanged: true }, createdAt: now, updatedAt: now }, { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    const catalog = await readCatalog(db);
    const historical = await readHistoricalFingerprints(db);
    assertSnapshotsUnchanged(backup.historical.orders, historical.orders, 'Historical order amounts');
    assertSnapshotsUnchanged(backup.historical.documents, historical.documents, 'Issued tax document');
    assert.equal(buildCatalogTaxBackfillPlan(catalog.products, catalog.categories).productChanges.length, 0);
    const verification = { ...summarize(plan, db.databaseName, directory), missingHsn: catalog.products.filter((row) => !row.hsnCode).length,
      pricesAndStockUnchanged: true, historicalOrdersUnchanged: true, historicalTaxDocumentsUnchanged: true,
      historicalOrderCount: Object.keys(backup.historical.orders).length, historicalTaxDocumentCount: Object.keys(backup.historical.documents).length };
    await writeFile(resolve(directory, 'verification.json'), JSON.stringify(verification, null, 2));
    console.log(JSON.stringify(verification));
  }
} finally { await mongoose.disconnect(); }
