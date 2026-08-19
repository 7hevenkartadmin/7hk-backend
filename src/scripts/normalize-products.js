import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import mongoose from 'mongoose';
import { Product } from '../modules/catalog/product.model.js';

const { EJSON } = mongoose.mongo.BSON;
const DEFAULT_BATCH_SIZE = 50;
const ARTIFACT_DIRECTORY = path.resolve(process.cwd(), 'tmp', 'product-normalization');
const EXCLUDED_SCHEMA_PATHS = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
const NORMALIZED_PATHS = Object.keys(Product.schema.paths)
  .filter((schemaPath) => !EXCLUDED_SCHEMA_PATHS.has(schemaPath));

let stopRequested = false;

function requestStop(signal) {
  stopRequested = true;
  console.error(`\n${signal} received; stopping before the next operation.`);
}

process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));

function printUsage() {
  console.log(`
Usage:
  node src/scripts/normalize-products.js [options]

Default behavior is a read-only dry run.

Options:
  --apply                         Apply validated changes
  --confirm-production            Required with --apply
  --expected-database=<name>       Required with --apply
  --product-id=<id[,id...]>        Restrict to one or more product IDs
  --limit=<number>                 Restrict the number of scanned products
  --batch-size=<number>            Transaction batch size (default: ${DEFAULT_BATCH_SIZE})
  --help                           Show this help
`);
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    apply: false,
    confirmProduction: false,
    expectedDatabase: '',
    productIds: [],
    limit: null,
    batchSize: DEFAULT_BATCH_SIZE,
    help: false,
  };

  for (const argument of argv) {
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--confirm-production') {
      options.confirmProduction = true;
    } else if (argument === '--help') {
      options.help = true;
    } else if (argument.startsWith('--expected-database=')) {
      options.expectedDatabase = argument.slice('--expected-database='.length).trim();
    } else if (argument.startsWith('--product-id=')) {
      const values = argument.slice('--product-id='.length).split(',').map((value) => value.trim()).filter(Boolean);
      options.productIds.push(...values);
    } else if (argument.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(argument.slice('--limit='.length), '--limit');
    } else if (argument.startsWith('--batch-size=')) {
      options.batchSize = parsePositiveInteger(argument.slice('--batch-size='.length), '--batch-size');
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.apply && !options.confirmProduction) {
    throw new Error('--confirm-production is required with --apply');
  }
  if (options.apply && !options.expectedDatabase) {
    throw new Error('--expected-database=<name> is required with --apply');
  }

  options.productIds = [...new Set(options.productIds)].map((id) => {
    if (!mongoose.isObjectIdOrHexString(id)) {
      throw new Error(`Invalid product ID: ${id}`);
    }
    return new mongoose.Types.ObjectId(id);
  });

  return options;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function objectIdTimestamp(id, fallback) {
  return id instanceof mongoose.Types.ObjectId ? id.getTimestamp() : fallback;
}

function summarizeValidationError(error) {
  if (error instanceof mongoose.Error.ValidationError) {
    return Object.values(error.errors).map((item) => ({
      path: item.path,
      kind: item.kind || item.name || 'validation',
    }));
  }
  if (error instanceof mongoose.Error.CastError) {
    return [{ path: error.path, kind: 'cast' }];
  }
  return [{ path: null, kind: error?.name || 'unknown' }];
}

function mergeVariantUnknownFields(rawVariants, normalizedVariants) {
  return normalizedVariants.map((variant, index) => {
    const rawVariant = rawVariants[index];
    const preserved = rawVariant && typeof rawVariant === 'object' ? rawVariant : {};
    return { ...preserved, ...variant };
  });
}

function countMissingVariantIds(raw) {
  if (!Array.isArray(raw.variants)) return 0;
  return raw.variants.reduce((count, variant) => count + (variant?._id == null ? 1 : 0), 0);
}

function validateMigrationSpecificRules(normalized) {
  for (let index = 0; index < normalized.variants.length; index += 1) {
    const variant = normalized.variants[index];
    if (Number(variant.price) > Number(variant.mrp)) {
      throw new Error(`variant.${index}.price_exceeds_mrp`);
    }
  }
}

async function planDocument(raw, migrationTime) {
  if (raw.__v !== undefined && (!Number.isSafeInteger(raw.__v) || raw.__v < 0)) {
    throw new Error('invalid_version_key');
  }

  const candidate = new Product(raw);
  await candidate.validate();

  const normalized = candidate.toObject({
    depopulate: true,
    flattenMaps: false,
    minimize: false,
    versionKey: false,
  });

  validateMigrationSpecificRules(normalized);

  const rawVariants = Array.isArray(raw.variants) ? raw.variants : [];
  normalized.variants = mergeVariantUnknownFields(rawVariants, normalized.variants || []);

  const set = {};
  const changedPaths = [];

  for (const schemaPath of NORMALIZED_PATHS) {
    if (normalized[schemaPath] !== undefined && !isDeepStrictEqual(raw[schemaPath], normalized[schemaPath])) {
      set[schemaPath] = normalized[schemaPath];
      changedPaths.push(schemaPath);
    }
  }

  if (raw.createdAt === undefined) {
    set.createdAt = objectIdTimestamp(raw._id, migrationTime);
    changedPaths.push('createdAt');
  }

  const needsVersionKey = raw.__v === undefined;
  if (needsVersionKey) changedPaths.push('__v');

  if (changedPaths.length > 0) set.updatedAt = migrationTime;

  return {
    id: raw._id,
    raw,
    set,
    changedPaths,
    missingVariantIds: countMissingVariantIds(raw),
    originalVersion: raw.__v,
    originalUpdatedAt: raw.updatedAt,
  };
}

function buildConflictFilter(change) {
  const filter = { _id: change.id };

  if (change.originalVersion === undefined) {
    filter.__v = { $exists: false };
  } else {
    filter.__v = change.originalVersion;
  }

  if (change.originalUpdatedAt === undefined) {
    filter.updatedAt = { $exists: false };
  } else {
    filter.updatedAt = change.originalUpdatedAt;
  }

  return filter;
}

function buildUpdate(change) {
  return {
    $set: change.set,
    $inc: { __v: 1 },
  };
}

function registerUniqueValue(registry, duplicates, value, productId) {
  if (!value) return;
  const normalizedValue = String(value).trim();
  if (!normalizedValue) return;

  const existingOwner = registry.get(normalizedValue);
  if (existingOwner && existingOwner !== productId) {
    duplicates.add(normalizedValue);
  } else {
    registry.set(normalizedValue, productId);
  }
}

function collectUniqueness(raw, registries, duplicates) {
  const productId = String(raw._id);
  registerUniqueValue(registries.slugs, duplicates.slugs, raw.slug, productId);
  registerUniqueValue(registries.productSkus, duplicates.productSkus, raw.sku, productId);

  const productVariantSkus = new Set();
  for (const variant of Array.isArray(raw.variants) ? raw.variants : []) {
    if (variant?.sku) productVariantSkus.add(String(variant.sku).trim());
  }
  for (const sku of productVariantSkus) {
    registerUniqueValue(registries.variantSkus, duplicates.variantSkus, sku, productId);
  }
}

async function writeEjson(filename, value) {
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  const filePath = path.join(ARTIFACT_DIRECTORY, filename);
  await writeFile(filePath, `${EJSON.stringify(value, null, 2, { relaxed: false })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return filePath;
}

async function scanProducts(collection, options, migrationTime) {
  const filter = options.productIds.length > 0 ? { _id: { $in: options.productIds } } : {};
  let cursor = collection.find(filter).sort({ _id: 1 }).batchSize(options.batchSize);
  if (options.limit) cursor = cursor.limit(options.limit);

  const changes = [];
  const failures = [];
  const fieldCounts = {};
  const registries = { slugs: new Map(), productSkus: new Map(), variantSkus: new Map() };
  const duplicates = { slugs: new Set(), productSkus: new Set(), variantSkus: new Set() };
  let scanned = 0;
  let missingVariantIds = 0;

  try {
    for await (const raw of cursor) {
      if (stopRequested) throw new Error('Migration interrupted during scan');
      scanned += 1;
      collectUniqueness(raw, registries, duplicates);
      missingVariantIds += countMissingVariantIds(raw);

      try {
        const change = await planDocument(raw, migrationTime);
        if (change.changedPaths.length > 0) {
          changes.push(change);
          for (const changedPath of change.changedPaths) {
            fieldCounts[changedPath] = (fieldCounts[changedPath] || 0) + 1;
          }
        }
      } catch (error) {
        failures.push({
          productId: String(raw._id),
          errors: summarizeValidationError(error),
        });
      }
    }
  } finally {
    await cursor.close();
  }

  return {
    changes,
    failures,
    fieldCounts,
    scanned,
    missingVariantIds,
    duplicateCounts: {
      slugs: duplicates.slugs.size,
      productSkus: duplicates.productSkus.size,
      variantSkus: duplicates.variantSkus.size,
    },
  };
}

function hasBlockingProblems(scan) {
  return scan.failures.length > 0
    || scan.duplicateCounts.slugs > 0
    || scan.duplicateCounts.productSkus > 0
    || scan.duplicateCounts.variantSkus > 0;
}

async function applyChanges(collection, changes, batchSize) {
  let applied = 0;

  for (let offset = 0; offset < changes.length; offset += batchSize) {
    if (stopRequested) throw new Error('Migration interrupted before transaction');
    const batch = changes.slice(offset, offset + batchSize);
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        for (const change of batch) {
          const result = await collection.updateOne(
            buildConflictFilter(change),
            buildUpdate(change),
            { session },
          );
          if (result.matchedCount !== 1) {
            throw new Error(`Concurrent product change detected for ${change.id}`);
          }
        }
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      });
    } finally {
      await session.endSession();
    }

    applied += batch.length;
    console.log(`Applied ${applied}/${changes.length} products`);
  }

  return applied;
}

async function verifyChanges(collection, changes, verificationTime) {
  const failures = [];
  let remainingChanges = 0;
  let missingVariantIds = 0;

  for (const change of changes) {
    const raw = await collection.findOne({ _id: change.id });
    if (!raw) {
      failures.push({ productId: String(change.id), errors: [{ path: null, kind: 'missing_after_apply' }] });
      continue;
    }

    missingVariantIds += countMissingVariantIds(raw);
    try {
      const verification = await planDocument(raw, verificationTime);
      if (verification.changedPaths.length > 0) remainingChanges += 1;
    } catch (error) {
      failures.push({ productId: String(change.id), errors: summarizeValidationError(error) });
    }
  }

  return { failures, remainingChanges, missingVariantIds };
}

function publicReport(mode, database, scan, extra = {}) {
  return {
    mode,
    database,
    scanned: scan.scanned,
    productsNeedingChanges: scan.changes.length,
    persistedVariantsMissingIds: scan.missingVariantIds,
    validationFailures: scan.failures,
    duplicateCounts: scan.duplicateCounts,
    changedFieldCounts: scan.fieldCounts,
    ...extra,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) throw new Error('MONGODB_URI is not configured');

  const migrationTime = new Date();
  await mongoose.connect(mongodbUri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 8000,
  });

  const database = mongoose.connection.db.databaseName;
  const collection = Product.collection;

  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Database: ${database}`);

  if (options.apply && options.expectedDatabase !== database) {
    throw new Error(`Connected database does not match --expected-database (${options.expectedDatabase})`);
  }

  const scan = await scanProducts(collection, options, migrationTime);
  const reportName = `${safeTimestamp()}-${options.apply ? 'apply-preflight' : 'dry-run'}.json`;
  const report = publicReport(options.apply ? 'apply-preflight' : 'dry-run', database, scan);
  const reportPath = await writeEjson(reportName, report);

  console.log(`Scanned: ${scan.scanned}`);
  console.log(`Products needing changes: ${scan.changes.length}`);
  console.log(`Persisted variants missing IDs: ${scan.missingVariantIds}`);
  console.log(`Validation failures: ${scan.failures.length}`);
  console.log(`Duplicate slugs/product SKUs/variant SKUs: ${scan.duplicateCounts.slugs}/${scan.duplicateCounts.productSkus}/${scan.duplicateCounts.variantSkus}`);
  console.log(`Report: ${reportPath}`);

  if (hasBlockingProblems(scan)) {
    throw new Error('Preflight found blocking validation or uniqueness problems; no changes were applied');
  }

  if (!options.apply) {
    console.log('Dry run complete; database was not modified.');
    return;
  }

  if (scan.changes.length === 0) {
    console.log('No product changes are required.');
    return;
  }

  const backupPath = await writeEjson(`${safeTimestamp()}-before.ejson`, {
    metadata: {
      database,
      collection: collection.collectionName,
      createdAt: new Date(),
      documentCount: scan.changes.length,
    },
    documents: scan.changes.map((change) => change.raw),
  });
  console.log(`Rollback export: ${backupPath}`);

  const applied = await applyChanges(collection, scan.changes, options.batchSize);
  const verification = await verifyChanges(collection, scan.changes, new Date());
  const verificationReport = publicReport('apply-result', database, scan, {
    applied,
    verification,
    rollbackExport: backupPath,
  });
  const verificationPath = await writeEjson(`${safeTimestamp()}-apply-result.json`, verificationReport);

  console.log(`Applied: ${applied}`);
  console.log(`Remaining normalization changes: ${verification.remainingChanges}`);
  console.log(`Remaining missing variant IDs: ${verification.missingVariantIds}`);
  console.log(`Post-apply validation failures: ${verification.failures.length}`);
  console.log(`Result report: ${verificationPath}`);

  if (verification.remainingChanges > 0 || verification.missingVariantIds > 0 || verification.failures.length > 0) {
    throw new Error('Post-apply verification failed; use the rollback export before resuming writes');
  }
}

try {
  await main();
} catch (error) {
  console.error(`Product normalization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
