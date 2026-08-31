import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  provider: { type: String, enum: ['razorpay', 'cod'], required: true },
  providerOrderId: String,
  providerPaymentId: String,
  providerSignature: String,
  amount: { type: Number, min: 0, required: true },
  providerFeePaise: { type: Number, min: 0 },
  providerTaxPaise: { type: Number, min: 0 },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'], default: 'created' },
  amountRefunded: { type: Number, min: 0, default: 0 },
  processedRefundIds: { type: [String], default: [] },
  refundReason: String,
  raw: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

paymentSchema.index(
  { providerOrderId: 1 },
  { name: 'payment_provider_order_unique', unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } },
);
paymentSchema.index(
  { providerPaymentId: 1 },
  { name: 'payment_provider_payment_unique', unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);

export const Payment = mongoose.model('Payment', paymentSchema);
