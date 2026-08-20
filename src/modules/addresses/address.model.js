import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  flatNumber: { type: String, trim: true, default: '' },
  landmark: { type: String, trim: true, default: '' },
  formattedAddress: { type: String, trim: true, default: '' },
  recipientName: { type: String, trim: true, required: true },
  phone: { type: String, trim: true, required: true, match: [/^(?:\+91)?[6-9][0-9]{9}$/, 'Enter a valid Indian phone number'] },
  line1: { type: String, trim: true, required: true },
  line2: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, required: true },
  state: { type: String, trim: true, default: 'Bihar' },
  pincode: { type: String, trim: true, required: true },
  latitude: { type: Number, min: -90, max: 90, required: true },
  longitude: { type: Number, min: -180, max: 180, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator(value) {
          return value.length === 2
            && value[0] >= -180
            && value[0] <= 180
            && value[1] >= -90
            && value[1] <= 90;
        },
        message: 'Invalid address coordinates',
      },
    },
  },
  distanceFromStoreKm: { type: Number, required: true },
  deliveryZone: { type: String, enum: ['A', 'B', 'C'], required: true },
  deliveryCharge: { type: Number, min: 0, required: true },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true });

addressSchema.index({ location: '2dsphere' });
addressSchema.index({ userId: 1, isDefault: -1, createdAt: 1 });

export const Address = mongoose.model('Address', addressSchema);
