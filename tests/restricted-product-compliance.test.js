import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRestrictedProductConsentForOrder,
  assertRestrictedProductCouponAllowed,
  restrictedProductPolicyForItems,
} from '../src/modules/compliance/restrictedProductConsent.service.js';
import { restrictedProductConsentSchema } from '../src/modules/compliance/restrictedProductConsent.validation.js';
import { createOrderSchema, verifyDeliveryOtpSchema } from '../src/modules/orders/order.validation.js';
import { RestrictedProductConsent } from '../src/modules/compliance/restrictedProductConsent.model.js';
import { Order } from '../src/modules/orders/order.model.js';
import { verifyDeliveryOtp } from '../src/modules/orders/order.service.js';

const productId = '507f1f77bcf86cd799439011';
const addressId = '507f1f77bcf86cd799439012';
const consentId = '507f1f77bcf86cd799439013';
const customerId = '507f1f77bcf86cd799439014';
const paanItem = { product: { categoryRef: { slug: 'paan-corner', name: 'Paan Corner' } } };

test('restricted-product policy requires adult consent, COD, and no coupons', () => {
  const policy = restrictedProductPolicyForItems([paanItem]);
  assert.equal(policy.consentRequired, true);
  assert.equal(policy.minimumAge, 18);
  assert.equal(policy.educationalInstitutionMinimumDistanceYards, 100);
  assert.equal(policy.cashOnDeliveryOnly, true);
  assert.equal(policy.couponsAllowed, false);
  assert.throws(
    () => assertRestrictedProductCouponAllowed([paanItem], 'SAVE10'),
    (error) => error.code === 'RESTRICTED_PRODUCT_COUPON_NOT_ALLOWED' && error.statusCode === 422,
  );
});

test('restricted-product acknowledgement accepts only explicit true declarations', () => {
  const valid = {
    legalAgeConfirmed: true,
    educationalInstitutionDistanceConfirmed: true,
    healthWarningAcknowledged: true,
    addressId,
  };
  assert.equal(restrictedProductConsentSchema.safeParse(valid).success, true);
  assert.equal(restrictedProductConsentSchema.safeParse({ ...valid, legalAgeConfirmed: false }).success, false);
  assert.equal(restrictedProductConsentSchema.safeParse({ ...valid, educationalInstitutionDistanceConfirmed: 'true' }).success, false);
  assert.equal(restrictedProductConsentSchema.safeParse({ ...valid, extra: true }).success, false);
});

test('backend rejects a restricted order without a valid address-bound receipt', async () => {
  await assert.rejects(
    () => assertRestrictedProductConsentForOrder({
      items: [paanItem],
      customer: { _id: customerId },
      addressId,
    }),
    (error) => error.code === 'RESTRICTED_PRODUCT_CONSENT_REQUIRED' && error.statusCode === 422,
  );
});

test('order contract accepts a valid consent id and rejects malformed ids', () => {
  const order = {
    items: [{ productId, quantity: 1 }],
    addressId,
    slotId: '507f1f77bcf86cd799439015',
    paymentMethod: 'cod',
    restrictedProductConsentId: consentId,
  };
  assert.equal(createOrderSchema.safeParse(order).success, true);
  assert.equal(createOrderSchema.safeParse({ ...order, restrictedProductConsentId: 'not-an-id' }).success, false);
});

test('consent records expire automatically and support address-bound lookup', () => {
  const indexes = RestrictedProductConsent.schema.indexes();
  assert.ok(indexes.some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));
  assert.ok(indexes.some(([key]) => key.user === 1 && key.addressId === 1 && key.policyVersion === 1 && key.expiresAt === -1));
});

test('restricted delivery cannot be completed without explicit staff checks', async () => {
  const originalFindById = Order.findById;
  Order.findById = () => ({
    select: async () => ({
      _id: productId,
      status: 'out_for_delivery',
      paymentMethod: 'cod',
      restrictedProductConsent: { policyVersion: '2026-08-25' },
    }),
  });
  try {
    await assert.rejects(
      () => verifyDeliveryOtp(productId, '000000', { _id: customerId }),
      (error) => error.code === 'RESTRICTED_PRODUCT_DELIVERY_CHECKS_REQUIRED' && error.statusCode === 422,
    );
  } finally {
    Order.findById = originalFindById;
  }

  assert.equal(verifyDeliveryOtpSchema.safeParse({ otp: '123456', restrictedProductChecksConfirmed: true }).success, true);
  assert.equal(verifyDeliveryOtpSchema.safeParse({ otp: '123456', restrictedProductChecksConfirmed: 'true' }).success, false);
});
