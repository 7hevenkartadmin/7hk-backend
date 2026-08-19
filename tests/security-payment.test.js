import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authorize } from '../src/modules/auth/auth.middleware.js';
import { createCartHash, validateProviderPayment, verifyRazorpaySignature } from '../src/modules/payments/payment.service.js';
import { extractRazorpayWebhookPayment, isValidRazorpayWebhookSignature } from '../src/modules/payments/razorpay.webhook.js';
import { hashToken, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../src/modules/auth/token.service.js';
import { env } from '../src/config/env.js';

function runAuthorize(roles, user) {
  return new Promise((resolve) => {
    const middleware = authorize(...roles);
    middleware({ user }, {}, (error) => resolve(error || null));
  });
}

test('authorization middleware allows matching roles and rejects missing or wrong roles', async () => {
  assert.equal(await runAuthorize(['admin'], { role: 'admin' }), null);

  const missingUserError = await runAuthorize(['admin'], null);
  assert.equal(missingUserError.statusCode, 401);
  assert.equal(missingUserError.code, 'AUTH_REQUIRED');

  const forbiddenError = await runAuthorize(['admin'], { role: 'customer' });
  assert.equal(forbiddenError.statusCode, 403);
  assert.equal(forbiddenError.code, 'FORBIDDEN');
});

test('access and refresh tokens carry expected claims and verify with configured secrets', () => {
  const user = { id: '507f1f77bcf86cd799439011', role: 'admin', tokenVersion: 0 };
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  const accessPayload = verifyAccessToken(accessToken);
  const refreshPayload = verifyRefreshToken(refreshToken);

  assert.equal(accessPayload.sub, user.id);
  assert.equal(accessPayload.role, 'admin');
  assert.equal(accessPayload.type, 'access');
  assert.equal(accessPayload.tokenVersion, 0);
  assert.equal(refreshPayload.sub, user.id);
  assert.equal(refreshPayload.type, 'refresh');
  assert.equal(refreshPayload.tokenVersion, 0);
  assert.equal(accessPayload.iss, '7heaven-api');
  assert.deepEqual(accessPayload.aud, '7heaven-web');
});

test('token hashing is deterministic and does not expose raw token', () => {
  const token = 'refresh-token-value';
  assert.equal(hashToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(hashToken(token), token);
});

test('payment cart hash changes when coupon, quantity, total, delivery address, or slot changes', () => {
  const items = [{ productId: '507f1f77bcf86cd799439011', quantity: 2 }];
  const addressId = '507f1f77bcf86cd799439012';
  const slotId = '507f1f77bcf86cd799439014';
  const baseHash = createCartHash(items, 'FRESH50', 250, addressId, slotId);

  assert.notEqual(baseHash, createCartHash(items, 'SAVE10', 250, addressId, slotId));
  assert.notEqual(baseHash, createCartHash([{ ...items[0], quantity: 3 }], 'FRESH50', 250, addressId, slotId));
  assert.notEqual(baseHash, createCartHash(items, 'FRESH50', 251, addressId, slotId));
  assert.notEqual(baseHash, createCartHash(items, 'FRESH50', 250, '507f1f77bcf86cd799439013', slotId));
  assert.notEqual(baseHash, createCartHash(items, 'FRESH50', 250, addressId, '507f1f77bcf86cd799439015'));
});

test('razorpay signature verification rejects tampered payload when secret is configured', () => {
  if (!env.RAZORPAY_KEY_SECRET) {
    assert.doesNotThrow(() => verifyRazorpaySignature({
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'development-mock-signature',
    }));
    return;
  }

  const payload = {
    razorpay_order_id: 'order_123',
    razorpay_payment_id: 'pay_123',
  };
  const validSignature = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${payload.razorpay_order_id}|${payload.razorpay_payment_id}`)
    .digest('hex');

  assert.doesNotThrow(() => verifyRazorpaySignature({ ...payload, razorpay_signature: validSignature }));
  assert.throws(() => verifyRazorpaySignature({ ...payload, razorpay_signature: 'tampered' }), /Payment signature verification failed/);
});

test('provider confirmation must match order, amount, and currency before capture is trusted', () => {
  const intent = { providerOrderId: 'order_expected', amountPaise: 25900, currency: 'INR' };
  const valid = { id: 'pay_valid', order_id: 'order_expected', amount: 25900, currency: 'INR', status: 'captured' };
  assert.equal(validateProviderPayment(valid, intent), valid);
  assert.throws(() => validateProviderPayment({ ...valid, order_id: 'order_other' }, intent), /does not match/);
  assert.throws(() => validateProviderPayment({ ...valid, amount: 25800 }, intent), /does not match/);
  assert.throws(() => validateProviderPayment({ ...valid, currency: 'USD' }, intent), /does not match/);
});

test('Razorpay webhook verification uses the exact raw body and extracts payment entities', () => {
  const rawBody = Buffer.from(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_123', order_id: 'order_123', status: 'captured' } } },
  }));
  const secret = 'dedicated-webhook-secret';
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(isValidRazorpayWebhookSignature(rawBody, signature, secret), true);
  assert.equal(isValidRazorpayWebhookSignature(Buffer.concat([rawBody, Buffer.from(' ')]), signature, secret), false);
  assert.equal(extractRazorpayWebhookPayment(JSON.parse(rawBody)).id, 'pay_123');
});

test('tokens cannot be verified with the wrong secret', () => {
  const token = jwt.sign({ sub: 'user-id' }, `${env.JWT_ACCESS_SECRET}-wrong`);
  assert.throws(() => verifyAccessToken(token));
});
