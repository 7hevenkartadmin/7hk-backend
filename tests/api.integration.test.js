import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestClient } from './helpers/http.js';
import { env } from '../src/config/env.js';

test('health endpoint returns service status with security headers', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/health', {
    headers: { Origin: env.CORS_ORIGINS[0] || 'http://localhost:5173' },
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.service, '7Heven API');
  assert.equal(body.status, 'healthy');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('unknown API route returns normalized 404 payload', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/missing-route');

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.code, 'ROUTE_NOT_FOUND');
  assert.equal(body.statusCode, 404);
  assert.match(body.message, /Route not found/);
});

test('public auth OTP request rejects invalid body before service work', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ phone: '123' }),
  });

  assert.equal(response.status, 422);
  assert.equal(body.success, false);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.ok(body.details.fieldErrors.phone.length > 0);
});

test('admin routes require authentication before returning data', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/admin/customers');

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.code, 'AUTH_REQUIRED');
});

test('invalid bearer token is rejected as an invalid session', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/admin/customers', {
    headers: { Authorization: 'Bearer not-a-real-jwt' },
  });

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.code, 'INVALID_SESSION');
});

test('order quote route is protected before order calculations run', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/orders/quote', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: 'not-a-valid-id', quantity: 0 }],
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.code, 'AUTH_REQUIRED');
});

test('coupon apply route rejects invalid payload through route validation', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/coupons/apply', {
    method: 'POST',
    body: JSON.stringify({ code: 'A', subtotal: -1 }),
  });

  assert.equal(response.status, 422);
  assert.equal(body.success, false);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.ok(body.details.fieldErrors.code.length > 0);
  assert.ok(body.details.fieldErrors.subtotal.length > 0);
});

test('malformed JSON returns normalized client error', async (t) => {
  const client = await createTestClient();
  t.after(() => client.close());

  const { response, body } = await client.request('/api/v1/auth/otp/request', {
    method: 'POST',
    body: '{"phone":',
  });

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.code, 'MALFORMED_JSON');
});

// **Validates: Requirements 2.6**
test('production health fails closed when MongoDB transaction capability is unavailable', async (t) => {
  let checks = 0;
  const client = await createTestClient({
    requireTransactionHealthCheck: true,
    async databaseTransactionCheck() {
      checks += 1;
      throw new Error('synthetic transaction capability failure');
    },
  });
  t.after(() => client.close());

  const { response, body } = await client.request('/health');

  assert.equal(checks, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    success: false,
    service: '7Heven API',
    status: 'unhealthy',
  });
});
