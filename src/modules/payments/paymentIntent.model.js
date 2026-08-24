import mongoose from 'mongoose';

export const PAYMENT_RESERVATION_STATES = ['held', 'consuming', 'consumed', 'released'];

const reservationItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: mongoose.Schema.Types.ObjectId,
  quantity: { type: Number, min: 1, max: 10, required: true },
}, { _id: false });

const reservationSchema = new mongoose.Schema({
  state: { type: String, enum: PAYMENT_RESERVATION_STATES, required: true, default: 'held' },
  items: { type: [reservationItemSchema], default: [] },
  expiresAt: { type: Date, required: true },
  slot: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliverySlot', required: true },
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
  couponRedemption: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponRedemption' },
  releasedAt: Date,
  consumedAt: Date,
  releaseReason: String,
}, { _id: false });

const paymentIntentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['razorpay'], default: 'razorpay', required: true },
  providerOrderId: { type: String, unique: true, index: true },
  providerPaymentId: { type: String },
  idempotencyKey: { type: String },
  activeDedupeKey: { type: String },
  receipt: { type: String, required: true, index: true },
  amount: { type: Number, min: 1, required: true },
  amountPaise: { type: Number, min: 100, required: true },
  currency: { type: String, default: 'INR' },
  cartHash: { type: String, required: true, index: true },
  addressId: { type: mongoose.Schema.Types.ObjectId, required: true },
  slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliverySlot', required: true },
  checkoutSnapshot: mongoose.Schema.Types.Mixed,
  reservation: { type: reservationSchema, required: true },
  status: { type: String, enum: ['initializing', 'created', 'authorized', 'verified', 'processing', 'consumed', 'failed', 'refund_pending', 'refunded', 'refund_failed'], default: 'initializing', index: true },
  providerStatus: String,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
  raw: mongoose.Schema.Types.Mixed,
  verifiedPaymentId: String,
  verifiedSignature: String,
  authorizedAt: Date,
  failureCode: String,
  failureDescription: String,
  refundId: String,
  refundStatus: String,
  refundRequestedAt: Date,
  refundReason: String,
  refundAmountPaise: { type: Number, min: 0 },
  refundReceipt: String,
  refundAttemptCount: { type: Number, min: 0, default: 0 },
  nextRefundAttemptAt: Date,
  amountRefundedPaise: { type: Number, min: 0, default: 0 },
  processedRefundIds: { type: [String], default: [] },
  lastProviderSyncAt: Date,
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

paymentIntentSchema.index(
  { user: 1, idempotencyKey: 1 },
  { name: 'payment_intent_user_idempotency_unique', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentIntentSchema.index(
  { activeDedupeKey: 1 },
  { name: 'payment_intent_active_dedupe_unique', unique: true, partialFilterExpression: { activeDedupeKey: { $type: 'string' } } },
);
paymentIntentSchema.index(
  { providerPaymentId: 1 },
  { name: 'payment_intent_provider_payment_unique', unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);
paymentIntentSchema.index(
  { 'reservation.state': 1, 'reservation.expiresAt': 1 },
  { name: 'payment_intent_reservation_expiry' },
);
paymentIntentSchema.index(
  { user: 1, status: 1, 'reservation.state': 1 },
  { name: 'payment_intent_user_active_sessions' },
);
paymentIntentSchema.index(
  { status: 1, nextRefundAttemptAt: 1, 'reservation.state': 1 },
  { name: 'payment_intent_refund_retry' },
);

export const PaymentIntent = mongoose.model('PaymentIntent', paymentIntentSchema);
