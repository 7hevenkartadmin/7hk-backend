import mongoose from 'mongoose';

export const COUPON_REDEMPTION_STATUSES = ['reserved', 'consumed', 'released'];

function currentStatus(context) {
  return context.status
    || context.get?.('status')
    || context.getUpdate?.()?.$set?.status;
}

const couponRedemptionSchema = new mongoose.Schema({
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  codeSnapshot: { type: String, trim: true, uppercase: true, required: true },
  status: { type: String, enum: COUPON_REDEMPTION_STATUSES, required: true, default: 'reserved', index: true },
  active: { type: Boolean, required: true, default: true, index: true },
  paymentIntent: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentIntent' },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  reservedAt: { type: Date, required: true, default: Date.now },
  consumedAt: Date,
  releasedAt: Date,
  releaseReason: { type: String, trim: true },
}, { timestamps: true });

// Only one live reservation or permanent redemption can exist for a customer
// and coupon. Released checkout attempts remain available for audit but do not
// prevent a future retry.
couponRedemptionSchema.index(
  { coupon: 1, user: 1 },
  {
    name: 'coupon_redemption_active_user_unique',
    unique: true,
    partialFilterExpression: { active: true },
  },
);
couponRedemptionSchema.index(
  { paymentIntent: 1 },
  {
    name: 'coupon_redemption_payment_intent_unique',
    unique: true,
    partialFilterExpression: { paymentIntent: { $type: 'objectId' } },
  },
);
couponRedemptionSchema.index(
  { order: 1 },
  {
    name: 'coupon_redemption_order_unique',
    unique: true,
    partialFilterExpression: { order: { $type: 'objectId' } },
  },
);
couponRedemptionSchema.index({ coupon: 1, status: 1, createdAt: -1 });
couponRedemptionSchema.index({ user: 1, status: 1, createdAt: -1 });

couponRedemptionSchema.path('active').validate(function validateActiveState(value) {
  return currentStatus(this) === 'released' ? value === false : value === true;
}, 'Active state must match redemption status');

couponRedemptionSchema.path('consumedAt').validate(function validateConsumedAt(value) {
  return currentStatus(this) !== 'consumed' || Boolean(value);
}, 'Consumed redemptions require consumedAt');

couponRedemptionSchema.path('releasedAt').validate(function validateReleasedAt(value) {
  return currentStatus(this) !== 'released' || Boolean(value);
}, 'Released redemptions require releasedAt');

export const CouponRedemption = mongoose.model('CouponRedemption', couponRedemptionSchema);
