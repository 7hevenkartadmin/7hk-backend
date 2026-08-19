import { AppError } from '../../shared/utils/AppError.js';
import { Coupon } from './coupon.model.js';

const occupiedCouponCountExpression = {
  $add: [
    { $ifNull: ['$usedCount', 0] },
    { $ifNull: ['$reservedCount', 0] },
  ],
};

function occupiedCouponCount(coupon) {
  return Number(coupon?.usedCount || 0) + Number(coupon?.reservedCount || 0);
}

export function calculateDiscount(coupon, subtotal) {
  const raw = coupon.type === 'percentage' ? subtotal * coupon.value / 100 : coupon.value;
  const capped = coupon.maxDiscount ? Math.min(raw, coupon.maxDiscount) : raw;
  return Math.min(subtotal, Math.max(0, Number(capped.toFixed(2))));
}

export async function validateCoupon(code, subtotal) {
  if (!code) return { coupon: null, discount: 0 };
  const now = new Date();
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
  if (!coupon) throw new AppError('Invalid coupon', 404, 'COUPON_NOT_FOUND');
  if (coupon.startsAt > now || coupon.endsAt < now) throw new AppError('Coupon is not active', 400, 'COUPON_INACTIVE');
  if (subtotal < coupon.minOrderValue) throw new AppError(`Minimum order value is Rs ${coupon.minOrderValue}`, 400, 'COUPON_MIN_ORDER');
  if (coupon.usageLimit && occupiedCouponCount(coupon) >= coupon.usageLimit) {
    throw new AppError('Coupon usage limit reached', 400, 'COUPON_LIMIT_REACHED');
  }
  return { coupon, discount: calculateDiscount(coupon, subtotal) };
}

export async function createCoupon(payload) {
  return Coupon.create({ ...payload, code: payload.code.toUpperCase() });
}

export async function listCoupons() {
  return Coupon.find().sort({ createdAt: -1 });
}

export async function updateCoupon(id, payload) {
  const usageLimit = Number(payload.usageLimit);
  const guardedLimit = payload.usageLimit !== undefined && Number.isFinite(usageLimit) && usageLimit > 0;
  const filter = guardedLimit
    ? { _id: id, $expr: { $lte: [occupiedCouponCountExpression, usageLimit] } }
    : { _id: id };
  const coupon = await Coupon.findOneAndUpdate(filter, payload, { new: true, runValidators: true });
  if (!coupon) {
    if (guardedLimit && await Coupon.exists({ _id: id })) {
      throw new AppError('Usage limit cannot be lower than current redemptions and reservations', 409, 'COUPON_LIMIT_BELOW_USAGE');
    }
    throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  }
  return coupon;
}

export async function listActiveCouponOffers() {
  const now = new Date();
  return Coupon.find({
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gte: now },
    $or: [
      { usageLimit: 0 },
      { $expr: { $lt: [occupiedCouponCountExpression, '$usageLimit'] } },
    ],
  }).sort({ value: -1, createdAt: -1 }).limit(20);
}

export async function claimCoupon(couponId, subtotal, session) {
  if (!couponId) return null;
  const now = new Date();
  const coupon = await Coupon.findOneAndUpdate(
    {
      _id: couponId,
      isActive: true,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
      minOrderValue: { $lte: subtotal },
      $or: [
        { usageLimit: 0 },
        { $expr: { $lt: [occupiedCouponCountExpression, '$usageLimit'] } },
      ],
    },
    { $inc: { reservedCount: 1 } },
    { new: true, session },
  );
  if (!coupon) throw new AppError('Coupon is no longer available', 409, 'COUPON_LIMIT_REACHED');
  return coupon;
}

export async function consumeCouponReservation(couponId, session) {
  if (!couponId) return null;
  return Coupon.findOneAndUpdate(
    { _id: couponId, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1, usedCount: 1 } },
    { new: true, session },
  );
}

export async function releaseCouponReservation(couponId, session) {
  if (!couponId) return null;
  return Coupon.findOneAndUpdate(
    { _id: couponId, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1 } },
    { new: true, session },
  );
}

export async function restoreConsumedCoupon(couponId, session) {
  if (!couponId) return null;
  return Coupon.findOneAndUpdate(
    { _id: couponId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
    { new: true, session },
  );
}
