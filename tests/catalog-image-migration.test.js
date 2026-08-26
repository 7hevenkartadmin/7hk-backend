import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  canonicalSourceImageUrl,
  collectCatalogImageUrls,
  detectImageMimeType,
  migratedPublicId,
  normalizeSourceHosts,
  replaceCatalogImageUrls,
  sourceDownloadCandidates,
} from '../src/scripts/catalog-image-migration.helpers.js';
import {
  buildDatabaseOperations,
  cloudinaryErrorInfo,
  downloadSourceImage,
  isCloudinaryNotFound,
  parseArguments,
} from '../src/scripts/migrate-catalog-images.js';

const sourceHosts = normalizeSourceHosts(['cdn.grofers.com']);
const sourceUrl = 'https://cdn.grofers.com/da/cms-assets/product/example.png';
const cloudinaryUrl = 'https://res.cloudinary.com/example/image/upload/example.png';

test('source image validation requires HTTPS and an exact allowed host', () => {
  assert.equal(canonicalSourceImageUrl(sourceUrl, sourceHosts), sourceUrl);
  assert.equal(canonicalSourceImageUrl('http://cdn.grofers.com/example.png', sourceHosts), null);
  assert.equal(canonicalSourceImageUrl('https://cdn.grofers.com.evil.test/example.png', sourceHosts), null);
  assert.equal(canonicalSourceImageUrl('https://user:pass@cdn.grofers.com/example.png', sourceHosts), null);
});

test('catalog scanning deduplicates only declared image fields', () => {
  const urls = collectCatalogImageUrls({
    image: sourceUrl,
    description: `Unrelated link: ${sourceUrl}`,
    gallery: [sourceUrl],
    variants: [{ images: [sourceUrl] }],
    subcategories: [{ image: 'https://example.com/not-selected.png' }],
  }, sourceHosts);

  assert.deepEqual([...urls], [sourceUrl]);
});

test('catalog replacement changes product, gallery, variant, and nested category images only', () => {
  const input = {
    image: sourceUrl,
    gallery: [sourceUrl],
    variants: [{ images: [sourceUrl], externalDocs: sourceUrl }],
    subcategories: [{ image: sourceUrl }],
    website: sourceUrl,
  };
  const migrated = replaceCatalogImageUrls(input, new Map([[sourceUrl, cloudinaryUrl]]), sourceHosts);

  assert.equal(migrated.image, cloudinaryUrl);
  assert.equal(migrated.gallery[0], cloudinaryUrl);
  assert.equal(migrated.variants[0].images[0], cloudinaryUrl);
  assert.equal(migrated.subcategories[0].image, cloudinaryUrl);
  assert.equal(migrated.variants[0].externalDocs, sourceUrl);
  assert.equal(migrated.website, sourceUrl);
});

test('Cloudinary public IDs are deterministic and isolated by source host', () => {
  const first = migratedPublicId(sourceUrl, '7heven/catalog');
  const second = migratedPublicId(sourceUrl, '7heven/catalog');

  assert.equal(first, second);
  assert.match(first, /^7heven\/catalog\/migrated\/cdn-grofers-com\/example-[a-f0-9]{20}$/);
});

test('Cloudinary nested SDK errors retain safe status and message diagnostics', () => {
  const nestedNotFound = { error: { message: 'Resource not found', http_code: 404 } };
  assert.deepEqual(cloudinaryErrorInfo(nestedNotFound), {
    status: 404,
    message: 'Resource not found',
  });
  assert.equal(isCloudinaryNotFound(nestedNotFound), true);
  assert.equal(isCloudinaryNotFound({ error: { message: 'Invalid credentials', http_code: 401 } }), false);
  assert.deepEqual(cloudinaryErrorInfo({ error: {} }), {
    status: 0,
    message: 'Cloudinary request failed without a message',
  });
});

test('Cloudflare transformation URLs prefer the underlying approved source asset', () => {
  const transformed = 'https://cdn.grofers.com/cdn-cgi/image/f=auto,w=1080/da/catalog/item.png';
  assert.deepEqual(sourceDownloadCandidates(transformed), [
    'https://cdn.grofers.com/da/catalog/item.png',
    transformed,
  ]);
  assert.deepEqual(sourceDownloadCandidates(sourceUrl), [sourceUrl]);
});

test('downloaded image bytes are signature checked and bounded before upload', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const requested = [];
  const transformed = 'https://cdn.grofers.com/cdn-cgi/image/f=auto,w=1080/da/catalog/item.png';
  const result = await downloadSourceImage(transformed, sourceHosts, 1024, {
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      });
    },
  });

  assert.deepEqual(requested, ['https://cdn.grofers.com/da/catalog/item.png']);
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(result.buffer, png);
  assert.equal(detectImageMimeType(png), 'image/png');

  await assert.rejects(
    downloadSourceImage(sourceUrl, sourceHosts, 10, {
      fetchImpl: async () => new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
      }),
    }),
    /size limit/,
  );
});

test('source downloads reject redirects outside the exact approved host', async () => {
  await assert.rejects(
    downloadSourceImage(sourceUrl, sourceHosts, 1024, {
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.grofers.com.evil.test/item.png' },
      }),
    }),
    /approved HTTPS host list/,
  );
});

test('database operations update only changed image paths and use snapshot filters', () => {
  const productId = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  const categoryId = new mongoose.Types.ObjectId();
  const operations = buildDatabaseOperations({
    products: [{
      _id: productId,
      image: sourceUrl,
      gallery: [sourceUrl, 'https://example.com/owned.png'],
      variants: [{ _id: variantId, sku: '7HK-ONE', images: [sourceUrl], price: 20 }],
    }],
    categories: [{ _id: categoryId, image: sourceUrl }],
  }, new Map([[sourceUrl, cloudinaryUrl]]), sourceHosts, new Date('2026-08-26T00:00:00.000Z'));

  assert.equal(operations.productOperations.length, 1);
  assert.equal(operations.categoryOperations.length, 1);
  const productOperation = operations.productOperations[0].updateOne;
  assert.equal(productOperation.filter._id, productId);
  assert.equal(productOperation.filter.image, sourceUrl);
  assert.equal(productOperation.filter['variants.0._id'], variantId);
  assert.equal(productOperation.update.$set.image, cloudinaryUrl);
  assert.deepEqual(productOperation.update.$set.gallery, [cloudinaryUrl, 'https://example.com/owned.png']);
  assert.deepEqual(productOperation.update.$set['variants.0.images'], [cloudinaryUrl]);
  assert.equal(Object.hasOwn(productOperation.update.$set, 'variants'), false);
});

test('database operations cover operational image copies without rewriting whole snapshots', () => {
  const id = () => new mongoose.Types.ObjectId();
  const operations = buildDatabaseOperations({
    products: [],
    categories: [],
    orders: [{ _id: id(), items: [{ product: id(), sku: '7HK-ONE', image: sourceUrl, price: 20 }] }],
    paymentIntents: [{
      _id: id(),
      checkoutSnapshot: { items: [{ productId: 'product-one', image: sourceUrl, quantity: 1 }] },
    }],
    coupons: [{ _id: id(), image: sourceUrl }],
    settings: [{ _id: id(), homepageBanners: [{ _id: id(), image: sourceUrl, title: 'Offer' }] }],
  }, new Map([[sourceUrl, cloudinaryUrl]]), sourceHosts);

  assert.equal(operations.orderOperations.length, 1);
  assert.equal(operations.paymentIntentOperations.length, 1);
  assert.equal(operations.couponOperations.length, 1);
  assert.equal(operations.settingOperations.length, 1);
  assert.deepEqual(
    operations.orderOperations[0].updateOne.update.$set['items.0.image'],
    cloudinaryUrl,
  );
  assert.equal(
    operations.paymentIntentOperations[0].updateOne.update.$set['checkoutSnapshot.items.0.image'],
    cloudinaryUrl,
  );
  assert.equal(
    operations.settingOperations[0].updateOne.update.$set['homepageBanners.0.image'],
    cloudinaryUrl,
  );
});

test('apply mode requires production, rights, and database confirmations', () => {
  assert.throws(() => parseArguments(['--apply']), /confirm-production/);
  assert.throws(
    () => parseArguments(['--apply', '--confirm-production']),
    /confirm-image-rights/,
  );
  assert.throws(
    () => parseArguments(['--apply', '--confirm-production', '--confirm-image-rights']),
    /expected-database/,
  );
  assert.doesNotThrow(() => parseArguments([
    '--apply',
    '--confirm-production',
    '--confirm-image-rights',
    '--expected-database=7heven',
  ]));
});
