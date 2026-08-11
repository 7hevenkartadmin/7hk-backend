import mongoose from 'mongoose';

const paymentIntentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['razorpay'], default: 'razorpay', required: true },
  providerOrderId: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, min: 0, required: true },
  currency: { type: String, default: 'INR' },
  cartHash: { type: String, required: true, index: true },
  status: { type: String, enum: ['created', 'verified', 'consumed'], default: 'created', index: true },
  raw: mongoose.Schema.Types.Mixed,
  verifiedPaymentId: String,
  verifiedSignature: String,
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export const PaymentIntent = mongoose.model('PaymentIntent', paymentIntentSchema);
