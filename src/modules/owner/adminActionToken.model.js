import mongoose from 'mongoose';

const adminActionTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true, select: false },
  activeTokenKey: { type: String, select: false },
  type: { type: String, enum: ['admin_invite', 'admin_password_reset'], required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, lowercase: true, trim: true, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: Date,
  invalidatedAt: Date,
}, { timestamps: true });

adminActionTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'admin_action_token_expiry' });
adminActionTokenSchema.index({ activeTokenKey: 1 }, { unique: true, sparse: true, name: 'admin_action_token_active_unique' });
adminActionTokenSchema.index({ user: 1, type: 1, consumedAt: 1, invalidatedAt: 1 });

export const AdminActionToken = mongoose.model('AdminActionToken', adminActionTokenSchema);
