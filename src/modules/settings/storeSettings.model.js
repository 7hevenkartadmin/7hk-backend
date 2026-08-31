import mongoose from 'mongoose';

const bannerSchema = new mongoose.Schema({
  placement: { type: String, enum: ['hero', 'middle'], default: 'hero', index: true },
  displayStyle: { type: String, enum: ['content', 'image-only'], default: 'content' },
  theme: { type: String, enum: ['light', 'dark'], default: 'dark' },
  textPosition: { type: String, enum: ['left', 'center', 'right'], default: 'left' },
  imagePosition: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
  overlayOpacity: { type: Number, min: 0, max: 90, default: 55 },
  title: { type: String, trim: true, default: '' },
  highlight: { type: String, trim: true, default: '' },
  copy: { type: String, trim: true, default: '' },
  tag: { type: String, trim: true, default: '' },
  image: { type: String, trim: true, required: true },
  imagePublicId: { type: String, trim: true, default: '' },
  imageWidth: { type: Number, min: 0, default: 0 },
  imageHeight: { type: Number, min: 0, default: 0 },
  altText: { type: String, trim: true, default: '' },
  ctaLabel: { type: String, trim: true, default: 'Shop Now' },
  ctaHref: { type: String, trim: true, default: '#products' },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, min: 1, max: 100, default: 1 },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
}, { _id: true });

const bannerSectionSchema = new mongoose.Schema({
  isActive: { type: Boolean, default: true },
  eyebrow: { type: String, trim: true, default: '' },
  title: { type: String, trim: true, default: '' },
}, { _id: false });

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
  homepageBannerSections: {
    hero: { type: bannerSectionSchema, default: () => ({ isActive: true, title: 'Featured grocery collections' }) },
    middle: { type: bannerSectionSchema, default: () => ({ isActive: true, eyebrow: 'More for your home', title: 'Everyday essentials' }) },
  },
  deliveryZones: [deliveryZoneSchema],
  codSettings: codSettingsSchema,
  orderingSchedule: orderingScheduleSchema,
}, { timestamps: true });

export const StoreSettings = mongoose.model('StoreSettings', storeSettingsSchema);
