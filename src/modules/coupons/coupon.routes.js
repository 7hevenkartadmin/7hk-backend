import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { AppError } from '../../shared/utils/AppError.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { applyCouponSchema, couponRedemptionQuerySchema, couponSchema } from './coupon.validation.js';
import { createCoupon, listActiveCouponOffers, listCouponRedemptions, listCoupons, updateCoupon, validateCoupon } from './coupon.service.js';
import { audit } from '../audit/audit.service.js';

export const couponRoutes = Router();

couponRoutes.use(requireAuth);

couponRoutes.get('/offers', authorize('customer'), asyncHandler(async (req, res) => {
  ok(res, { coupons: await listActiveCouponOffers(req.user._id) }, 'Coupon offers loaded');
}));

couponRoutes.post('/apply', authorize('customer'), validate(applyCouponSchema), asyncHandler(async (req, res) => {
  const result = await validateCoupon(req.body.code, req.body.subtotal, req.user._id);
  if (!result.coupon) {
    throw new AppError('Coupon not found or invalid', 400, 'COUPON_INVALID');
  }
  ok(res, { code: result.coupon.code, discount: result.discount }, 'Coupon applied');
}));

couponRoutes.use(authorize('admin', 'manager'));

couponRoutes.get('/', asyncHandler(async (_req, res) => {
  ok(res, { coupons: await listCoupons() }, 'Coupons loaded');
}));

couponRoutes.post('/', validate(couponSchema), asyncHandler(async (req, res) => {
  const coupon = await createCoupon(req.body);
  await audit({ req, action: 'coupon.create', entityType: 'Coupon', entityId: coupon._id, after: coupon });
  created(res, { coupon }, 'Coupon created');
}));

couponRoutes.get('/:id/redemptions', validate(couponRedemptionQuerySchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await listCouponRedemptions(req.params.id, req.query), 'Coupon redemptions loaded');
}));

couponRoutes.patch('/:id/status', asyncHandler(async (req, res) => {
  if (typeof req.body.isActive !== 'boolean') throw new AppError('isActive must be a boolean', 422, 'VALIDATION_ERROR');
  ok(res, { coupon: await updateCoupon(req.params.id, { isActive: req.body.isActive }) }, 'Coupon status updated');
}));
