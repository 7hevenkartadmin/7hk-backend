import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { AppError } from '../../shared/utils/AppError.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { applyCouponSchema, couponSchema } from './coupon.validation.js';
import { createCoupon, listActiveCouponOffers, listCoupons, updateCoupon, validateCoupon } from './coupon.service.js';

export const couponRoutes = Router();

couponRoutes.get('/offers', asyncHandler(async (_req, res) => {
  ok(res, { coupons: await listActiveCouponOffers() }, 'Coupon offers loaded');
}));

couponRoutes.post('/apply', validate(applyCouponSchema), asyncHandler(async (req, res) => {
  const result = await validateCoupon(req.body.code, req.body.subtotal);
  if (!result.coupon) {
    throw new AppError('Coupon not found or invalid', 400, 'COUPON_INVALID');
  }
  ok(res, { code: result.coupon.code, discount: result.discount }, 'Coupon applied');
}));

couponRoutes.use(requireAuth, authorize('admin', 'manager'));

couponRoutes.get('/', asyncHandler(async (_req, res) => {
  ok(res, { coupons: await listCoupons() }, 'Coupons loaded');
}));

couponRoutes.post('/', validate(couponSchema), asyncHandler(async (req, res) => {
  created(res, { coupon: await createCoupon(req.body) }, 'Coupon created');
}));

couponRoutes.patch('/:id/status', asyncHandler(async (req, res) => {
  if (typeof req.body.isActive !== 'boolean') throw new AppError('isActive must be a boolean', 422, 'VALIDATION_ERROR');
  ok(res, { coupon: await updateCoupon(req.params.id, { isActive: req.body.isActive }) }, 'Coupon status updated');
}));
