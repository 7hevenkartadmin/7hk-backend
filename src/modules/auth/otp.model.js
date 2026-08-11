import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 },
  consumedAt: Date,
}, { timestamps: true });

export const OtpChallenge = mongoose.model('OtpChallenge', otpSchema);
