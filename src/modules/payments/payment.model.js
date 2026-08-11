import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  provider: { type: String, enum: ['razorpay', 'cod'], required: true },
  providerOrderId: String,
  providerPaymentId: String,
  providerSignature: String,
  amount: { type: Number, min: 0, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['created', 'authorized', 'captured', 'failed'], default: 'created' },
  raw: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const Payment = mongoose.model('Payment', paymentSchema);
