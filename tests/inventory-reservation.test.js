import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Product } from '../src/modules/catalog/product.model.js';
import { InventoryMovement } from '../src/modules/orders/inventoryMovement.model.js';
import {
  consumeReservedInventory,
  releaseReservedInventory,
  reserveInventory,
  sellAvailableInventory,
} from '../src/modules/inventory/inventory.service.js';
import {
  MAX_ITEM_QUANTITY,
  assertItemQuantity,
  maxOrderableQuantity,
  netAvailableStock,
} from '../src/shared/utils/inventory.js';

function withStubs(stubs, callback) {
  const originals = stubs.map(({ object, method }) => ({ object, method, value: object[method] }));
  stubs.forEach(({ object, method, implementation }) => { object[method] = implementation; });
  return Promise.resolve().then(callback).finally(() => {
    originals.forEach(({ object, method, value }) => { object[method] = value; });
  });
}

function productFixture({ stock = 12, reservedStock = 2 } = {}) {
  const product = new Product({
    _id: new mongoose.Types.ObjectId(),
    name: 'Reserved Rice',
    slug: `reserved-rice-${new mongoose.Types.ObjectId()}`,
    category: 'grocery',
    mrp: 100,
    price: 90,
    unit: '1 kg',
    sku: `RICE-${new mongoose.Types.ObjectId()}`,
    variants: [{
      _id: new mongoose.Types.ObjectId(),
      title: '1 kg',
      unit: '1 kg',
      sku: `RICE-V-${new mongoose.Types.ObjectId()}`,
      mrp: 100,
      price: 90,
      stock,
      reservedStock,
      isDefault: true,
      isActive: true,
    }],
  });
  const saves = [];
  product.save = async (options) => {
    saves.push(options);
    await product.validate();
    return product;
  };
  return { product, variant: product.variants[0], saves };
}

function queryReturning(items, calls) {
  return {
    session(session) { calls.push(['session', session]); return this; },
    then(resolve, reject) { return Promise.resolve(items).then(resolve, reject); },
  };
}

test('shared item quantity and net availability helpers enforce the public cap', () => {
  assert.equal(MAX_ITEM_QUANTITY, 10);
  assert.equal(assertItemQuantity(1), 1);
  assert.equal(assertItemQuantity(10), 10);
  assert.throws(() => assertItemQuantity(0), { code: 'ITEM_QUANTITY_LIMIT' });
  assert.throws(() => assertItemQuantity(11), { code: 'ITEM_QUANTITY_LIMIT' });
  assert.equal(netAvailableStock(7, 3), 4);
  assert.equal(netAvailableStock(2, 8), 0);
  assert.equal(maxOrderableQuantity(50, 2), 10);
  assert.equal(maxOrderableQuantity(50, 2, { isActive: false }), 0);
});

test('reservation and release mutate reserved stock through Product save and refresh aggregates', async () => {
  const { product, variant, saves } = productFixture({ stock: 12, reservedStock: 2 });
  const calls = [];
  const item = { productId: String(product._id), variantId: String(variant._id), quantity: 3 };

  await withStubs([
    { object: Product, method: 'find', implementation: () => queryReturning([product], calls) },
  ], async () => {
    const reserved = await reserveInventory([item], 'mongo-session');
    assert.equal(reserved.items[0].quantity, 3);
    assert.equal(variant.reservedStock, 5);
    assert.equal(product.reservedStock, 5);
    assert.equal(product.availableStock, 7);

    await releaseReservedInventory(reserved.items, 'mongo-session');
    assert.equal(variant.reservedStock, 2);
    assert.equal(product.reservedStock, 2);
    assert.equal(product.availableStock, 10);
  });

  assert.deepEqual(calls, [['session', 'mongo-session'], ['session', 'mongo-session']]);
  assert.equal(saves.length, 2);
  assert.equal(saves.every((entry) => entry.session === 'mongo-session'), true);
});

test('COD inventory refuses stock reserved by another checkout', async () => {
  const { product, variant } = productFixture({ stock: 5, reservedStock: 4 });
  await withStubs([
    { object: Product, method: 'find', implementation: () => queryReturning([product], []) },
  ], async () => {
    await assert.rejects(
      () => sellAvailableInventory([{ productId: product._id, variantId: variant._id, quantity: 2 }], new mongoose.Types.ObjectId(), null, 'session'),
      { code: 'INSUFFICIENT_STOCK', details: { maxOrderableQuantity: 1 } },
    );
  });
  assert.equal(variant.stock, 5);
});

test('paid order consumption decrements stock and its reservation and writes an idempotent movement', async () => {
  const { product, variant } = productFixture({ stock: 8, reservedStock: 3 });
  const orderId = new mongoose.Types.ObjectId();
  let movementRows;

  await withStubs([
    { object: Product, method: 'find', implementation: () => queryReturning([product], []) },
    { object: InventoryMovement, method: 'create', implementation: async (rows, options) => { movementRows = rows; assert.equal(options.session, 'session'); return rows; } },
  ], async () => {
    await consumeReservedInventory(
      [{ product: product._id, variantId: variant._id, quantity: 3 }],
      orderId,
      null,
      'session',
    );
  });

  assert.equal(variant.stock, 5);
  assert.equal(variant.reservedStock, 0);
  assert.equal(product.stock, 5);
  assert.equal(product.reservedStock, 0);
  assert.equal(product.availableStock, 5);
  assert.equal(movementRows[0].type, 'order_sold');
  assert.equal(movementRows[0].quantityDelta, -3);
  assert.match(movementRows[0].idempotencyKey, new RegExp(String(orderId)));
});

test('Razorpay and order request schemas share the ten-unit item boundary', async () => {
  const { createOrderSchema } = await import('../src/modules/orders/order.validation.js');
  const { createRazorpayOrderSchema } = await import('../src/modules/payments/payment.validation.js');
  const base = {
    items: [{ productId: '507f1f77bcf86cd799439011', quantity: 10 }],
    addressId: '507f1f77bcf86cd799439012',
    slotId: '507f1f77bcf86cd799439013',
  };
  assert.equal(createRazorpayOrderSchema.safeParse(base).success, true);
  assert.equal(createRazorpayOrderSchema.safeParse({ ...base, items: [{ ...base.items[0], quantity: 11 }] }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...base, paymentMethod: 'cod', codTermsAccepted: true }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...base, paymentMethod: 'cod', items: [{ ...base.items[0], quantity: 11 }] }).success, false);
});

test('PaymentIntent validates typed reservation ownership fields', async () => {
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const productId = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  const slotId = new mongoose.Types.ObjectId();
  const expiresAt = new Date(Date.now() + 60_000);
  const intent = new PaymentIntent({
    user: new mongoose.Types.ObjectId(),
    providerOrderId: `pending_${new mongoose.Types.ObjectId()}`,
    receipt: '7hk_test_reservation',
    amount: 100,
    amountPaise: 10000,
    cartHash: 'a'.repeat(64),
    addressId: new mongoose.Types.ObjectId(),
    slotId,
    checkoutSnapshot: { items: [], totals: { total: 100 } },
    reservation: {
      state: 'held',
      items: [{ product: productId, variantId, quantity: 2 }],
      expiresAt,
      slot: slotId,
    },
    expiresAt,
  });

  assert.equal(intent.validateSync(), undefined);
  assert.equal(String(intent.reservation.items[0].product), String(productId));
  assert.equal(String(intent.reservation.slot), String(slotId));
  assert.equal(intent.reservation.state, 'held');
});

test('expired captured reservation becomes a durable released refund job instead of extending forever', async () => {
  const { DeliverySlot } = await import('../src/modules/delivery/deliverySlot.model.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const { sweepExpiredPaymentReservations } = await import('../src/modules/payments/payment.service.js');
  const now = new Date('2026-08-14T10:00:00.000Z');
  const slotId = new mongoose.Types.ObjectId();
  const intent = {
    _id: new mongoose.Types.ObjectId(),
    status: 'verified',
    providerPaymentId: 'pay_captured_expired',
    verifiedPaymentId: 'pay_captured_expired',
    amountPaise: 10000,
    amountRefundedPaise: 0,
    reservation: { state: 'held', items: [], slot: slotId, expiresAt: now },
    activeDedupeKey: 'active-checkout',
    async save() { return this; },
  };
  const session = {
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  };
  const emptySweepQuery = {
    sort() { return this; },
    limit(value) { assert.equal(value, 25); return Promise.resolve([]); },
  };
  const sweepQuery = {
    sort() { return this; },
    limit(value) { assert.equal(value, 50); return Promise.resolve([intent]); },
  };
  const intentQuery = {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(intent).then(resolve, reject); },
  };
  let releaseFilter;

  await withStubs([
    { object: mongoose, method: 'startSession', implementation: async () => session },
    { object: PaymentIntent, method: 'find', implementation: (filter) => (
      filter.status?.$in ? emptySweepQuery : sweepQuery
    ) },
    { object: PaymentIntent, method: 'findOne', implementation: (filter) => { releaseFilter = filter; return intentQuery; } },
    { object: PaymentIntent, method: 'findOneAndUpdate', implementation: async () => null },
    { object: PaymentIntent, method: 'findById', implementation: async () => intent },
    { object: Product, method: 'find', implementation: () => queryReturning([], []) },
    { object: DeliverySlot, method: 'findOneAndUpdate', implementation: async () => ({ _id: slotId }) },
  ], async () => {
    const result = await sweepExpiredPaymentReservations({ now });
    assert.deepEqual(result, { inspected: 1, released: 1, extended: 0, refunded: 0, skipped: 1 });
  });

  assert.equal(releaseFilter.status.$in.includes('verified'), true);
  assert.equal(intent.status, 'refund_pending');
  assert.equal(intent.refundReason, 'RESERVATION_EXPIRED');
  assert.equal(intent.reservation.state, 'released');
  assert.equal(intent.activeDedupeKey, undefined);
  assert.ok(intent.refundReceipt.startsWith('rf_'));
});

test('Razorpay checkout retry reuses its existing hold before live stock validation', async () => {
  const { createCartHash, createRazorpayCheckoutSession } = await import('../src/modules/payments/payment.service.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const addressId = new mongoose.Types.ObjectId();
  const slotId = new mongoose.Types.ObjectId();
  const items = [{ productId: String(new mongoose.Types.ObjectId()), quantity: 3 }];
  const total = 250;
  const intent = {
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    amount: total,
    amountPaise: total * 100,
    currency: 'INR',
    cartHash: createCartHash(items, 'LASTONE', total, addressId, slotId),
    addressId,
    slotId,
    checkoutSnapshot: { items, couponCode: 'LASTONE', totals: { total } },
    providerOrderId: 'order_existing',
    providerStatus: 'created',
    status: 'created',
    reservation: { state: 'held', expiresAt: new Date(Date.now() + 60_000) },
  };

  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async () => intent },
    { object: Product, method: 'find', implementation: () => { throw new Error('live inventory must not be revalidated'); } },
  ], async () => {
    const payment = await createRazorpayCheckoutSession(
      { items, couponCode: 'LASTONE', addressId: String(addressId), slotId: String(slotId) },
      { _id: intent.user },
      'retry-key-123456789',
    );
    assert.equal(payment.sessionId, String(intent._id));
    assert.equal(payment.orderId, 'order_existing');
  });
});

test('provider payment state updates compare-and-set against a held reservation', async () => {
  const { applyRazorpayWebhookPayment } = await import('../src/modules/payments/payment.service.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const intent = {
    _id: new mongoose.Types.ObjectId(),
    providerOrderId: 'order_race',
    amountPaise: 10000,
    currency: 'INR',
    status: 'created',
    reservation: { state: 'held' },
  };
  const released = { ...intent, reservation: { state: 'released' } };
  let updateFilter;

  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async () => intent },
    { object: PaymentIntent, method: 'findOneAndUpdate', implementation: async (filter) => { updateFilter = filter; return null; } },
    { object: PaymentIntent, method: 'findById', implementation: async () => released },
  ], async () => {
    const result = await applyRazorpayWebhookPayment({
      id: 'pay_race',
      order_id: 'order_race',
      amount: 10000,
      currency: 'INR',
      status: 'authorized',
      captured: false,
    });
    assert.equal(result.reservation.state, 'released');
  });

  assert.equal(updateFilter['reservation.state'], 'held');
});

test('generic reservation release excludes captured/processing ownership and supports refund repair states', async () => {
  const { releasePaymentIntentReservation } = await import('../src/modules/payments/payment.service.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  let releaseFilter;
  const session = {
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  };
  const query = {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(null).then(resolve, reject); },
  };

  await withStubs([
    { object: mongoose, method: 'startSession', implementation: async () => session },
    { object: PaymentIntent, method: 'findOne', implementation: (filter) => { releaseFilter = filter; return query; } },
  ], async () => {
    assert.equal(await releasePaymentIntentReservation(new mongoose.Types.ObjectId(), 'FINALIZATION_FAILED'), null);
  });

  assert.equal(releaseFilter.status.$in.includes('verified'), false);
  assert.equal(releaseFilter.status.$in.includes('processing'), false);
  assert.equal(releaseFilter.status.$in.includes('refund_pending'), true);
  assert.equal(releaseFilter.status.$in.includes('refund_failed'), true);
  assert.equal(releaseFilter.status.$in.includes('refunded'), true);
  assert.equal(releaseFilter['reservation.state'], 'held');
});

test('authorized reservation expiry is bounded and duplicate callers never own provider initialization', async () => {
  const {
    AUTHORIZED_RESERVATION_MAX_MS,
    nextAuthorizedReservationExpiry,
    shouldInitializeProvider,
  } = await import('../src/modules/payments/payment.service.js');
  const authorizedAt = new Date('2026-08-14T10:00:00.000Z');
  const beforeDeadline = new Date(authorizedAt.getTime() + 5 * 60 * 1000);
  const expiry = nextAuthorizedReservationExpiry({ authorizedAt }, beforeDeadline);
  assert.equal(expiry.getTime(), beforeDeadline.getTime() + 10 * 60 * 1000);
  assert.equal(nextAuthorizedReservationExpiry({ authorizedAt }, new Date(authorizedAt.getTime() + AUTHORIZED_RESERVATION_MAX_MS)), null);
  assert.equal(shouldInitializeProvider(true, { status: 'initializing' }), true);
  assert.equal(shouldInitializeProvider(false, { status: 'initializing' }), false);
  assert.equal(shouldInitializeProvider(true, { status: 'created' }), false);
});

test('processed refund id is counted once even when delivered under different webhook events', async () => {
  const { applyRefund } = await import('../src/modules/payments/razorpay.webhook.js');
  const { Payment } = await import('../src/modules/payments/payment.model.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const { Order } = await import('../src/modules/orders/order.model.js');
  const payment = {
    amount: 100,
    amountRefunded: 0,
    processedRefundIds: [],
    status: 'captured',
    order: new mongoose.Types.ObjectId(),
  };
  const intent = { _id: new mongoose.Types.ObjectId(), status: 'consumed' };
  const orderUpdates = [];
  let intentUpdate;

  await withStubs([
    { object: Payment, method: 'findOneAndUpdate', implementation: async (filter, pipeline) => {
      assert.equal(filter.processedRefundIds.$ne, 'rf_processed');
      if (payment.processedRefundIds.includes(filter.processedRefundIds.$ne)) return null;
      payment.processedRefundIds.push(filter.processedRefundIds.$ne);
      const increment = pipeline[0].$set.amountRefunded.$min[1].$add[1];
      payment.amountRefunded = Math.min(payment.amount, payment.amountRefunded + increment);
      payment.status = payment.amountRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
      return payment;
    } },
    { object: Payment, method: 'findOne', implementation: async () => payment },
    { object: Order, method: 'updateOne', implementation: async (filter, update) => { orderUpdates.push({ filter, update }); } },
    { object: PaymentIntent, method: 'findOne', implementation: async () => intent },
    { object: PaymentIntent, method: 'updateOne', implementation: async (filter, update) => { intentUpdate = { filter, update }; } },
  ], async () => {
    const refund = { id: 'rf_processed', payment_id: 'pay_refunded', amount: 4000, status: 'processed' };
    await applyRefund(refund);
    await applyRefund(refund);
  });

  assert.equal(payment.status, 'partially_refunded');
  assert.equal(payment.amountRefunded, 40);
  assert.deepEqual(payment.processedRefundIds, ['rf_processed']);
  assert.equal(orderUpdates.every(({ update }) => update.$set.paymentStatus === 'partially_refunded'), true);
  assert.deepEqual(orderUpdates[0].filter.paymentStatus.$in, ['pending', 'paid']);
  assert.equal(intentUpdate.update.$set.providerStatus, 'partially_refunded');
});

test('late capture webhook uses monotonic Payment and Order filters', async () => {
  const { processWebhook } = await import('../src/modules/payments/razorpay.webhook.js');
  const { Payment } = await import('../src/modules/payments/payment.model.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const { Order } = await import('../src/modules/orders/order.model.js');
  const intent = {
    _id: new mongoose.Types.ObjectId(),
    providerOrderId: 'order_late',
    amountPaise: 10000,
    currency: 'INR',
    status: 'refunded',
    reservation: { state: 'released' },
  };
  let paymentFilter;
  let orderFilter;

  await withStubs([
    { object: PaymentIntent, method: 'findOne', implementation: async () => intent },
    { object: Payment, method: 'updateOne', implementation: async (filter) => { paymentFilter = filter; } },
    { object: Order, method: 'updateOne', implementation: async (filter) => { orderFilter = filter; } },
    { object: Order, method: 'findOne', implementation: async () => null },
  ], async () => {
    await processWebhook({
      event: 'payment.captured',
      payload: { payment: { entity: {
        id: 'pay_late',
        order_id: 'order_late',
        amount: 10000,
        currency: 'INR',
        status: 'captured',
        captured: true,
      } } },
    });
  });

  assert.deepEqual(paymentFilter.status.$in, ['created', 'authorized']);
  assert.equal(orderFilter.paymentStatus, 'pending');
  assert.deepEqual(orderFilter.status, { $ne: 'cancelled' });
});

test('order cancellation restores and durably queues once across repeated calls', async () => {
  const { DeliverySlot } = await import('../src/modules/delivery/deliverySlot.model.js');
  const { cancelOrder } = await import('../src/modules/orders/order.service.js');
  const { Order } = await import('../src/modules/orders/order.model.js');
  const { Payment } = await import('../src/modules/payments/payment.model.js');
  const { PaymentIntent } = await import('../src/modules/payments/paymentIntent.model.js');
  const orderId = new mongoose.Types.ObjectId();
  const intentId = new mongoose.Types.ObjectId();
  const slotId = new mongoose.Types.ObjectId();
  const actor = { _id: new mongoose.Types.ObjectId() };
  const intent = {
    _id: intentId,
    order: orderId,
    status: 'consumed',
    amountPaise: 10000,
    amountRefundedPaise: 0,
    providerPaymentId: 'pay_cancel_once',
    reservation: { state: 'consumed' },
    async save() { return this; },
  };
  const order = {
    _id: orderId,
    orderNumber: 'ORD-CANCEL-ONCE',
    customer: new mongoose.Types.ObjectId(),
    items: [],
    slot: { slotId },
    status: 'placed',
    statusTimeline: [],
    paymentMethod: 'razorpay',
    paymentStatus: 'paid',
    paymentIntent: intentId,
    total: 100,
    async save() { return this; },
  };
  const payment = { amount: 100, amountRefunded: 0 };
  const session = {
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  };
  const queryFor = (value) => ({
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  });
  let slotReleases = 0;
  let refundReasonWrites = 0;

  await withStubs([
    { object: mongoose, method: 'startSession', implementation: async () => session },
    { object: Order, method: 'findById', implementation: () => queryFor(order) },
    { object: Product, method: 'find', implementation: () => queryReturning([], []) },
    { object: DeliverySlot, method: 'findOneAndUpdate', implementation: async () => { slotReleases += 1; return {}; } },
    { object: Payment, method: 'findOne', implementation: () => queryFor(payment) },
    { object: Payment, method: 'updateOne', implementation: async () => { refundReasonWrites += 1; } },
    { object: PaymentIntent, method: 'findOne', implementation: () => queryFor(intent) },
    { object: PaymentIntent, method: 'findOneAndUpdate', implementation: async () => null },
    { object: PaymentIntent, method: 'findById', implementation: async () => intent },
  ], async () => {
    const first = await cancelOrder(orderId, { note: 'Customer request' }, actor);
    const second = await cancelOrder(orderId, { note: 'Duplicate request' }, actor);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
  });

  assert.equal(slotReleases, 1);
  assert.equal(refundReasonWrites, 1);
  assert.equal(order.status, 'cancelled');
  assert.ok(order.inventoryRestoredAt instanceof Date);
  assert.equal(order.statusTimeline.length, 1);
  assert.equal(intent.status, 'refund_pending');
  assert.equal(intent.refundReason, 'ORDER_CANCELLED');
  assert.equal(intent.reservation.state, 'consumed');
});