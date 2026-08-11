import { Router } from 'express';
import { ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { createRazorpayOrderSchema, verifyPaymentSchema } from './payment.validation.js';
import { createRazorpayCheckoutSession, verifyRazorpayPayment } from './payment.service.js';

export const paymentRoutes = Router();

paymentRoutes.post('/razorpay/order', requireAuth, validate(createRazorpayOrderSchema), asyncHandler(async (req, res) => {
  ok(res, { payment: await createRazorpayCheckoutSession(req.body, req.user) }, 'Razorpay order created');
}));

paymentRoutes.post('/razorpay/verify', requireAuth, validate(verifyPaymentSchema), asyncHandler(async (req, res) => {
  ok(res, { payment: await verifyRazorpayPayment(req.body, req.user) }, 'Payment verified');
}));
