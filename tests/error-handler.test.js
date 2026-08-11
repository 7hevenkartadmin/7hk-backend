import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/shared/utils/AppError.js';
import { errorHandler } from '../src/shared/middlewares/errorHandler.js';

function mockReq() {
  return {
    method: 'GET',
    originalUrl: '/broken',
    headers: { 'x-request-id': 'test-request-id' },
  };
}

function mockRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('global error handler returns consistent operational error payload', () => {
  const res = mockRes();
  errorHandler(new AppError('Missing location', 422, 'LOCATION_REQUIRED'), mockReq(), res, () => {});

  assert.equal(res.statusCode, 422);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.code, 'LOCATION_REQUIRED');
  assert.equal(res.payload.requestId, 'test-request-id');
});

test('global error handler normalizes duplicate key errors', () => {
  const res = mockRes();
  errorHandler({ code: 11000, keyPattern: { phone: 1 } }, mockReq(), res, () => {});

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'DUPLICATE_RESOURCE');
  assert.deepEqual(res.payload.details, { fields: ['phone'] });
});
