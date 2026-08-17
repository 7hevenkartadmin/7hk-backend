import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';

const loginCompletionSchema = new mongoose.Schema({
  proofDigest: {
    type: String,
    required: true,
    immutable: true,
    select: false,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  },
  role: {
    type: String,
    enum: ['customer', 'admin', 'manager', 'support'],
    required: true,
    immutable: true,
  },
  issuedAt: { type: Date, required: true, immutable: true },
  tokenVersion: { type: Number, required: true, min: 0, immutable: true },
  accessJti: { type: String, required: true, immutable: true, select: false },
  refreshJti: { type: String, required: true, immutable: true, select: false },
  accessExpiresAt: { type: Date, required: true, immutable: true },
  refreshExpiresAt: { type: Date, required: true, immutable: true },
}, {
  timestamps: false,
  versionKey: false,
});

loginCompletionSchema.index(
  { proofDigest: 1 },
  { unique: true, name: 'login_completion_proof_digest_unique' },
);

export function digestLoginProof(proofId) {
  if (typeof proofId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proofId)) {
    throw new TypeError('Verified login proof is invalid');
  }
  return crypto.createHmac('sha256', env.OTP_HMAC_SECRET).update(proofId).digest('hex');
}

export const LoginCompletion = mongoose.model('LoginCompletion', loginCompletionSchema);
