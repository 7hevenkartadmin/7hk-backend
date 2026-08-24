import { z } from 'zod';
import { parseStoreDate } from '../../shared/utils/storeDate.js';

const bannerSchema = z.object({
  title: z.string().max(140).default(''),
  highlight: z.string().max(80).default(''),
  copy: z.string().max(360).default(''),
  tag: z.string().max(80).default(''),
  image: z.string().url('Upload a valid banner image'),
  ctaLabel: z.string().max(40).default('Shop Now'),
  ctaHref: z.string().max(160).default('#products'),
  isActive: z.boolean().default(true),
  sortOrder: z.number().default(0),
});

const deliveryZoneSchema = z.object({
  code: z.string().trim().min(1).max(16).transform((value) => value.toUpperCase()),
  label: z.string().min(2).max(60),
  limit: z.number().min(0).max(100),
  charge: z.number().min(0).max(10000),
  orderCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('19:00'),
  isActive: z.boolean().default(true),
});
const deliveryZonesSchema = z.array(deliveryZoneSchema).max(12)
  .refine((zones) => new Set(zones.map((zone) => zone.code)).size === zones.length, 'Delivery-zone codes must be unique')
  .refine((zones) => new Set(zones.map((zone) => zone.limit)).size === zones.length, 'Delivery-zone distance limits must be unique');

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const hoursShape = {
  isOpen: z.boolean(),
  opensAt: timeSchema,
  closesAt: timeSchema,
};
const validHours = (schema) => schema.refine((value) => !value.isOpen || value.closesAt > value.opensAt, {
  message: 'Closing time must be after opening time', path: ['closesAt'],
});

const dailyScheduleSchema = validHours(z.object({ ...hoursShape, dayOfWeek: z.number().int().min(0).max(6) }));
const specialDateSchema = validHours(z.object({ ...hoursShape,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Boolean(parseStoreDate(value)), 'Special date must be a real calendar date'),
  reason: z.string().trim().max(160).default(''),
}));
const temporaryClosureSchema = z.object({
  isActive: z.boolean(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  reason: z.string().trim().max(160).default(''),
}).refine((value) => !value.isActive || Boolean(value.endsAt), {
  message: 'An end time is required for a temporary closure', path: ['endsAt'],
}).refine((value) => !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt), {
  message: 'Closure end must be after its start', path: ['endsAt'],
});

const orderingScheduleSchema = z.object({
  timezone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
  weeklySchedule: z.array(dailyScheduleSchema).length(7).refine(
    (days) => new Set(days.map((day) => day.dayOfWeek)).size === 7,
    'Weekly schedule must contain each day exactly once',
  ),
  specialDates: z.array(specialDateSchema).max(60).refine(
    (dates) => new Set(dates.map((date) => date.date)).size === dates.length,
    'Special dates must be unique',
  ).default([]),
  temporaryClosure: temporaryClosureSchema,
});

const codSettingsSchema = z.object({
  isEnabled: z.boolean().default(true),
  maxOrderValue: z.number().min(0).max(100000),
  maxPendingOrdersPerCustomer: z.number().int().min(0).max(20),
  maxCancelledOrdersInWindow: z.number().int().min(0).max(20),
  cancellationWindowDays: z.number().int().min(1).max(365),
  terms: z.string().min(10).max(1000),
});

export const storeSettingsSchema = z.object({
  homepageBanners: z.array(bannerSchema).max(10).optional(),
  deliveryZones: deliveryZonesSchema.optional(),
  codSettings: codSettingsSchema.optional(),
  orderingSchedule: orderingScheduleSchema.optional(),
}).refine((data) => data.homepageBanners || data.deliveryZones || data.codSettings || data.orderingSchedule, {
  message: 'At least one setting group is required',
});

export const availabilityQuerySchema = z.object({
  distanceKm: z.coerce.number().min(0).max(200).optional(),
});
