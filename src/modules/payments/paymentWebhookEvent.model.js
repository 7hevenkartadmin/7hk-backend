import mongoose from 'mongoose';

const paymentWebhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true },
  eventType: { type: String, required: true, index: true },
  providerOrderId: String,
  providerPaymentId: String,
  status: { type: String, enum: ['processing', 'processed', 'ignored', 'failed'], default: 'processing', index: true },
  failure: String,
  processedAt: Date,
}, { timestamps: true });

paymentWebhookEventSchema.index({ eventId: 1 }, { name: 'razorpay_webhook_event_unique', unique: true });

export const PaymentWebhookEvent = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);
