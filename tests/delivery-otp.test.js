import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryOtpForOrder, matchesDeliveryOtp } from '../src/modules/orders/delivery-otp.service.js';

test('delivery OTP is deterministic, six digits, and bound to one order', () => {
  const firstOrder = '66bdf14a4f88e91d20a91a11';
  const secondOrder = '66bdf14a4f88e91d20a91a12';
  const otp = deliveryOtpForOrder(firstOrder);

  assert.match(otp, /^\d{6}$/);
  assert.equal(deliveryOtpForOrder(firstOrder), otp);
  assert.notEqual(deliveryOtpForOrder(secondOrder), otp);
});

test('delivery OTP comparison accepts only the exact order-bound code', () => {
  const orderId = '66bdf14a4f88e91d20a91a11';
  const otp = deliveryOtpForOrder(orderId);

  assert.equal(matchesDeliveryOtp(orderId, otp), true);
  assert.equal(matchesDeliveryOtp(orderId, `${otp}0`), false);
  assert.equal(matchesDeliveryOtp(orderId, '000000'), otp === '000000');
  assert.equal(matchesDeliveryOtp('66bdf14a4f88e91d20a91a12', otp), false);
});
