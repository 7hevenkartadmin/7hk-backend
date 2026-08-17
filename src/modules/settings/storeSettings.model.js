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
  orderCutoff: { type: String, default: '19:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  isActive: { type: Boolean, default: true },
}, { _id: true });

const dailyScheduleSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, min: 0, max: 6, required: true },
  isOpen: { type: Boolean, default: true },
  opensAt: { type: String, default: '09:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  closesAt: { type: String, default: '20:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
}, { _id: false });

const specialDateSchema = new mongoose.Schema({
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  isOpen: { type: Boolean, default: false },
  opensAt: { type: String, default: '09:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  closesAt: { type: String, default: '20:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  reason: { type: String, trim: true, default: '' },
}, { _id: false });

const temporaryClosureSchema = new mongoose.Schema({
  isActive: { type: Boolean, default: false },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  reason: { type: String, trim: true, default: '' },
}, { _id: false });

const orderingScheduleSchema = new mongoose.Schema({
  timezone: { type: String, enum: ['Asia/Kolkata'], default: 'Asia/Kolkata' },
  weeklySchedule: { type: [dailyScheduleSchema], default: [] },
  specialDates: { type: [specialDateSchema], default: [] },
  temporaryClosure: { type: temporaryClosureSchema, default: () => ({}) },
}, { _id: false });

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
  orderingSchedule: orderingScheduleSchema,
}, { timestamps: true });

export const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);
