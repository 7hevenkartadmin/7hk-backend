import mongoose from 'mongoose';

const paymentIntentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['razorpay'], default: 'razorpay', required: true },
  providerOrderId: { type: String, unique: true, index: true },
  providerPaymentId: { type: String },
  idempotencyKey: { type: String },
  activeDedupeKey: { type: String },
  receipt: { type: String, required: true, index: true },
  amount: { type: Number, min: 0, required: true },
  amountPaise: { type: Number, min: 0, required: true },
  currency: { type: String, default: 'INR' },
  cartHash: { type: String, required: true, index: true },
  addressId: { type: mongoose.Schema.Types.ObjectId, required: true },
  checkoutSnapshot: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['initializing', 'created', 'authorized', 'verified', 'processing', 'consumed', 'failed', 'refund_pending', 'refunded', 'refund_failed'], default: 'initializing', index: true },
  providerStatus: String,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
  raw: mongoose.Schema.Types.Mixed,
  verifiedPaymentId: String,
  verifiedSignature: String,
  failureCode: String,
  failureDescription: String,
  refundId: String,
  refundStatus: String,
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

export const PaymentIntent = mongoose.model('PaymentIntent', paymentIntentSchema);
