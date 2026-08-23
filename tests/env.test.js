import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema } from '../src/modules/auth/auth.validation.js';
import { productSchema } from '../src/modules/catalog/catalog.validation.js';
import { createOrderSchema } from '../src/modules/orders/order.validation.js';
import { createRazorpayOrderSchema, verifyPaymentSchema } from '../src/modules/payments/payment.validation.js';

test('register schema enforces strong enough customer password', () => {
  const weak = registerSchema.safeParse({ name: 'Aman', phone: '9876543210', password: '123' });
  assert.equal(weak.success, false);
});

test('product schema accepts barcode information supplied by client', () => {
  const parsed = productSchema.safeParse({
    name: 'Test Rice',
    category: 'grains',
    mrp: 200,
    price: 180,
    unit: '1 kg',
    sku: 'GR-TST',
    barcode: { value: '8901234567890' },
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.barcode.format, 'EAN-13');
});

test('online order schema requires Razorpay payment proof', () => {
  const parsed = createOrderSchema.safeParse({
    items: [{ productId: '507f1f77bcf86cd799439011', quantity: 1 }],
    address: {
      recipientName: 'Aman',
      phone: '9876543210',
      line1: '7 Heaven Store Road',
      city: 'Singhwahini',
      pincode: '843324',
      latitude: 26.713,
      longitude: 85.686,
    },
    slotId: '507f1f77bcf86cd799439012',
    paymentMethod: 'razorpay',
  });

  assert.equal(parsed.success, false);
});

test('Razorpay order creation requires a saved address and rejects client-supplied distance', () => {
  const base = {
    items: [{ productId: '507f1f77bcf86cd799439011', quantity: 1 }],
    slotId: '507f1f77bcf86cd799439013',
  };
  assert.equal(createRazorpayOrderSchema.safeParse({ ...base, addressId: '507f1f77bcf86cd799439012' }).success, true);
  assert.equal(createRazorpayOrderSchema.safeParse({ ...base, addressId: '507f1f77bcf86cd799439012', distanceFromStoreKm: 0 }).success, false);
  assert.equal(createRazorpayOrderSchema.safeParse({ items: base.items, addressId: '507f1f77bcf86cd799439012' }).success, false);
});

test('Razorpay verification requires the internal session and all provider proof fields', () => {
  const proof = {
    paymentSessionId: '507f1f77bcf86cd799439011',
    razorpay_order_id: 'order_abc123',
    razorpay_payment_id: 'pay_abc123',
    razorpay_signature: 'a'.repeat(64),
  };
  assert.equal(verifyPaymentSchema.safeParse(proof).success, true);
  assert.equal(verifyPaymentSchema.safeParse({ ...proof, paymentSessionId: undefined }).success, false);
  assert.equal(verifyPaymentSchema.safeParse({ ...proof, razorpay_signature: 'tampered' }).success, false);
});
