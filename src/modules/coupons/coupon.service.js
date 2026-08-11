import { Coupon } from './coupon.model.js';
import { AppError } from '../../shared/utils/AppError.js';

export function calculateDiscount(coupon, subtotal) {
  const raw = coupon.type === 'percentage' ? subtotal * (coupon.value / 100) : coupon.value;
  return Math.min(raw, coupon.maxDiscount || raw, subtotal);
}

export async function validateCoupon(code, subtotal) {
  if (!code) return { coupon: null, discount: 0 };
  const now = new Date();
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
  if (!coupon) throw new AppError('Invalid coupon', 404, 'COUPON_NOT_FOUND');
  if (coupon.startsAt > now || coupon.endsAt < now) throw new AppError('Coupon is not active', 400, 'COUPON_INACTIVE');
  if (subtotal < coupon.minOrderValue) throw new AppError(`Minimum order value is Rs ${coupon.minOrderValue}`, 400, 'COUPON_MIN_ORDER');
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) throw new AppError('Coupon usage limit reached', 400, 'COUPON_LIMIT_REACHED');
  return { coupon, discount: calculateDiscount(coupon, subtotal) };
}

export async function createCoupon(payload) {
  return Coupon.create({ ...payload, code: payload.code.toUpperCase() });
}

export async function listCoupons() {
  return Coupon.find().sort({ createdAt: -1 });
}

export async function listActiveCouponOffers() {
  const now = new Date();
  return Coupon.find({
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gte: now },
    $or: [
      { usageLimit: 0 },
      { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
    ],
  }).sort({ value: -1, createdAt: -1 }).limit(20);
}
