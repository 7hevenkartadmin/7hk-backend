import mongoose from 'mongoose';

const bannerSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true },
  highlight: { type: String, trim: true, default: '' },
  copy: { type: String, trim: true, default: '' },
  tag: { type: String, trim: true, default: '' },
  image: { type: String, trim: true, default: '' },
  ctaLabel: { type: String, trim: true, default: 'Shop Now' },
  ctaHref: { type: String, trim: true, default: '#products' },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { _id: true });

const deliveryZoneSchema = new mongoose.Schema({
  code: { type: String, trim: true, required: true },
  label: { type: String, trim: true, required: true },
  limit: { type: Number, min: 0, required: true },
  charge: { type: Number, min: 0, required: true },
  isActive: { type: Boolean, default: true },
}, { _id: true });

const codSettingsSchema = new mongoose.Schema({
  isEnabled: { type: Boolean, default: true },
  maxOrderValue: { type: Number, min: 0, default: 1500 },
  maxPendingOrdersPerCustomer: { type: Number, min: 0, default: 2 },
  maxCancelledOrdersInWindow: { type: Number, min: 0, default: 2 },
  cancellationWindowDays: { type: Number, min: 1, default: 30 },
  terms: { type: String, trim: true, default: '' },
}, { _id: false });

const storeSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'storefront', unique: true, index: true },
  homepageBanners: [bannerSchema],
  deliveryZones: [deliveryZoneSchema],
  codSettings: codSettingsSchema,
}, { timestamps: true });

export const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);
