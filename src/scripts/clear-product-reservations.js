import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import mongoose from 'mongoose';
import { Product } from '../modules/catalog/product.model.js';

const { EJSON } = mongoose.mongo.BSON;
const BACKUP_DIRECTORY = path.resolve(process.cwd(), 'tmp', 'clear-product-reservations');

function printUsage() {
  console.log(`
Usage:
  npm run inventory:clear-reservations -- [options]

The default mode is a read-only preview.

Options:
  --apply                         Clear reservations and refresh stock summaries
  --confirm-production            Required with --apply
  --expected-database=<name>       Required with --apply
  --help                           Show this help
`);
}

function parseArguments(argv) {
  const options = {
    apply: false,
    confirmProduction: false,
    expectedDatabase: '',
    help: false,
  };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--confirm-production') options.confirmProduction = true;
    else if (argument === '--help') options.help = true;
    else if (argument.startsWith('--expected-database=')) {
      options.expectedDatabase = argument.slice('--expected-database='.length).trim();
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

  return options;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function writeBackup(database, documents) {
  await mkdir(BACKUP_DIRECTORY, { recursive: true });
  const backupPath = path.join(BACKUP_DIRECTORY, `${safeTimestamp()}-${database}-products-before.ejson`);
  const backup = {
    metadata: {
      database,
      collection: Product.collection.collectionName,
      createdAt: new Date(),
      documentCount: documents.length,
      purpose: 'Before clearing every product and variant reservedStock value',
    },
    documents,
  };
  await writeFile(backupPath, `${EJSON.stringify(backup, null, 2, { relaxed: false })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return backupPath;
}

const variantsExpression = {
  $cond: [
    { $isArray: '$variants' },
    '$variants',
    [],
  ],
};

const totalStockExpression = {
  $cond: [
    { $gt: [{ $size: variantsExpression }, 0] },
    {
      $sum: {
        $map: {
          input: {
            $filter: {
              input: variantsExpression,
              as: 'variant',
              cond: { $ne: ['$$variant.isActive', false] },
            },
          },
          as: 'variant',
          in: {
            $max: [
              0,
              {
                $convert: {
                  input: '$$variant.stock',
                  to: 'double',
                  onError: 0,
                  onNull: 0,
                },
              },
            ],
          },
        },
      },
    },
    {
      $max: [
        0,
        {
          $convert: {
            input: '$stock',
            to: 'double',
            onError: 0,
            onNull: 0,
          },
        },
      ],
    },
  ],
};

function resetPipeline(now) {
  return [
    {
      $set: {
        reservedStock: 0,
        variants: {
          $map: {
            input: variantsExpression,
            as: 'variant',
            in: { $mergeObjects: ['$$variant', { reservedStock: 0 }] },
          },
        },
        totalStock: totalStockExpression,
        availableStock: totalStockExpression,
        updatedAt: now,
        __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
      },
    },
  ];
}

async function inventorySummary(collection) {
  const [products, topLevelReservations, variantReservations, availabilityMismatches] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ reservedStock: { $ne: 0 } }),
    collection.countDocuments({ variants: { $elemMatch: { reservedStock: { $ne: 0 } } } }),
    collection.countDocuments({ $expr: { $ne: ['$availableStock', '$totalStock'] } }),
  ]);

  return { products, topLevelReservations, variantReservations, availabilityMismatches };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const mongodbUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongodbUri) throw new Error('Missing MONGODB_URI or MONGO_URI');

  await mongoose.connect(mongodbUri, { autoIndex: false, serverSelectionTimeoutMS: 8_000 });
  const database = mongoose.connection.db.databaseName;
  const collection = Product.collection;

  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Database: ${database}`);

  const before = await inventorySummary(collection);
  console.log(`Products: ${before.products}`);
  console.log(`Products with top-level reservations: ${before.topLevelReservations}`);
  console.log(`Products with variant reservations: ${before.variantReservations}`);
  console.log(`Products where availableStock differs from totalStock: ${before.availabilityMismatches}`);

  if (!options.apply) {
    console.log('Dry run complete; no database records were changed.');
    return;
  }

  if (options.expectedDatabase !== database) {
    throw new Error(`Connected database does not match --expected-database (${options.expectedDatabase})`);
  }

  const documents = await collection.find({}).toArray();
  const backupPath = await writeBackup(database, documents);
  console.log(`Rollback snapshot: ${backupPath}`);

  const result = await collection.updateMany({}, resetPipeline(new Date()));
  console.log(`Matched products: ${result.matchedCount}`);
  console.log(`Modified products: ${result.modifiedCount}`);

  const after = await inventorySummary(collection);
  console.log(`Remaining top-level reservations: ${after.topLevelReservations}`);
  console.log(`Remaining variant reservations: ${after.variantReservations}`);
  console.log(`Remaining availability mismatches: ${after.availabilityMismatches}`);

  if (
    after.products !== before.products
    || after.topLevelReservations !== 0
    || after.variantReservations !== 0
    || after.availabilityMismatches !== 0
  ) {
    throw new Error('Post-update verification failed; restore from the rollback snapshot');
  }

  console.log('All product reservations were cleared and inventory summaries were verified.');
}

try {
  await main();
} catch (error) {
  console.error(`Clear product reservations failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
