import { AppError } from '../../shared/utils/AppError.js';
import { Coupon } from './coupon.model.js';
import { CouponRedemption } from './couponRedemption.model.js';

const occupiedCouponCountExpression = {
  $add: [
    { $ifNull: ['$usedCount', 0] },
    { $ifNull: ['$reservedCount', 0] },
  ],
};

function occupiedCouponCount(coupon) {
  return Number(coupon?.usedCount || 0) + Number(coupon?.reservedCount || 0);
}

function applySession(query, session) {
  if (session) query.session(session);
  return query;
}

function redemptionError(redemption) {
  if (redemption?.status === 'reserved') {
    return new AppError(
      'This coupon is already reserved by another checkout. Complete or let that checkout expire before retrying.',
      409,
      'COUPON_CHECKOUT_IN_PROGRESS',
    );
  }
  return new AppError(
    'This coupon can be used only once per customer and has already been redeemed.',
    409,
    'COUPON_ALREADY_REDEEMED',
  );
}

function withUsagePolicy(coupon, stats = {}) {
  const source = typeof coupon?.toObject === 'function' ? coupon.toObject() : coupon;
  return {
    ...source,
    perUserLimit: 1,
    usagePolicy: 'once_per_customer_permanent',
    redemptionStats: {
      uniqueCustomers: Number(stats.uniqueCustomers || 0),
      activeReservations: Number(stats.activeReservations || 0),
      releasedAttempts: Number(stats.releasedAttempts || 0),
    },
  };
}

async function redemptionStatsForCoupon(couponId) {
  const [stats] = await CouponRedemption.aggregate([
    { $match: { coupon: couponId } },
    {
      $group: {
        _id: '$coupon',
        uniqueCustomers: { $sum: { $cond: [{ $eq: ['$status', 'consumed'] }, 1, 0] } },
        activeReservations: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
        releasedAttempts: { $sum: { $cond: [{ $eq: ['$status', 'released'] }, 1, 0] } },
      },
    },
  ]);
  return stats || {};
}

export function calculateDiscount(coupon, subtotal) {
  const raw = coupon.type === 'percentage' ? subtotal * coupon.value / 100 : coupon.value;
  const capped = coupon.maxDiscount ? Math.min(raw, coupon.maxDiscount) : raw;
  return Math.min(subtotal, Math.max(0, Number(capped.toFixed(2))));
}

export async function validateCoupon(code, subtotal, userId, session) {
  if (!code) return { coupon: null, discount: 0 };
  const now = new Date();
  const couponQuery = Coupon.findOne({ code: String(code).trim().toUpperCase(), isActive: true });
  const coupon = await applySession(couponQuery, session);
  if (!coupon) throw new AppError('Invalid coupon', 404, 'COUPON_NOT_FOUND');
  if (coupon.startsAt > now || coupon.endsAt < now) throw new AppError('Coupon is not active', 400, 'COUPON_INACTIVE');
  if (subtotal < coupon.minOrderValue) throw new AppError(`Minimum order value is Rs ${coupon.minOrderValue}`, 400, 'COUPON_MIN_ORDER');
  if (coupon.usageLimit && occupiedCouponCount(coupon) >= coupon.usageLimit) {
    throw new AppError('Coupon usage limit reached', 400, 'COUPON_LIMIT_REACHED');
  }
  if (userId) {
    const redemptionQuery = CouponRedemption.findOne({ coupon: coupon._id, user: userId, active: true });
    const redemption = await applySession(redemptionQuery, session);
    if (redemption) throw redemptionError(redemption);
  }
  return { coupon, discount: calculateDiscount(coupon, subtotal) };
}

export async function createCoupon(payload) {
  return withUsagePolicy(await Coupon.create({ ...payload, code: String(payload.code).trim().toUpperCase() }));
}

export async function listCoupons() {
  const [coupons, grouped] = await Promise.all([
    Coupon.find().sort({ createdAt: -1 }).lean(),
    CouponRedemption.aggregate([
      {
        $group: {
          _id: '$coupon',
          uniqueCustomers: { $sum: { $cond: [{ $eq: ['$status', 'consumed'] }, 1, 0] } },
          activeReservations: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
          releasedAttempts: { $sum: { $cond: [{ $eq: ['$status', 'released'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const statsByCoupon = new Map(grouped.map((entry) => [String(entry._id), entry]));
  return coupons.map((coupon) => withUsagePolicy(coupon, statsByCoupon.get(String(coupon._id))));
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
  return withUsagePolicy(coupon, await redemptionStatsForCoupon(coupon._id));
}

export async function listActiveCouponOffers(userId) {
  const now = new Date();
  const unavailableCouponIds = userId
    ? await CouponRedemption.distinct('coupon', { user: userId, active: true })
    : [];
  const coupons = await Coupon.find({
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gte: now },
    ...(unavailableCouponIds.length ? { _id: { $nin: unavailableCouponIds } } : {}),
    $or: [
      { usageLimit: 0 },
      { $expr: { $lt: [occupiedCouponCountExpression, '$usageLimit'] } },
    ],
  }).sort({ value: -1, createdAt: -1 }).limit(20);
  return coupons.map((coupon) => withUsagePolicy(coupon));
}

export async function claimCoupon({ couponId, userId, subtotal, session, paymentIntentId, orderId }) {
  if (!couponId) return null;
  if (!userId) throw new AppError('Customer identity is required to redeem a coupon', 401, 'AUTH_REQUIRED');
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

  let redemption;
  try {
    [redemption] = await CouponRedemption.create([{
      coupon: coupon._id,
      user: userId,
      codeSnapshot: coupon.code,
      status: 'reserved',
      active: true,
      paymentIntent: paymentIntentId,
      order: orderId,
      reservedAt: now,
    }], { session });
  } catch (error) {
    // Production requires transactions, so the counter increment rolls back.
    // Keep the development fallback consistent when no transaction is present.
    if (!session) {
      await Coupon.updateOne(
        { _id: coupon._id, reservedCount: { $gt: 0 } },
        { $inc: { reservedCount: -1 } },
      ).catch(() => null);
    }
    if (error?.code === 11000) throw redemptionError();
    throw error;
  }
  return { coupon, redemption };
}

export async function consumeCouponReservation(redemptionId, orderId, session) {
  if (!redemptionId) return null;
  const now = new Date();
  const redemption = await CouponRedemption.findOneAndUpdate(
    { _id: redemptionId, status: 'reserved', active: true },
    { $set: { status: 'consumed', order: orderId, consumedAt: now } },
    { new: true, session, runValidators: true },
  );
  if (!redemption) return null;
  const coupon = await Coupon.findOneAndUpdate(
    { _id: redemption.coupon, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1, usedCount: 1 } },
    { new: true, session },
  );
  if (!coupon) {
    if (!session) {
      await CouponRedemption.updateOne(
        { _id: redemption._id, status: 'consumed', order: orderId },
        { $set: { status: 'reserved' }, $unset: { consumedAt: 1 } },
      ).catch(() => null);
    }
    throw new AppError('Coupon reservation counter is inconsistent', 409, 'COUPON_USAGE_MISMATCH');
  }
  return { coupon, redemption };
}

export async function releaseCouponReservation({ redemptionId, couponId, reason = 'CHECKOUT_RELEASED', session }) {
  if (redemptionId) {
    const now = new Date();
    const redemption = await CouponRedemption.findOneAndUpdate(
      { _id: redemptionId, status: 'reserved', active: true },
      { $set: { status: 'released', active: false, releasedAt: now, releaseReason: reason } },
      { new: true, session, runValidators: true },
    );
    if (!redemption) return null;
    const coupon = await Coupon.findOneAndUpdate(
      { _id: redemption.coupon, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1 } },
      { new: true, session },
    );
    if (!coupon) throw new AppError('Coupon reservation counter is inconsistent', 409, 'COUPON_USAGE_MISMATCH');
    return { coupon, redemption };
  }

  // Backward compatibility for payment intents created before the redemption
  // ledger was deployed. New reservations always include redemptionId.
  if (!couponId) return null;
  return Coupon.findOneAndUpdate(
    { _id: couponId, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1 } },
    { new: true, session },
  );
}

export async function listCouponRedemptions(couponId, { page = 1, limit = 50, status } = {}) {
  if (!await Coupon.exists({ _id: couponId })) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const filter = { coupon: couponId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    CouponRedemption.find(filter)
      .populate('user', 'name phone email')
      .populate('order', 'orderNumber status paymentStatus total')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    CouponRedemption.countDocuments(filter),
  ]);
  return {
    items,
    meta: { page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit)) },
  };
}
