import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authorize } from '../src/modules/auth/auth.middleware.js';
import { createCartHash, verifyRazorpaySignature } from '../src/modules/payments/payment.service.js';
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
  const user = { id: '507f1f77bcf86cd799439011', role: 'admin' };
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  const accessPayload = verifyAccessToken(accessToken);
  const refreshPayload = verifyRefreshToken(refreshToken);

  assert.equal(accessPayload.sub, user.id);
  assert.equal(accessPayload.role, 'admin');
  assert.equal(refreshPayload.sub, user.id);
  assert.ok(refreshPayload.tokenVersion);
});

test('token hashing is deterministic and does not expose raw token', () => {
  const token = 'refresh-token-value';
  assert.equal(hashToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(hashToken(token), token);
});

test('payment cart hash changes when coupon, quantity, total, or delivery address changes', () => {
  const items = [{ productId: '507f1f77bcf86cd799439011', quantity: 2 }];
  const baseHash = createCartHash(items, 'FRESH50', 250, '507f1f77bcf86cd799439012');

  assert.notEqual(baseHash, createCartHash(items, 'SAVE10', 250, '507f1f77bcf86cd799439012'));
  assert.notEqual(baseHash, createCartHash([{ ...items[0], quantity: 3 }], 'FRESH50', 250, '507f1f77bcf86cd799439012'));
  assert.notEqual(baseHash, createCartHash(items, 'FRESH50', 251, '507f1f77bcf86cd799439012'));
  assert.notEqual(baseHash, createCartHash(items, 'FRESH50', 250, '507f1f77bcf86cd799439013'));
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

test('tokens cannot be verified with the wrong secret', () => {
  const token = jwt.sign({ sub: 'user-id' }, `${env.JWT_ACCESS_SECRET}-wrong`);
  assert.throws(() => verifyAccessToken(token));
});
