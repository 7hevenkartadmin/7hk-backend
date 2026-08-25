import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  APP_CHECK_HEADER,
  CLIENT_PLATFORM_HEADER,
  createClientPlatformMiddleware,
  isAndroidRequest,
  requestClientPlatform,
} from '../src/shared/middlewares/clientPlatform.js';
import {
  androidVisibleOrderFilter,
  androidVisiblePaymentIntentFilter,
  assertNoPaanCornerItems,
  containsPaanCornerReference,
  isPaanCornerOrder,
  paanCornerProductExclusion,
  paanCornerTextExclusion,
} from '../src/modules/catalog/paanCorner.visibility.js';
import { Category } from '../src/modules/catalog/category.model.js';

function responseDouble() {
  return {
    varied: [],
    headers: {},
    vary(value) { this.varied.push(value); },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

async function runMiddleware(middleware, headers = {}) {
  const req = { headers, path: '/catalog/products' };
  const res = responseDouble();
  let error;
  await middleware(req, res, (nextError) => { error = nextError; });
  return { req, res, error };
}

test('web remains compatible while unsupported platform claims fail closed', async () => {
  let verifierCalls = 0;
  const middleware = createClientPlatformMiddleware({
    mode: 'enforce',
    androidAppId: '1:123:android:abc',
    verifyToken: async () => { verifierCalls += 1; },
  });

  const web = await runMiddleware(middleware);
  assert.equal(web.error, undefined);
  assert.equal(requestClientPlatform(web.req), 'web');
  assert.equal(verifierCalls, 0);
  assert.deepEqual(web.res.varied, [CLIENT_PLATFORM_HEADER]);

  const invalid = await runMiddleware(middleware, { [CLIENT_PLATFORM_HEADER]: 'ios' });
  assert.equal(invalid.error?.code, 'CLIENT_PLATFORM_INVALID');

  const missingPlatform = await runMiddleware(middleware, {
    [APP_CHECK_HEADER]: 'header.payload.signature',
  });
  assert.equal(missingPlatform.error?.code, 'CLIENT_PLATFORM_REQUIRED');
});

test('enforced Android identity requires a valid App Check token for the configured app', async () => {
  const appId = '1:123:android:abc';
  const validMiddleware = createClientPlatformMiddleware({
    mode: 'enforce',
    androidAppId: appId,
    verifyToken: async () => ({ appId }),
  });

  const missing = await runMiddleware(validMiddleware, { [CLIENT_PLATFORM_HEADER]: 'android' });
  assert.equal(missing.error?.code, 'APP_ATTESTATION_REQUIRED');

  const valid = await runMiddleware(validMiddleware, {
    [CLIENT_PLATFORM_HEADER]: 'android',
    [APP_CHECK_HEADER]: 'header.payload.signature',
  });
  assert.equal(valid.error, undefined);
  assert.equal(isAndroidRequest(valid.req), true);
  assert.equal(valid.req.clientPlatform.attested, true);
  assert.equal(valid.res.headers['Cache-Control'], 'private, no-store');

  const wrongApp = await runMiddleware(createClientPlatformMiddleware({
    mode: 'enforce',
    androidAppId: appId,
    verifyToken: async () => ({ appId: '1:999:android:other' }),
  }), {
    [CLIENT_PLATFORM_HEADER]: 'android',
    [APP_CHECK_HEADER]: 'header.payload.signature',
  });
  assert.equal(wrongApp.error?.code, 'APP_ATTESTATION_INVALID');
});

test('monitor mode reports only sanitized attestation diagnostics and keeps Android filtering active', async () => {
  const events = [];
  const result = await runMiddleware(createClientPlatformMiddleware({
    mode: 'monitor',
    androidAppId: '1:123:android:abc',
    report: (event) => events.push(event),
  }), { [CLIENT_PLATFORM_HEADER]: 'android' });

  assert.equal(result.error, undefined);
  assert.equal(isAndroidRequest(result.req), true);
  assert.deepEqual(events, [{ reason: 'missing', path: '/catalog/products' }]);
});

test('Paan Corner detection covers catalog, historical orders, and indirect promotional references', () => {
  assert.throws(
    () => assertNoPaanCornerItems([{ product: { category: 'Paan Corner' } }]),
    (error) => error.code === 'PRODUCT_NOT_FOUND' && error.statusCode === 404,
  );
  assert.doesNotThrow(() => assertNoPaanCornerItems([{ product: { category: 'Biscuits & Cookies' } }]));
  assert.equal(isPaanCornerOrder({ items: [{ category: 'paan-corner' }] }), true);
  assert.equal(isPaanCornerOrder({ restrictedProductConsent: { policyVersion: '2026-08' } }), true);
  assert.equal(containsPaanCornerReference('/category/paan-corner/cigarettes'), true);
  assert.equal(containsPaanCornerReference('PAAN50'), true);
  assert.equal(containsPaanCornerReference('/category/biscuits'), false);

  const orderFilter = androidVisibleOrderFilter();
  assert.equal(orderFilter.$nor.length, 2);
  assert.equal(orderFilter.$nor[0]['restrictedProductConsent.policyVersion'].$exists, true);
  assert.match(String(orderFilter.$nor[1]['items.category']), /paan/);

  const promotionFilter = paanCornerTextExclusion(['code', 'description']);
  assert.equal(promotionFilter.$nor.length, 2);
  assert.equal(androidVisiblePaymentIntentFilter().$nor.length, 2);
});

test('Android product visibility is expressed inside the MongoDB query filter', async () => {
  const rootId = new mongoose.Types.ObjectId();
  const childId = new mongoose.Types.ObjectId();
  const originalFind = Category.find;
  Category.find = (filter) => ({
    distinct: async () => (filter.parent === null ? [rootId] : [childId]),
  });
  try {
    const filter = await paanCornerProductExclusion();
    assert.equal(filter.$nor.length, 4);
    assert.deepEqual(filter.$nor[2].categoryRef.$in, [rootId]);
    assert.deepEqual(filter.$nor[3].subcategoryRef.$in, [rootId, childId]);
  } finally {
    Category.find = originalFind;
  }
});
