import test from 'node:test';
import assert from 'node:assert/strict';
import { couponSchema } from '../src/modules/coupons/coupon.validation.js';
import { deliverySlotSchema } from '../src/modules/delivery/delivery.validation.js';
import { createOrderSchema, quoteOrderSchema, updateStatusSchema } from '../src/modules/orders/order.validation.js';
import { storeSettingsSchema } from '../src/modules/settings/settings.validation.js';
import { addressSchema } from '../src/modules/users/user.validation.js';

const productId = '507f1f77bcf86cd799439011';

test('order quote validation rejects invalid product ids and unsafe quantities', () => {
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId: 'bad-id', quantity: 1 }] }).success, false);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, quantity: 0 }] }).success, false);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, quantity: 100 }] }).success, false);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, quantity: 2 }] }).success, true);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, variantId: '507f1f77bcf86cd799439099', quantity: 2 }] }).success, true);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, quantity: 2 }], addressId: '507f1f77bcf86cd799439013' }).success, true);
  assert.equal(quoteOrderSchema.safeParse({ items: [{ productId, variantId: 'bad-variant', quantity: 2 }] }).success, false);
});

test('order creation requires address or addressId and Razorpay proof for online payment', () => {
  const baseOrder = {
    items: [{ productId, quantity: 1 }],
    slotId: '507f1f77bcf86cd799439012',
    paymentMethod: 'cod',
  };

  assert.equal(createOrderSchema.safeParse(baseOrder).success, false);
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, addressId: '507f1f77bcf86cd799439013' }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...baseOrder, addressId: '507f1f77bcf86cd799439013', paymentMethod: 'razorpay' }).success, false);
  assert.equal(createOrderSchema.safeParse({
    ...baseOrder,
    addressId: '507f1f77bcf86cd799439013',
    paymentMethod: 'razorpay',
    razorpayPayment: {
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'validsignature',
    },
  }).success, true);
});

test('order status validation allows only supported operational statuses', () => {
  assert.equal(updateStatusSchema.safeParse({ status: 'packed' }).success, true);
  assert.equal(updateStatusSchema.safeParse({ status: 'refunded' }).success, false);
});

test('coupon validation enforces positive validity window and defaults', () => {
  const valid = couponSchema.safeParse({
    code: 'FRESH50',
    type: 'flat',
    value: 50,
    startsAt: '2026-06-01',
    endsAt: '2026-06-30',
  });

  assert.equal(valid.success, true);
  assert.equal(valid.data.maxDiscount, 0);
  assert.equal(valid.data.isActive, true);

  assert.equal(couponSchema.safeParse({
    code: 'BAD',
    type: 'flat',
    value: 10,
    startsAt: '2026-06-30',
    endsAt: '2026-06-01',
  }).success, false);
});

test('delivery slot validation rejects malformed windows and capacity', () => {
  assert.equal(deliverySlotSchema.safeParse({
    date: '2026-06-30',
    startsAt: '10:00',
    endsAt: '12:00',
    capacity: 50,
  }).success, true);

  assert.equal(deliverySlotSchema.safeParse({
    date: '2026-06-30',
    startsAt: '12:00',
    endsAt: '10:00',
    capacity: 50,
  }).success, false);

  assert.equal(deliverySlotSchema.safeParse({
    date: '2026-06-30',
    startsAt: '10:00',
    endsAt: '12:00',
    capacity: 0,
  }).success, false);
});

test('store settings validation accepts COD fraud controls and rejects unsafe values', () => {
  assert.equal(storeSettingsSchema.safeParse({
    codSettings: {
      isEnabled: true,
      maxOrderValue: 1500,
      maxPendingOrdersPerCustomer: 2,
      maxCancelledOrdersInWindow: 2,
      cancellationWindowDays: 30,
      terms: 'Cash is collected at delivery. Repeated cancellations may disable COD.',
    },
  }).success, true);

  assert.equal(storeSettingsSchema.safeParse({
    codSettings: {
      isEnabled: true,
      maxOrderValue: -1,
      maxPendingOrdersPerCustomer: 2,
      maxCancelledOrdersInWindow: 2,
      cancellationWindowDays: 30,
      terms: 'Too short',
    },
  }).success, false);
});

test('saved address validation requires map coordinates and backend-compatible details', () => {
  const address = {
    label: 'Home', recipientName: 'Customer', phone: '9876543210', flatNumber: '3A',
    formattedAddress: 'Main Road', line1: '3A, Main Road', line2: 'Main Road', landmark: '',
    city: 'Parihar', state: 'Bihar', pincode: '843324', latitude: 26.713, longitude: 85.686, isDefault: true,
  };
  assert.equal(addressSchema.safeParse(address).success, true);
  assert.equal(addressSchema.safeParse({ ...address, latitude: undefined }).success, false);
  assert.equal(addressSchema.safeParse({ ...address, label: 'Friend' }).success, false);
});
