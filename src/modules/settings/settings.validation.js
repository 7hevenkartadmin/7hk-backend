import { z } from 'zod';

const bannerSchema = z.object({
  title: z.string().min(2).max(140),
  highlight: z.string().max(80).default(''),
  copy: z.string().max(360).default(''),
  tag: z.string().max(80).default(''),
  image: z.string().url().optional().or(z.literal('')).default(''),
  ctaLabel: z.string().max(40).default('Shop Now'),
  ctaHref: z.string().max(160).default('#products'),
  isActive: z.boolean().default(true),
  sortOrder: z.number().default(0),
});

const deliveryZoneSchema = z.object({
  code: z.string().min(1).max(16),
  label: z.string().min(2).max(60),
  limit: z.number().min(0).max(100),
  charge: z.number().min(0).max(10000),
  isActive: z.boolean().default(true),
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
  deliveryZones: z.array(deliveryZoneSchema).max(12).optional(),
  codSettings: codSettingsSchema.optional(),
}).refine((data) => data.homepageBanners || data.deliveryZones || data.codSettings, {
  message: 'At least one setting group is required',
});
