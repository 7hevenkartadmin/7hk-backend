import mongoose from 'mongoose';

const deliverySlotSchema = new mongoose.Schema({
  date: { type: Date, required: true, index: true },
  startsAt: { type: String, required: true },
  endsAt: { type: String, required: true },
  capacity: { type: Number, min: 1, required: true },
  booked: { type: Number, min: 0, default: 0 },
  serviceArea: { type: String, trim: true, default: 'Patna' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

deliverySlotSchema.index({ date: 1, startsAt: 1, serviceArea: 1 }, { unique: true });

export const DeliverySlot = mongoose.model('DeliverySlot', deliverySlotSchema);
