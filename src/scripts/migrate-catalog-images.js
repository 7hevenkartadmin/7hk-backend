import 'dotenv/config';

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import {
  canonicalSourceImageUrl,
  collectCatalogImageUrls,
  detectImageMimeType,
  migratedPublicId,
  normalizeSourceHosts,
  replaceCatalogImageUrls,
  sourceDownloadCandidates,
} from './catalog-image-migration.helpers.js';

const DEFAULT_SOURCE_HOSTS = ['cdn.grofers.com'];
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_IMAGE_MB = 3;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const catalogDirectory = path.resolve(scriptDirectory, '../modules/catalog');
const sourceFiles = [
  path.join(catalogDirectory, 'categories.json'),
  path.join(catalogDirectory, 'products.json'),
];

function printUsage() {
  console.log(`
Usage:
  npm run catalog:images:migrate -- [options]

Default behavior is a read-only scan of MongoDB and the active catalog JSON files.

Options:
  --apply                         Upload and replace matching image URLs
  --confirm-production            Required with --apply
  --confirm-image-rights          Confirms you may lawfully copy and host the images
  --expected-database=<name>       Required with --apply when database is in scope
  --scope=<all|database|source>    Migration scope (default: all)
  --source-host=<host[,host...]>   Exact HTTPS host to migrate; repeatable
                                  (default: ${DEFAULT_SOURCE_HOSTS.join(', ')})
  --concurrency=<number>           Parallel Cloudinary uploads (default: ${DEFAULT_CONCURRENCY})
  --max-image-mb=<number>          Reject larger images (default: CLOUDINARY_MAX_IMAGE_MB or ${DEFAULT_MAX_IMAGE_MB})
  --help                           Show this help

Examples:
  npm run catalog:images:migrate
  npm run catalog:images:migrate -- --apply --confirm-production --confirm-image-rights --expected-database=7heven
`);
}

function positiveInteger(value, option, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${option} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    apply: false,
    confirmProduction: false,
    confirmImageRights: false,
    expectedDatabase: '',
    scope: 'all',
    sourceHosts: [],
    concurrency: DEFAULT_CONCURRENCY,
    maxImageMb: positiveInteger(process.env.CLOUDINARY_MAX_IMAGE_MB || DEFAULT_MAX_IMAGE_MB, 'CLOUDINARY_MAX_IMAGE_MB', 20),
    help: false,
  };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--confirm-production') options.confirmProduction = true;
    else if (argument === '--confirm-image-rights') options.confirmImageRights = true;
    else if (argument === '--help') options.help = true;
    else if (argument.startsWith('--expected-database=')) {
      options.expectedDatabase = argument.slice('--expected-database='.length).trim();
    } else if (argument.startsWith('--scope=')) {
      options.scope = argument.slice('--scope='.length).trim().toLowerCase();
    } else if (argument.startsWith('--source-host=')) {
      options.sourceHosts.push(argument.slice('--source-host='.length));
    } else if (argument.startsWith('--concurrency=')) {
      options.concurrency = positiveInteger(argument.slice('--concurrency='.length), '--concurrency', 8);
    } else if (argument.startsWith('--max-image-mb=')) {
      options.maxImageMb = positiveInteger(argument.slice('--max-image-mb='.length), '--max-image-mb', 20);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!['all', 'database', 'source'].includes(options.scope)) {
    throw new Error('--scope must be all, database, or source');
  }
  if (!options.sourceHosts.length) options.sourceHosts = DEFAULT_SOURCE_HOSTS;
  options.sourceHosts = normalizeSourceHosts(options.sourceHosts);

  if (options.apply && !options.confirmProduction) {
    throw new Error('--confirm-production is required with --apply');
  }
  if (options.apply && !options.confirmImageRights) {
    throw new Error('--confirm-image-rights is required with --apply');
  }
  if (options.apply && options.scope !== 'source' && !options.expectedDatabase) {
    throw new Error('--expected-database=<name> is required with --apply when database is in scope');
  }

  return options;
}

function databaseInScope(scope) {
  return scope === 'all' || scope === 'database';
}

function sourceInScope(scope) {
  return scope === 'all' || scope === 'source';
}

async function loadSourceCatalog(sourceHosts) {
  const files = [];
  for (const filePath of sourceFiles) {
    const text = await readFile(filePath, 'utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid catalog JSON: ${filePath}`, { cause: error });
    }
    files.push({
      filePath,
      text,
      data,
      urls: collectCatalogImageUrls(data, sourceHosts),
    });
  }
  return files;
}

async function loadDatabaseCatalog(database, sourceHosts) {
  const [products, categories, orders, paymentIntents, coupons, settings] = await Promise.all([
    database.collection('products').find({}, {
      projection: { image: 1, gallery: 1, variants: 1, updatedAt: 1 },
    }).toArray(),
    database.collection('categories').find({}, {
      projection: { image: 1, updatedAt: 1 },
    }).toArray(),
    database.collection('orders').find({}, {
      projection: { items: 1, updatedAt: 1 },
    }).toArray(),
    database.collection('paymentintents').find({}, {
      projection: { 'checkoutSnapshot.items': 1, updatedAt: 1 },
    }).toArray(),
    database.collection('coupons').find({}, {
      projection: { image: 1, updatedAt: 1 },
    }).toArray(),
    database.collection('storesettings').find({}, {
      projection: { homepageBanners: 1, updatedAt: 1 },
    }).toArray(),
  ]);
  const urls = new Set([
    ...collectCatalogImageUrls(products, sourceHosts),
    ...collectCatalogImageUrls(categories, sourceHosts),
    ...collectCatalogImageUrls(orders, sourceHosts),
    ...collectCatalogImageUrls(paymentIntents, sourceHosts),
    ...collectCatalogImageUrls(coupons, sourceHosts),
    ...collectCatalogImageUrls(settings, sourceHosts),
  ]);
  return {
    products, categories, orders, paymentIntents, coupons, settings, urls,
  };
}

function cloudinaryConfiguration() {
  const configuration = {
    cloud_name: String(process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    api_key: String(process.env.CLOUDINARY_API_KEY || '').trim(),
    api_secret: String(process.env.CLOUDINARY_API_SECRET || '').trim(),
    folder: String(process.env.CLOUDINARY_FOLDER || '7heven/catalog').trim(),
  };
  const missing = Object.entries(configuration)
    .filter(([key, value]) => key !== 'folder' && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Missing Cloudinary configuration: ${missing.join(', ')}`);
  if (!/^[a-zA-Z0-9/_-]+$/.test(configuration.folder)) {
    throw new Error('CLOUDINARY_FOLDER contains unsupported characters');
  }
  return configuration;
}

export function cloudinaryErrorInfo(error) {
  let payload = error;
  for (let depth = 0; depth < 3 && payload?.error && typeof payload.error === 'object'; depth += 1) {
    payload = payload.error;
  }
  const status = Number(
    payload?.http_code
    || payload?.statusCode
    || error?.http_code
    || error?.statusCode
    || 0,
  );
  const rawMessage = payload?.message || error?.message;
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage.trim().replace(/[\r\n]+/g, ' ').slice(0, 300)
    : 'Cloudinary request failed without a message';
  return { status, message };
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return cloudinaryErrorInfo(error).message;
}

export function isCloudinaryNotFound(error) {
  return cloudinaryErrorInfo(error).status === 404;
}

function isRetryable(error) {
  const { status, message } = cloudinaryErrorInfo(error);
  return status === 408 || status === 429 || status >= 500
    || /timeout|timed out|ECONNRESET|EAI_AGAIN/i.test(message);
}

async function retry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

function validateCloudinaryAsset(asset, maxBytes) {
  if (!asset?.secure_url || asset.resource_type !== 'image') {
    throw new Error('Cloudinary did not return a secure image asset');
  }
  if (Number(asset.width || 0) < 64 || Number(asset.height || 0) < 64
    || Number(asset.width || 0) > 8000 || Number(asset.height || 0) > 8000) {
    throw new Error('Image dimensions must be between 64 and 8000 pixels');
  }
  if (Number(asset.bytes || 0) < 1 || Number(asset.bytes) > maxBytes) {
    throw new Error(`Image exceeds the configured ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
  }
}

function responseError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

async function readBoundedImageResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw responseError(413, 'Remote image exceeds the configured size limit');
  }
  if (!response.body) throw new Error('Remote image response had no body');

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw responseError(413, 'Remote image exceeds the configured size limit');
    }
    chunks.push(buffer);
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  const detectedMimeType = detectImageMimeType(buffer);
  if (!detectedMimeType) throw responseError(422, 'Remote content is not a supported JPG, PNG, WebP, or AVIF image');

  const declaredMimeType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
    .replace('image/jpg', 'image/jpeg');
  if (declaredMimeType.startsWith('image/') && declaredMimeType !== detectedMimeType) {
    throw responseError(422, 'Remote image content does not match its declared type');
  }
  return { buffer, mimeType: detectedMimeType };
}

async function fetchApprovedImage(candidate, sourceHosts, maxBytes, fetchImpl) {
  let currentUrl = candidate;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const approvedUrl = canonicalSourceImageUrl(currentUrl, sourceHosts);
    if (!approvedUrl) throw responseError(403, 'Remote image redirected outside the approved HTTPS host list');

    const response = await retry(async () => {
      const fetched = await fetchImpl(approvedUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': '7HevenKart-Catalog-Migration/1.0 (+https://7hevenkart.com)',
        },
      });
      if (fetched.status === 408 || fetched.status === 429 || fetched.status >= 500) {
        throw responseError(fetched.status, `Remote image server returned HTTP ${fetched.status}`);
      }
      return fetched;
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw responseError(response.status, 'Remote image redirect did not include a location');
      currentUrl = new URL(location, approvedUrl).href;
      continue;
    }
    if (!response.ok) throw responseError(response.status, `Remote image server returned HTTP ${response.status}`);
    return readBoundedImageResponse(response, maxBytes);
  }
  throw responseError(508, 'Remote image exceeded the safe redirect limit');
}

export async function downloadSourceImage(
  sourceUrl,
  sourceHosts,
  maxBytes,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch');
  let lastError;
  for (const candidate of sourceDownloadCandidates(sourceUrl)) {
    try {
      return await fetchApprovedImage(candidate, sourceHosts, maxBytes, fetchImpl);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Approved source image download failed: ${safeErrorMessage(lastError)}`, { cause: lastError });
}

function uploadImageBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

async function uploadSourceImage(sourceUrl, configuration, sourceHosts, maxBytes) {
  const publicId = migratedPublicId(sourceUrl, configuration.folder);
  let existing = null;
  try {
    existing = await retry(() => cloudinary.api.resource(publicId, { resource_type: 'image' }));
  } catch (error) {
    if (!isCloudinaryNotFound(error)) {
      const { status, message } = cloudinaryErrorInfo(error);
      throw new Error(`Cloudinary asset lookup failed${status ? ` (HTTP ${status})` : ''}: ${message}`, { cause: error });
    }
  }

  if (existing) {
    validateCloudinaryAsset(existing, maxBytes);
    return { sourceUrl, url: existing.secure_url, publicId, reused: true, ...assetSummary(existing) };
  }

  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  let uploaded;
  try {
    const downloaded = await downloadSourceImage(sourceUrl, sourceHosts, maxBytes);
    uploaded = await retry(() => uploadImageBuffer(downloaded.buffer, {
      resource_type: 'image',
      public_id: publicId,
      unique_filename: false,
      overwrite: false,
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'avif'],
      tags: ['7heven', 'catalog-migration', 'external-source'],
      context: { migration: 'external-catalog-v1', source_host: sourceHost },
    }));
    validateCloudinaryAsset(uploaded, maxBytes);
  } catch (error) {
    if (uploaded?.public_id === publicId) {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true }).catch(() => {});
    }
    const { status, message } = cloudinaryErrorInfo(error);
    throw new Error(`Could not migrate image from ${sourceHost}${status ? ` (HTTP ${status})` : ''}: ${message}`, { cause: error });
  }

  return { sourceUrl, url: uploaded.secure_url, publicId, reused: false, ...assetSummary(uploaded) };
}

function assetSummary(asset) {
  return {
    width: Number(asset.width),
    height: Number(asset.height),
    bytes: Number(asset.bytes),
    format: asset.format,
  };
}

async function uploadAll(urls, configuration, options) {
  cloudinary.config({
    cloud_name: configuration.cloud_name,
    api_key: configuration.api_key,
    api_secret: configuration.api_secret,
    secure: true,
    timeout: 60_000,
  });

  try {
    await retry(() => cloudinary.api.resources({
      resource_type: 'image',
      type: 'upload',
      prefix: `${configuration.folder}/migrated/`,
      max_results: 1,
    }));
  } catch (error) {
    const { status, message } = cloudinaryErrorInfo(error);
    throw new Error(`Cloudinary preflight failed${status ? ` (HTTP ${status})` : ''}: ${message}`, { cause: error });
  }
  console.log('Cloudinary credentials and asset access verified.');

  const items = [...urls].sort();
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  let stopped = false;
  let firstError;

  async function worker() {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await uploadSourceImage(
          items[index],
          configuration,
          options.sourceHosts,
          options.maxImageMb * 1024 * 1024,
        );
        completed += 1;
        console.log(`Uploaded or reused ${completed}/${items.length}`);
      } catch (error) {
        stopped = true;
        firstError = firstError || error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function snapshotCondition(filter, pathName, value) {
  if (value === undefined) filter[pathName] = { $exists: false };
  else filter[pathName] = value;
}

export function buildDatabaseOperations(databaseCatalog, replacements, sourceHosts, now = new Date()) {
  const productOperations = [];
  const categoryOperations = [];
  const orderOperations = [];
  const paymentIntentOperations = [];
  const couponOperations = [];
  const settingOperations = [];

  for (const product of databaseCatalog.products) {
    const original = {
      image: product.image,
      gallery: product.gallery,
      variants: (product.variants || []).map((variant) => ({
        _id: variant._id,
        sku: variant.sku,
        images: variant.images,
      })),
    };
    const migrated = replaceCatalogImageUrls(original, replacements, sourceHosts);
    const filter = { _id: product._id };
    const set = {};

    if (!isDeepStrictEqual(original.image, migrated.image)) {
      snapshotCondition(filter, 'image', original.image);
      set.image = migrated.image;
    }
    if (!isDeepStrictEqual(original.gallery, migrated.gallery)) {
      snapshotCondition(filter, 'gallery', original.gallery);
      set.gallery = migrated.gallery;
    }
    original.variants.forEach((variant, index) => {
      if (isDeepStrictEqual(variant.images, migrated.variants[index].images)) return;
      if (variant._id) filter[`variants.${index}._id`] = variant._id;
      else if (variant.sku) filter[`variants.${index}.sku`] = variant.sku;
      snapshotCondition(filter, `variants.${index}.images`, variant.images);
      set[`variants.${index}.images`] = migrated.variants[index].images;
    });
    if (Object.keys(set).length) {
      set.updatedAt = now;
      productOperations.push({ updateOne: { filter, update: { $set: set } } });
    }
  }

  for (const category of databaseCatalog.categories) {
    const migrated = replaceCatalogImageUrls({ image: category.image }, replacements, sourceHosts);
    if (isDeepStrictEqual(category.image, migrated.image)) continue;
    const filter = { _id: category._id };
    snapshotCondition(filter, 'image', category.image);
    categoryOperations.push({
      updateOne: { filter, update: { $set: { image: migrated.image, updatedAt: now } } },
    });
  }

  for (const order of databaseCatalog.orders || []) {
    const originalItems = order.items || [];
    const migratedItems = replaceCatalogImageUrls(originalItems, replacements, sourceHosts);
    const filter = { _id: order._id };
    const set = {};
    originalItems.forEach((item, index) => {
      if (isDeepStrictEqual(item.image, migratedItems[index].image)) return;
      if (item.product) filter[`items.${index}.product`] = item.product;
      else if (item.sku) filter[`items.${index}.sku`] = item.sku;
      snapshotCondition(filter, `items.${index}.image`, item.image);
      set[`items.${index}.image`] = migratedItems[index].image;
    });
    if (Object.keys(set).length) {
      set.updatedAt = now;
      orderOperations.push({ updateOne: { filter, update: { $set: set } } });
    }
  }

  for (const intent of databaseCatalog.paymentIntents || []) {
    const originalItems = intent.checkoutSnapshot?.items || [];
    const migratedItems = replaceCatalogImageUrls(originalItems, replacements, sourceHosts);
    const filter = { _id: intent._id };
    const set = {};
    originalItems.forEach((item, index) => {
      if (isDeepStrictEqual(item.image, migratedItems[index].image)) return;
      if (item.productId) filter[`checkoutSnapshot.items.${index}.productId`] = item.productId;
      else if (item.sku) filter[`checkoutSnapshot.items.${index}.sku`] = item.sku;
      snapshotCondition(filter, `checkoutSnapshot.items.${index}.image`, item.image);
      set[`checkoutSnapshot.items.${index}.image`] = migratedItems[index].image;
    });
    if (Object.keys(set).length) {
      set.updatedAt = now;
      paymentIntentOperations.push({ updateOne: { filter, update: { $set: set } } });
    }
  }

  for (const coupon of databaseCatalog.coupons || []) {
    const migrated = replaceCatalogImageUrls({ image: coupon.image }, replacements, sourceHosts);
    if (isDeepStrictEqual(coupon.image, migrated.image)) continue;
    const filter = { _id: coupon._id };
    snapshotCondition(filter, 'image', coupon.image);
    couponOperations.push({
      updateOne: { filter, update: { $set: { image: migrated.image, updatedAt: now } } },
    });
  }

  for (const setting of databaseCatalog.settings || []) {
    const originalBanners = setting.homepageBanners || [];
    const migratedBanners = replaceCatalogImageUrls(originalBanners, replacements, sourceHosts);
    const filter = { _id: setting._id };
    const set = {};
    originalBanners.forEach((banner, index) => {
      if (isDeepStrictEqual(banner.image, migratedBanners[index].image)) return;
      if (banner._id) filter[`homepageBanners.${index}._id`] = banner._id;
      snapshotCondition(filter, `homepageBanners.${index}.image`, banner.image);
      set[`homepageBanners.${index}.image`] = migratedBanners[index].image;
    });
    if (Object.keys(set).length) {
      set.updatedAt = now;
      settingOperations.push({ updateOne: { filter, update: { $set: set } } });
    }
  }

  return {
    productOperations,
    categoryOperations,
    orderOperations,
    paymentIntentOperations,
    couponOperations,
    settingOperations,
  };
}

async function applyDatabaseOperations(database, operations) {
  const collections = [
    ['products', operations.productOperations],
    ['categories', operations.categoryOperations],
    ['orders', operations.orderOperations],
    ['paymentintents', operations.paymentIntentOperations],
    ['coupons', operations.couponOperations],
    ['storesettings', operations.settingOperations],
  ];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const [collectionName, collectionOperations] of collections) {
        if (!collectionOperations.length) continue;
        const result = await database.collection(collectionName).bulkWrite(collectionOperations, {
          ordered: true,
          session,
        });
        if (result.matchedCount !== collectionOperations.length) {
          throw new Error(`A ${collectionName} document changed during migration; no database image URLs were replaced`);
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
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function createArtifactDirectory() {
  const directory = path.resolve(process.cwd(), 'tmp', 'catalog-image-migration', timestamp());
  await mkdir(directory, { recursive: true });
  return directory;
}

async function updateSourceCatalog(files, replacements, sourceHosts, artifactDirectory) {
  for (const file of files) {
    const migrated = replaceCatalogImageUrls(file.data, replacements, sourceHosts);
    const remaining = collectCatalogImageUrls(migrated, sourceHosts);
    if (remaining.size) throw new Error(`Source verification failed before writing ${file.filePath}`);

    const backupPath = path.join(artifactDirectory, `${path.basename(file.filePath)}.before`);
    await copyFile(file.filePath, backupPath);
    await writeFile(file.filePath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
  }
}

async function writeManifest(artifactDirectory, payload) {
  const manifestPath = path.join(artifactDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return manifestPath;
}

async function connectToCatalogDatabase(options) {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('Missing MONGODB_URI or MONGO_URI');
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 8_000 });
  const database = mongoose.connection.db;
  if (options.expectedDatabase && database.databaseName !== options.expectedDatabase) {
    throw new Error(`Connected to ${database.databaseName}; expected ${options.expectedDatabase}`);
  }
  return database;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printUsage();
    return;
  }

  let database;
  try {
    if (databaseInScope(options.scope)) database = await connectToCatalogDatabase(options);
    const [databaseCatalog, sourceCatalog] = await Promise.all([
      database ? loadDatabaseCatalog(database, options.sourceHosts) : null,
      sourceInScope(options.scope) ? loadSourceCatalog(options.sourceHosts) : [],
    ]);
    const urls = new Set([
      ...(databaseCatalog?.urls || []),
      ...sourceCatalog.flatMap((file) => [...file.urls]),
    ]);

    console.log(`Scope: ${options.scope}`);
    if (database) console.log(`Database: ${database.databaseName}`);
    console.log(`Allowed source hosts: ${[...options.sourceHosts].join(', ')}`);
    console.log(`Unique external catalog images: ${urls.size}`);
    if (databaseCatalog) {
      console.log(`Database documents scanned: ${[
        databaseCatalog.products,
        databaseCatalog.categories,
        databaseCatalog.orders,
        databaseCatalog.paymentIntents,
        databaseCatalog.coupons,
        databaseCatalog.settings,
      ].reduce((sum, entries) => sum + entries.length, 0)}`);
    } else {
      console.log('Database documents scanned: 0');
    }
    console.log(`Catalog source files scanned: ${sourceCatalog.length}`);

    if (!urls.size) {
      console.log('Nothing to migrate. No changes were made.');
      return;
    }
    if (!options.apply) {
      console.log('Dry run complete. No image was uploaded and no reference was changed.');
      console.log('Review image ownership, then run with the apply and confirmation options shown by --help.');
      return;
    }

    const configuration = cloudinaryConfiguration();
    const assets = await uploadAll(urls, configuration, options);
    const replacements = new Map(assets.map((asset) => [asset.sourceUrl, asset.url]));
    if (replacements.size !== urls.size) throw new Error('Not every source URL received a Cloudinary replacement');

    const artifactDirectory = await createArtifactDirectory();
    const manifestPath = await writeManifest(artifactDirectory, {
      createdAt: new Date().toISOString(),
      scope: options.scope,
      database: database?.databaseName || null,
      sourceHosts: [...options.sourceHosts],
      assets,
    });

    if (databaseCatalog) {
      const operations = buildDatabaseOperations(databaseCatalog, replacements, options.sourceHosts);
      await applyDatabaseOperations(database, operations);
      console.log(`Database documents updated: ${[
        operations.productOperations,
        operations.categoryOperations,
        operations.orderOperations,
        operations.paymentIntentOperations,
        operations.couponOperations,
        operations.settingOperations,
      ].reduce((sum, entries) => sum + entries.length, 0)}`);
    }
    if (sourceCatalog.length) {
      await updateSourceCatalog(sourceCatalog, replacements, options.sourceHosts, artifactDirectory);
      console.log(`Catalog source files updated: ${sourceCatalog.length}`);
    }

    const [remainingDatabase, remainingSources] = await Promise.all([
      database ? loadDatabaseCatalog(database, options.sourceHosts) : null,
      sourceCatalog.length ? loadSourceCatalog(options.sourceHosts) : [],
    ]);
    const remaining = new Set([
      ...(remainingDatabase?.urls || []),
      ...remainingSources.flatMap((file) => [...file.urls]),
    ]);
    if (remaining.size) throw new Error(`${remaining.size} external catalog image URL(s) remain; rerun the migration`);

    console.log(`Migration verified. Manifest and source backups: ${manifestPath}`);
    console.log('Cloudinary assets are retained; original third-party assets are never deleted.');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(`Catalog image migration failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
