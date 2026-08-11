import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  label: { type: String, enum: ['Home', 'Work', 'Hotel', 'Other'], default: 'Home' },
  flatNumber: { type: String, trim: true, required: true },
  landmark: { type: String, trim: true, default: '' },
  formattedAddress: { type: String, trim: true, required: true },
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
  deliveryCharge: { type: Number, required: true },
  isDefault: { type: Boolean, default: true },
}, { timestamps: true });

addressSchema.index({ location: '2dsphere' });

export const Address = mongoose.model('Address', addressSchema);
