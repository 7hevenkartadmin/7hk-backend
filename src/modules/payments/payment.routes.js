import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { paymentCreationRateLimiter, paymentRateLimiter } from '../../shared/middlewares/rateLimiters.js';
import { AppError } from '../../shared/utils/AppError.js';
import { createRazorpayOrderSchema, idempotencyKeySchema, paymentSessionIdSchema, verifyPaymentSchema } from './payment.validation.js';
import { abandonRazorpayPaymentSession, createRazorpayCheckoutSession, getPaymentSession, reconcileRazorpayPaymentSession, verifyRazorpayPayment } from './payment.service.js';
import { getRazorpayMethodCatalog } from './paymentMethods.service.js';
import { isAndroidRequest } from '../../shared/middlewares/clientPlatform.js';

export const paymentRoutes = Router();

paymentRoutes.get('/razorpay/methods', requireAuth, authorize('customer'), paymentRateLimiter, asyncHandler(async (req, res) => {
  ok(res, { methods: await getRazorpayMethodCatalog() }, 'Razorpay payment methods loaded');
}));

paymentRoutes.post('/razorpay/order', requireAuth, authorize('customer'), paymentCreationRateLimiter, validate(createRazorpayOrderSchema), asyncHandler(async (req, res) => {
  const parsedKey = idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
  if (!parsedKey.success) throw new AppError('A valid Idempotency-Key header is required', 422, 'IDEMPOTENCY_KEY_REQUIRED');
  ok(res, { payment: await createRazorpayCheckoutSession(req.body, req.user, parsedKey.data, { excludePaanCorner: isAndroidRequest(req) }) }, 'Razorpay checkout session ready');
}));

paymentRoutes.post('/razorpay/verify', requireAuth, authorize('customer'), paymentRateLimiter, validate(verifyPaymentSchema), asyncHandler(async (req, res) => {
  ok(res, { payment: await verifyRazorpayPayment(req.body, req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Payment verified');
}));

paymentRoutes.get('/razorpay/sessions/:id', requireAuth, authorize('customer'), paymentRateLimiter, asyncHandler(async (req, res) => {
  const parsedId = paymentSessionIdSchema.safeParse(req.params.id);
  if (!parsedId.success) throw new AppError('Invalid payment session ID', 422, 'PAYMENT_SESSION_ID_INVALID');
  ok(res, { payment: await getPaymentSession(parsedId.data, req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Payment session loaded');
}));

paymentRoutes.post('/razorpay/sessions/:id/reconcile', requireAuth, authorize('customer'), paymentRateLimiter, asyncHandler(async (req, res) => {
  const parsedId = paymentSessionIdSchema.safeParse(req.params.id);
  if (!parsedId.success) throw new AppError('Invalid payment session ID', 422, 'PAYMENT_SESSION_ID_INVALID');
  ok(res, { payment: await reconcileRazorpayPaymentSession(parsedId.data, req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Payment session reconciled');
}));

paymentRoutes.post('/razorpay/sessions/:id/abandon', requireAuth, authorize('customer'), paymentRateLimiter, asyncHandler(async (req, res) => {
  const parsedId = paymentSessionIdSchema.safeParse(req.params.id);
  if (!parsedId.success) throw new AppError('Invalid payment session ID', 422, 'PAYMENT_SESSION_ID_INVALID');
  ok(res, { payment: await abandonRazorpayPaymentSession(parsedId.data, req.user, { excludePaanCorner: isAndroidRequest(req) }) }, 'Unpaid payment session abandoned');
}));
