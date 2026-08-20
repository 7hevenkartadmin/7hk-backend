import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const INDIAN_PHONE_PATTERN = /^(?:\+91)?[6-9][0-9]{9}$/;

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phone: {
    type: String,
    trim: true,
    unique: true,
    required: [function phoneRequiredForCustomer() { return this.role === 'customer'; }, 'Phone number is required for customers'],
    validate: {
      validator(value) {
        return this.role !== 'customer' || INDIAN_PHONE_PATTERN.test(value || '');
      },
      message: 'Enter a valid Indian phone number',
    },
  },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'admin', 'manager', 'support'], default: 'customer', index: true },
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  addresses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Address' }],
  refreshTokenHash: { type: String, select: false },
  tokenVersion: { type: Number, default: 0, min: 0 },
  lastLoginAt: Date,
}, { timestamps: true });

userSchema.methods.comparePassword = function comparePassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(password) {
  return bcrypt.hash(password, 12);
};

export const User = mongoose.model('User', userSchema);
