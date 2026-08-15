import crypto from 'crypto';
import { AppError } from '../utils/AppError.js';
import { env } from '../../config/env.js';

const productionMessages = {
  AUTH_REQUIRED: 'Please login to continue.',
  INVALID_SESSION: 'Your session has expired. Please login again.',
  INVALID_CREDENTIALS: 'Invalid login details. Please try again.',
  OTP_INVALID: 'Invalid or expired OTP.',
  OTP_RATE_LIMITED: 'Too many OTP requests. Please try again later.',
  OTP_RESEND_COOLDOWN: 'Please wait before requesting another OTP.',
  ACCOUNT_BLOCKED: 'This account is unavailable.',
  REFRESH_REQUIRED: 'Your session has expired. Please login again.',
  INVALID_REFRESH: 'Your session has expired. Please login again.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  VALIDATION_ERROR: 'Please check the highlighted details and try again.',
  DUPLICATE_RESOURCE: 'This record already exists.',
  RESOURCE_NOT_FOUND: 'Requested resource was not found.',
  PAYMENT_SIGNATURE_INVALID: 'Payment verification failed. Please try again.',
  PAYMENT_INTENT_MISMATCH: 'Payment does not match this order. Please restart checkout.',
  PAYMENT_PROVIDER_AUTH_FAILED: 'Online payments are temporarily misconfigured. Please choose cash on delivery or contact support.',
  PAYMENT_PROVIDER_REQUEST_FAILED: 'The payment provider rejected this request. Please try again.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Online payments are temporarily unavailable. Please try again.',
  OUT_OF_DELIVERY_RADIUS: 'This address is outside the delivery area.',
  LOCATION_REQUIRED: 'Please select a delivery location on the map.',
  RATE_LIMITED: 'Too many requests. Please try again after some time.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

function publicMessage(error, statusCode, code) {
  if (env.NODE_ENV !== 'production') return error.message || productionMessages[code] || productionMessages.INTERNAL_ERROR;
  if (statusCode >= 500) return productionMessages.INTERNAL_ERROR;
  return productionMessages[code] || error.message || productionMessages.INTERNAL_ERROR;
}

function normalizeError(error) {
  if (error instanceof AppError) return error;

  if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
    return new AppError('Malformed JSON request body', 400, 'MALFORMED_JSON');
  }

  if (error?.name === 'ValidationError') {
    return new AppError('Validation failed', 422, 'VALIDATION_ERROR', Object.values(error.errors || {}).map((entry) => ({
      path: entry.path,
      message: entry.message,
    })));
  }

  if (error?.name === 'CastError') {
    return new AppError('Invalid resource identifier', 400, 'INVALID_ID', { path: error.path });
  }

  if (error?.code === 11000) {
    return new AppError('Duplicate resource', 409, 'DUPLICATE_RESOURCE', { fields: Object.keys(error.keyPattern || {}) });
  }

  if (error?.name === 'JsonWebTokenError' || error?.name === 'TokenExpiredError') {
    return new AppError('Invalid or expired session', 401, 'INVALID_SESSION');
  }

  if (error?.message === 'Not allowed by CORS') {
    return new AppError('Origin is not allowed', 403, 'CORS_NOT_ALLOWED');
  }

  return error;
}

export function notFound(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
}

export function errorHandler(error, req, res, _next) {
  const normalized = normalizeError(error);
  const statusCode = normalized.statusCode || 500;
  const code = normalized.code || 'INTERNAL_ERROR';
  const requestId = req.headers['x-request-id'] || crypto.randomUUID?.() || `${Date.now()}`;
  const payload = {
    success: false,
    message: publicMessage(normalized, statusCode, code),
    code,
    statusCode,
    requestId,
  };

  if (statusCode >= 500) {
    console.error('Internal Server Error:', { requestId, method: req.method, url: req.originalUrl, message: normalized.message, stack: normalized.stack });
  } else if (statusCode >= 400) {
    console.warn('Client Error:', { requestId, method: req.method, url: req.originalUrl, message: normalized.message, statusCode });
  }

  if (normalized.details) payload.details = normalized.details;
  if (env.NODE_ENV !== 'production') payload.stack = normalized.stack;

  res.status(statusCode).json(payload);
}
