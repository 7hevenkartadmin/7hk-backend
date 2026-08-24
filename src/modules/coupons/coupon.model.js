import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema({
  code: { type: String, trim: true, uppercase: true, unique: true, required: true },
  description: { type: String, trim: true, default: '' },
  image: { type: String, trim: true, required: true },
  type: { type: String, enum: ['flat', 'percentage'], required: true },
  value: { type: Number, min: 0, required: true },
  maxDiscount: { type: Number, min: 0, default: 0 },
  minOrderValue: { type: Number, min: 0, default: 0 },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  usageLimit: { type: Number, min: 0, default: 0 },
  usedCount: { type: Number, min: 0, default: 0 },
  reservedCount: { type: Number, min: 0, default: 0 },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

couponSchema.path('endsAt').validate(function (value) {
  return !this.startsAt || value > this.startsAt;
}, 'End date must be after start date');

couponSchema.path('value').validate(function (value) {
  return this.type !== 'percentage' || value <= 100;
}, 'Percentage discount cannot exceed 100');

export const Coupon = mongoose.model('Coupon', couponSchema);
