import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const addressSchema = new mongoose.Schema({
  label: { type: String, trim: true, default: 'Home' },
  flatNumber: { type: String, trim: true, default: '' },
  formattedAddress: { type: String, trim: true, default: '' },
  recipientName: { type: String, trim: true, required: true },
  phone: { type: String, trim: true, required: true },
  line1: { type: String, trim: true, required: true },
  line2: { type: String, trim: true, default: '' },
  landmark: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, required: true },
  state: { type: String, trim: true, default: 'Bihar' },
  pincode: { type: String, trim: true, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  distanceFromStoreKm: { type: Number, required: true },
  isDefault: { type: Boolean, default: false },
}, { _id: true, timestamps: true });

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phone: { type: String, trim: true, unique: true, required: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'admin', 'manager', 'support'], default: 'customer', index: true },
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  addresses: [addressSchema],
  refreshTokenHash: { type: String, select: false },
  lastLoginAt: Date,
}, { timestamps: true });

userSchema.methods.comparePassword = function comparePassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(password) {
  return bcrypt.hash(password, 12);
};

export const User = mongoose.model('User', userSchema);
