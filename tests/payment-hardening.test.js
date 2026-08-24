import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Product } from '../src/modules/catalog/product.model.js';
import { DeliverySlot } from '../src/modules/delivery/deliverySlot.model.js';
import { deliveryAddressForOrder } from '../src/modules/orders/order.service.js';
import { createOrderSchema, quoteOrderSchema } from '../src/modules/orders/order.validation.js';
import { PaymentIntent } from '../src/modules/payments/paymentIntent.model.js';
import { PaymentWebhookEvent } from '../src/modules/payments/paymentWebhookEvent.model.js';
import {
  MAX_ACTIVE_PAYMENT_SESSIONS_PER_CUSTOMER,
  abandonRazorpayPaymentSession,
  createRazorpayCheckoutSession,
  getPaymentSession,
  getReservedSlotForIntent,
  getVerifiedPaymentIntentForOrder,
  paymentDeliveryAddressSnapshot,
  validateProviderPayment,
} from '../src/modules/payments/payment.service.js';
import { createRazorpayOrderSchema } from '../src/modules/payments/payment.validation.js';
import { WEBHOOK_PROCESSING_LEASE_MS, recordAndProcess } from '../src/modules/payments/razorpay.webhook.js';

function withStubs(stubs, callback) {
  const originals = stubs.map(({ object, method }) => ({ object, method, value: object[method] }));
  stubs.forEach(({ object, method, implementation }) => { object[method] = implementation; });
  return Promise.resolve().then(callback).finally(() => {
    originals.forEach(({ object, method, value }) => { object[method] = value; });
  });
}

function queryResult(value) {
  return {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

const ids = {
  product: '507f1f77bcf86cd799439011',
  address: '507f1f77bcf86cd799439012',
  slot: '507f1f77bcf86cd799439013',
  session: '507f1f77bcf86cd799439014',
};

test('payment and order schemas reject malformed IDs, unknown fields, raw callback proof, and mixed COD evidence', () => {
  const checkout = { items: [{ productId: ids.product, quantity: 1 }], addressId: ids.address, slotId: ids.slot };
  assert.equal(createRazorpayOrderSchema.safeParse(checkout).success, true);
  assert.equal(createRazorpayOrderSchema.safeParse({ ...checkout, items: [{ ...checkout.items[0], attackerPrice: 1 }] }).success, false);
  assert.equal(createRazorpayOrderSchema.safeParse({ ...checkout, items: [{ productId: 'not-an-object-id-but-long', quantity: 1 }] }).success, false);
  assert.equal(createRazorpayOrderSchema.safeParse({ ...checkout, total: 1 }).success, false);
  assert.equal(quoteOrderSchema.safeParse({ items: checkout.items, total: 1 }).success, false);

  const online = { ...checkout, paymentMethod: 'razorpay', paymentSessionId: ids.session };
  assert.equal(createOrderSchema.safeParse(online).success, true);
  assert.equal(createOrderSchema.safeParse({ ...online, razorpayPayment: { razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'x' } }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...checkout, paymentMethod: 'cod', paymentSessionId: ids.session }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...online, slotId: 'invalid-slot-id' }).success, false);
});

test('provider verification is bound to the exact callback payment ID', () => {
  const intent = { providerOrderId: 'order_expected', amountPaise: 15000, currency: 'INR' };
  const payment = { id: 'pay_fetched', order_id: 'order_expected', amount: 15000, currency: 'INR' };
  assert.equal(validateProviderPayment(payment, intent, 'pay_fetched'), payment);
  assert.throws(() => validateProviderPayment(payment, intent, 'pay_callback_other'), { code: 'PAYMENT_PROVIDER_MISMATCH' });
});

test('paid delivery address is immutable, whitelisted, and required', () => {
  const saved = {
    _id: ids.address,
    recipientName: 'Aman', phone: '9876543210', line1: 'Paid address', line2: '', landmark: 'Store',
    city: 'Sitamarhi', state: 'Bihar', pincode: '843324',
    latitude: env.STORE_LATITUDE, longitude: env.STORE_LONGITUDE, distanceFromStoreKm: 0,
    deliveryCharge: 999, userId: 'must-not-leak',
  };
  const snapshot = paymentDeliveryAddressSnapshot(saved);
  assert.equal(snapshot.line1, 'Paid address');
  assert.equal('deliveryCharge' in snapshot, false);
  assert.equal('userId' in snapshot, false);

  const mutableLiveAddress = { ...saved, line1: 'Edited after payment', latitude: 0, longitude: 0 };
  const selected = deliveryAddressForOrder('razorpay', mutableLiveAddress, { deliveryAddress: snapshot });
  assert.equal(selected.line1, 'Paid address');
  assert.equal(selected.distanceFromStoreKm, 0);
  assert.throws(() => deliveryAddressForOrder('razorpay', mutableLiveAddress, {}), { code: 'PAYMENT_SNAPSHOT_MISSING' });
});

test('active-session limit runs before any catalog or inventory read', async () => {
  let productRead = false;
  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async () => null },
    { object: PaymentIntent, method: 'countDocuments', implementation: async (filter) => {
      assert.deepEqual(filter.status.$in, ['initializing', 'created', 'authorized', 'verified', 'processing']);
      assert.deepEqual(filter['reservation.state'].$in, ['held', 'consuming']);
      return MAX_ACTIVE_PAYMENT_SESSIONS_PER_CUSTOMER;
    } },
    { object: Product, method: 'find', implementation: () => { productRead = true; throw new Error('must not read products'); } },
  ], async () => {
    await assert.rejects(
      () => createRazorpayCheckoutSession({ items: [{ productId: ids.product, quantity: 1 }], addressId: ids.address, slotId: ids.slot }, { _id: 'customer-1' }, 'checkout-key-123456'),
      { code: 'PAYMENT_SESSION_LIMIT', statusCode: 429 },
    );
  });
  assert.equal(productRead, false);
});

test('customer payment-session reads always scope by internal ID and authenticated owner', async () => {
  let lookup;
  const intent = { _id: ids.session, user: 'customer-1', amount: 100, amountPaise: 10000, currency: 'INR', status: 'created', reservation: {} };
  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async (filter) => { lookup = filter; return intent; } },
  ], async () => {
    const result = await getPaymentSession(ids.session, { _id: 'customer-1' });
    assert.equal(result.sessionId, ids.session);
  });
  assert.deepEqual(lookup, { _id: ids.session, user: 'customer-1' });
});

test('verified sessions fail closed when immutable fulfillment data is incomplete', async () => {
  const intent = { checkoutSnapshot: { items: [], totals: { total: 100 } } };
  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: () => queryResult(intent) },
  ], async () => {
    await assert.rejects(() => getVerifiedPaymentIntentForOrder(ids.session, { _id: 'customer-1' }), { code: 'PAYMENT_SNAPSHOT_MISSING' });
  });
});

test('paid orders retain the reserved delivery window after later slot edits', async () => {
  const intent = {
    reservation: { slot: ids.slot },
    checkoutSnapshot: { deliverySlot: { slotId: ids.slot, date: new Date('2026-08-25'), startsAt: '10:00', endsAt: '12:00', serviceArea: 'Zone A' } },
  };
  await withStubs([
    { object: DeliverySlot, method: 'findById', implementation: () => queryResult({ _id: ids.slot, startsAt: '15:00', endsAt: '17:00' }) },
  ], async () => {
    const slot = await getReservedSlotForIntent(intent);
    assert.equal(slot.startsAt, '10:00');
    assert.equal(slot.endsAt, '12:00');
  });
});

test('abandonment refuses captured-risk states and transactionally releases a failed checkout', async () => {
  const authorized = { _id: ids.session, status: 'authorized', reservation: { state: 'held' } };
  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async () => authorized },
    { object: mongoose, method: 'startSession', implementation: async () => { throw new Error('must not start a release transaction'); } },
  ], async () => {
    await assert.rejects(() => abandonRazorpayPaymentSession(ids.session, { _id: 'customer-1' }), { code: 'PAYMENT_ABANDON_NOT_ALLOWED' });
  });

  const failed = {
    _id: ids.session,
    user: 'customer-1',
    status: 'failed',
    failureCode: 'PAYMENT_PROVIDER_UNAVAILABLE',
    activeDedupeKey: 'active-cart',
    amount: 100,
    amountPaise: 10000,
    currency: 'INR',
    reservation: { state: 'held', items: [], slot: ids.slot, expiresAt: new Date(Date.now() + 60_000) },
    async save() { return this; },
  };
  let findCount = 0;
  const mongoSession = { async withTransaction(callback) { await callback(); }, async endSession() {} };
  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: () => {
      findCount += 1;
      return findCount === 1 ? Promise.resolve(failed) : queryResult(failed);
    } },
    { object: mongoose, method: 'startSession', implementation: async () => mongoSession },
    { object: Product, method: 'find', implementation: () => queryResult([]) },
    { object: DeliverySlot, method: 'findOneAndUpdate', implementation: async () => ({ _id: ids.slot }) },
  ], async () => {
    const result = await abandonRazorpayPaymentSession(ids.session, { _id: 'customer-1' });
    assert.equal(result.status, 'failed');
  });
  assert.equal(failed.failureCode, 'CLIENT_ABANDONED');
  assert.equal(failed.reservation.state, 'released');
  assert.equal(failed.activeDedupeKey, undefined);
});

test('duplicate webhook recovery uses one atomic stale-processing lease claim', async () => {
  const now = new Date('2026-08-24T10:00:00.000Z');
  let reclaimFilter;
  const record = { status: 'processing', async save() { return this; } };
  await withStubs([
    { object: PaymentWebhookEvent, method: 'create', implementation: async () => { const error = new Error('duplicate'); error.code = 11000; throw error; } },
    { object: PaymentWebhookEvent, method: 'findOneAndUpdate', implementation: async (filter, update, options) => {
      reclaimFilter = filter;
      assert.equal(update.$set.status, 'processing');
      assert.equal(options.new, true);
      return record;
    } },
  ], async () => {
    await recordAndProcess('evt-stale', { event: 'unhandled.event' }, { now });
  });
  assert.equal(reclaimFilter.eventId, 'evt-stale');
  assert.equal(reclaimFilter.$or[0].status, 'failed');
  assert.equal(reclaimFilter.$or[1].updatedAt.$lte.getTime(), now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  assert.equal(record.status, 'ignored');
});

test('legacy order imports resolve to the canonical hardened schemas', async () => {
  const canonical = await import('../src/modules/orders/order.validation.js');
  const legacy = await import('../src/modules/orders/org.order.validation.js');
  assert.equal(legacy.createOrderSchema, canonical.createOrderSchema);
  assert.equal(legacy.quoteOrderSchema, canonical.quoteOrderSchema);
  const canonicalPayment = await import('../src/modules/payments/payment.validation.js');
  const legacyPayment = await import('../src/modules/payments/org.payment.validation.js');
  assert.equal(legacyPayment.createRazorpayOrderSchema, canonicalPayment.createRazorpayOrderSchema);
  assert.equal(legacyPayment.verifyPaymentSchema, canonicalPayment.verifyPaymentSchema);
});
