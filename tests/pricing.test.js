import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCartTotals, defaultDeliveryFee } from '../src/modules/orders/pricing.service.js';
import { calculateDiscount } from '../src/modules/coupons/coupon.service.js';
import { createCartHash } from '../src/modules/payments/payment.service.js';

test('calculates grocery cart totals with tax, discount, and delivery fee', () => {
  const items = [
    { price: 100, quantity: 2, taxRate: 5 },
    { price: 50, quantity: 1, taxRate: 0 },
  ];

  const totals = calculateCartTotals({ items, couponDiscount: 40, deliveryFee: 30 });

  assert.deepEqual(totals, {
    subtotal: 250,
    tax: 10,
    discount: 40,
    deliveryFee: 30,
    total: 250,
  });
});

test('keeps discount capped to coupon max and subtotal', () => {
  const coupon = { type: 'percentage', value: 50, maxDiscount: 80 };
  assert.equal(calculateDiscount(coupon, 500), 80);
  assert.equal(calculateDiscount({ type: 'flat', value: 999, maxDiscount: 0 }, 300), 300);
});

test('waives delivery fee above free delivery threshold', () => {
  assert.equal(defaultDeliveryFee(498), 30);
  assert.equal(defaultDeliveryFee(499), 0);
});

test('payment cart hash is stable by item order and changes with total', () => {
  const itemsA = [
    { productId: '507f1f77bcf86cd799439011', quantity: 2 },
    { productId: '507f1f77bcf86cd799439012', quantity: 1 },
  ];
  const itemsB = [...itemsA].reverse();

  assert.equal(createCartHash(itemsA, 'FRESH50', 250), createCartHash(itemsB, 'FRESH50', 250));
  assert.notEqual(createCartHash(itemsA, 'FRESH50', 250), createCartHash(itemsA, 'FRESH50', 251));
});
